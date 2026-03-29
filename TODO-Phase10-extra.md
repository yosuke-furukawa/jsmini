# TODO — Phase 10+: Wasm GC 連携

## 狙い

Phase 10 で自前の Mark-and-Sweep GC を実装して「GC とは何か」を理解した。
Phase 10+ では **Wasm GC を使って JIT の対象を拡大** する。

### 今の JIT の限界

Phase 8E で Wasm JIT を拡張したが、以下は JIT 対象外:

| パターン | 理由 |
|---------|------|
| 文字列操作 | Wasm linear memory に文字列を置けない (可変長 + GC 必要) |
| クロージャ | 環境のキャプチャができない (ref 型がない) |
| 動的オブジェクト生成 | bump allocator で解放不可 (Phase 8E の制限) |
| prototype チェーン | 参照の追跡ができない |

### Wasm GC があると何が変わるか

Node.js v24 で Wasm GC がデフォルト有効 (確認済み)。

- **`struct` 型** — GC 管理のオブジェクト。Vec を `struct { x: i32, y: i32 }` で表現
- **`array` 型** — GC 管理の配列。JSArray を Wasm array で表現
- **`ref` 型** — GC が追跡する参照。prototype や ConsString の left/right
- **自動メモリ管理** — `struct.new` で生成、不要になったら V8 の GC が回収

### Phase 8E (linear memory) との比較

```
Phase 8E:
  new Vec(x, y)  → bump allocator (解放不可、メモリリーク)
  obj.x          → i32.load(base + 0) (手動オフセット計算)
  GC             → 自前 or なし

Phase 10+:
  new Vec(x, y)  → struct.new $Vec (V8 GC が自動管理)
  obj.x          → struct.get $Vec $x (型安全)
  GC             → V8 の Wasm GC ランタイムに委譲
```

---

## 10E-0. Wasm GC のバイナリエンコーディング調査

- [x] Wasm GC の struct/ref 型のバイナリフォーマットを調査
  - struct 型: `0x5f` + field count + (valtype + mutability) × N
  - `struct.new`: `0xfb 0x00` + type index
  - `struct.get`: `0xfb 0x02` + type index + field index
  - `struct.set`: `0xfb 0x05` + type index + field index
  - `ref` 型: `0x64` + heap type (non-null), `0x63` + heap type (nullable)
- [x] Node.js v24 で手書き Wasm GC バイナリが動くことを確認
- [x] `Vec { x: i32, y: i32 }`: struct.new で生成、struct.get で読む
  - `dot(Vec(3,4), Vec(1,1)) = 7` ✓
- [x] GC 自動回収確認: 100 万個の struct.new → メモリリークなし

---

## 10E-1. WasmBuilder に Wasm GC サポート追加

- [ ] Type section で `struct` 型を定義
- [ ] `struct.new`, `struct.get`, `struct.set` オペコード追加
- [ ] `ref` 型 (nullable/non-nullable) のエンコーディング
- [ ] テスト: Vec struct を生成して x, y を読む

---

## 10E-2. Vec class を Wasm GC で JIT

- [ ] Vec の Hidden Class → Wasm GC struct 型に変換
  - HC のプロパティ `{ x: offset 0, y: offset 1 }` → `struct { x: i32, y: i32 }`
- [ ] `Construct` → `struct.new` (bump allocator 不要)
- [ ] `GetProperty` → `struct.get`
- [ ] `SetPropertyAssign` → `struct.set`
- [ ] dot メソッド: struct.get × 4 + i32.mul × 2 + i32.add
- [ ] add メソッド: struct.get × 4 + i32.add × 2 + struct.new
- [ ] テスト: Vec dot/add が Wasm GC で正しく動く

---

## 10E-3. bump allocator → Wasm GC への移行

- [ ] Phase 8E の linear memory + bump allocator を Wasm GC struct に置き換え
- [ ] メモリリーク問題の解消: struct.new で生成したオブジェクトは V8 GC が自動回収
- [ ] ヒープリセット (heapPtr global) が不要に
- [ ] テスト: ループ内の大量オブジェクト生成で OOM しないことを確認

---

## 10E-4. ConsString を Wasm GC で表現

- [ ] ConsString → Wasm GC struct
  ```wasm
  (type $SeqString (struct (field $data (ref $i8array)) (field $length i32)))
  (type $ConsString (struct (field $left (ref $String)) (field $right (ref $String)) (field $length i32)))
  ```
- [ ] 文字列連結: struct.new $ConsString
- [ ] flatten: Wasm 内で ConsString を SeqString に変換
- [ ] テスト: 文字列操作が Wasm GC で動く

---

## 10E-5. クロージャを Wasm GC で JIT

- [ ] クロージャの環境を Wasm GC struct で表現
  ```wasm
  ;; function makeAdder(n) { return function(x) { return x + n; }; }
  (type $Env (struct (field $n i32)))
  (func $inner (param $env (ref $Env)) (param $x i32) (result i32)
    local.get $x
    struct.get $Env $n (local.get $env)
    i32.add
  )
  ```
- [ ] 環境のキャプチャ: 外側の関数のローカル変数を struct にまとめる
  - `makeAdder(5)` → `struct.new $Env (i32.const 5)` → ref を返す
  - `add5(10)` → `$inner($env, 10)` → env から n を struct.get
- [ ] バイトコード解析: どの変数がキャプチャされるか検出
  - 内側関数の `LdaGlobal` が外側関数のローカル変数を参照 → キャプチャ対象
- [ ] テスト: `makeAdder(5)(10)` = 15 が Wasm GC で動く
- [ ] テスト: `forEach(arr, function(x) { sum = sum + x; })` のコールバッククロージャ

---

## 10E-6. ベンチマーク + ドキュメント

- [ ] Vec class: Phase 8E (linear memory) vs Phase 10+ (Wasm GC) の比較
- [ ] メモリ使用量の比較: bump allocator vs Wasm GC
- [ ] 文字列操作の JIT ベンチ (Phase 9 の JSString → Wasm GC)
- [ ] クロージャの JIT ベンチ (makeAdder, forEach + callback)
- [ ] `LEARN-WasmGC.md` 作成
- [ ] `BENCHMARK.md` 更新

---

## 実装フロー

```
10E-0: Wasm GC バイナリ調査 + 手書き確認
  ↓
10E-1: WasmBuilder に struct/ref サポート
  ↓
10E-2: Vec class を Wasm GC で JIT
  ↓
10E-3: bump allocator → Wasm GC に移行
  ↓
10E-4: ConsString を Wasm GC で表現 (文字列 JIT)
  ↓
10E-5: クロージャを Wasm GC で JIT (環境キャプチャ)
  ↓
10E-6: ベンチ + docs
```

10E-0 が最重要。Wasm GC のバイナリフォーマットが複雑なので、
手書きで動く最小例を作ることから始める。

---

## 期待される効果

### Phase 8E (現状)
```
Vec dot+add (1000 iter):
  TW:        10ms
  Wasm:      0.045ms (222x)
  ただし bump allocator でメモリリーク
  ヒープリセットが必要
```

### Phase 10+ (Wasm GC)
```
Vec dot+add (1000 iter):
  Wasm GC:   ~0.05ms (推定、Phase 8E と同等)
  メモリリーク解消 (V8 GC が自動回収)
  ヒープリセット不要
  文字列操作も JIT 対象
```

速度は Phase 8E と同等だが、**メモリ管理が正しくなる** のが最大のメリット。
さらに文字列やクロージャが JIT 対象になることで、
**jsmini の JIT がカバーするプログラムの範囲が大幅に広がる**。

---

## 難しいポイント

### Wasm GC のバイナリフォーマット

Wasm GC は Wasm MVP の type section を大幅に拡張している。
struct 型、array 型、ref 型のエンコーディングが複雑。
手書きでバイナリを組み立てるのは難易度が高い。

### V8 の Wasm GC と jsmini の自前 GC の共存

Phase 10 の自前 GC は jsmini のヒープオブジェクトを管理する。
Phase 10+ の Wasm GC は Wasm 内のオブジェクトを V8 が管理する。
JIT 対象の関数は Wasm GC、それ以外は自前 GC。2 つの GC が共存する。

### ref 型の扱い

Wasm GC の ref 型は V8 のヒープ上のオブジェクトを指す。
JS から ref を受け取ったり、ref を JS に返したりする際の変換が必要。
