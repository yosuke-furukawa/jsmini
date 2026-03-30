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

- [x] `addStruct(fields)` — Type section に struct 型を追加
- [x] Type section: struct 型が先、func 型が後 (type index オフセット)
- [x] `WASM_GC_OP`: struct_new (0xfb 0x00), struct_get (0xfb 0x02), struct_set (0xfb 0x05)
- [x] `refType(typeIdx)` — ref 型のバイト列生成 (0x64 + type index)
- [x] `addFunction` に paramCount/resultCount を追加 (ref 型は複数バイトなので)
- [x] テスト: `dot(Vec(3,4), Vec(1,1)) = 7` via WasmBuilder + Wasm GC

---

## 10E-2. Vec class を Wasm GC で JIT

- [x] `compileWithWasmGC()` — Wasm GC ベースの JIT コンパイラ
- [x] プロパティ → struct フィールドに変換 (propIndex)
- [x] `__create` 関数の自動生成 (struct.new のラッパー、constructor 代替)
- [x] `GetProperty` → `struct.get`
- [x] `SetPropertyAssign` → `struct.set` (temp local でスワップ)
- [x] `Construct` → `call __create` (constructor の名前を __create にリダイレクト)
- [x] dot: struct.get × 4 + i32.mul × 2 + i32.add → 7 ✓
- [x] add: struct.get × 4 + i32.add × 2 + call __create → (4,6) ✓
- [x] 到達不能コード (LdaUndefined + Return) → `unreachable`

---

## 10E-3. bump allocator → Wasm GC への移行

- [x] メモリリーク解消: struct.new で V8 GC が自動回収
- [x] ヒープリセット不要 (heapPtr global 不要)
- [x] 1000 iter の add+dot: 0.35ms、メモリリークなし
- [x] bump allocator の 64KB 制限なし (V8 GC ヒープを使用)

---

## 10E-4. 文字列の Wasm 化 (flatten アプローチ)

**方針**: ConsString を Wasm に持ち込むのではなく、Wasm に渡す直前に flatten。
Wasm 内では常にフラットなバイト配列として扱う。

**JIT 可能なケース** (文字列を参照のみ):
```js
// intern 済み文字列の比較ループ → intern id (i32) で Wasm 化
function strcmp(a, b) { if (a === b) { return 0; } return 1; }
// → TW 70.8ms / VM 76.3ms / VM+JIT 66.2ms (1.1x vs TW — JIT で TW に勝つ)
```

**JIT 不可なケース** (ループ内で連結):
```js
// 文字列がループ内で成長 → Wasm 化不可 (VM のまま)
var s = ""; for (var i = 0; i < 1000; i++) { s = s + "x"; }
// → TW 2.5ms / VM 4.0ms (JIT 不可、変化なし)
```

**手書き Wasm で検証済み**:
- [x] linear memory + `i32.load8_u` で文字列バイト比較を Wasm 化
- [x] strcmp(a, a_len, b, b_len): 長さ比較 → バイトループ比較
- [x] ベンチ: Wasm strcmp 100K 回 = 2.05ms (VM の `===` 100K 回 = ~730ms、**350 倍速い**)
- [x] JitManager への自動組み込み: intern id (i32) で文字列引数を Wasm に渡す
  - interned_string → i32 (intern id)、StrictEqual → i32.eq
  - strcmp("hello","hello") x10K: TW 71ms / VM+JIT 66ms (自動 JIT)
  - 487 テストパス (deopt テスト含む)

---

## 10E-5. クロージャを Wasm GC で JIT

- [x] クロージャの環境を Wasm GC struct で表現
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
- [ ] バイトコード解析: どの変数がキャプチャされるか自動検出 (手動は検証済み)
- [x] テスト: `makeAdder(5)(10)` = 15 — 手書き Wasm GC で動作確認
- [x] テスト: 複数変数キャプチャ `f(x) = 3x + 7` — struct { a, b } で動作確認
- [x] テスト: 10 万個のクロージャ生成 → OOM しない (V8 GC が Env struct を回収)
- [x] ベンチ: apply × 100K = 2.93ms
- [ ] wasm-gc-compiler への自動組み込み (VM にクロージャ機構がないため未実装)
  - VM が外側関数のローカル変数を参照できないのが前提の障壁
  - 手書き Wasm GC では動作確認済み (makeAdder, multi-var capture)

---

## 10E-6. ベンチマーク + ドキュメント

- [x] Vec class 比較:
  ```
  Vec add+dot (1000 iter), V8-JITless:
    TW:          11ms
    VM:          24ms
    Wasm GC:     0.069ms (158x vs TW)
    Phase 8E:    ~0.045ms (linear memory, メモリリークあり)
  ```
  Wasm GC は Phase 8E より少し遅い (struct.new/struct.get のオーバーヘッド) が
  メモリリークなし + ヒープリセット不要
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
