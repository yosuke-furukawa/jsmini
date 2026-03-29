# TODO — Phase 8+: オブジェクト JIT (HC + IC → Wasm)

Phase 8 で Hidden Class + Inline Cache を実装した。
VM レベルでは効果がなかったが、手書き Wasm で 3014x の高速化を確認済み。

このタスクは HC + IC の情報を使って **Wasm コンパイラがオブジェクトアクセスを自動変換** するもの。

**ゴール**: Vec class ベンチが自動的に Wasm JIT で動き、TW の 1000 倍以上速くなる。

---

## 前提: 手書き Wasm で確認済みの結果

```
Vec class (1000 iter), V8-JITless:
  TW:        10.4ms
  VM+HC+IC:  23.1ms  (0.45x)
  手書きWasm: 0.004ms (3014x)
```

手書き Wasm のアプローチ:
- Vec = `[x: i32, y: i32]` = 8 bytes を linear memory に配置
- `obj.x` → `i32.load(base + 0)` (HC で offset=0 が判明)
- `obj.y` → `i32.load(base + 4)` (HC で offset=1 → 1*4=4)
- add/dot/ループ全体を 1 つの Wasm モジュールに

---

## 8E-0. オブジェクトのメモリレイアウト設計

- [ ] HC のプロパティ数からオブジェクトサイズを計算
  - Vec: `{ x, y }` → 2 プロパティ → 8 bytes (i32 × 2)
  - オブジェクトサイズ = HC.properties.size × 4 bytes (i32)
- [ ] メモリレイアウト: `[prop0: i32][prop1: i32]...`
  - HC の offset がそのままメモリオフセットに対応
  - `obj.x` → `i32.load(base + lookupOffset(hc, "x") * 4)`
- [ ] 複数オブジェクトの配置: bump allocator
  - 各オブジェクトの base address を管理
  - `new Vec(1, 2)` → memory の次の空き位置に 8 bytes 確保

---

## 8E-1. バイトコード静的解析 — オブジェクトローカルの特定

- [ ] `detectObjectLocals(func)` — GetProperty/SetPropertyAssign のオブジェクト位置を検出
  ```
  パターン: LoadThis → GetProperty "x"    → this はオブジェクト
  パターン: LdaLocal N → GetProperty "x"  → local N はオブジェクト
  ```
- [ ] IC の monomorphic 情報から HC を特定
  - 「この GetProperty は常に HC_A (offset 0)」→ i32.load に変換可能
- [ ] テスト: Vec の constructor, add, dot で正しく検出

---

## 8E-2. Wasm コンパイラ — GetProperty / SetPropertyAssign の変換

- [x] monomorphic IC + JSObject の GetProperty:
  ```
  LoadThis / LdaLocal       → local.get (base address)
  GetProperty "x" (offset=0) → i32.const 0 / i32.add / i32.load
  ```
- [ ] SetPropertyAssign (constructor の `this.x = value`):
  ```
  value                      → (スタック上)
  LoadThis                   → local.get (base address)
  SetPropertyAssign "x" (0)  → i32.const 0 / i32.add / i32.store
  ```
- [ ] prototype 経由のメソッド呼び出しは未対応 (フォールバック)
- [ ] テスト: Vec constructor が Wasm にコンパイルできること

---

## 8E-3. Construct の Wasm 化

- [ ] `new Vec(i, i*2)` を Wasm 内で実行:
  1. bump allocator で 8 bytes 確保 (次の空きアドレス)
  2. constructor の Wasm 関数を call (base, x, y)
  3. base address を返す
- [ ] bump allocator のポインタを Wasm global 変数で管理
- [ ] テスト: `new Vec(1, 2)` が memory に正しく配置される

---

## 8E-4. Vec ベンチ全体の Wasm 化

- [ ] Vec.constructor, Vec.add, Vec.dot, ループを 1 つの Wasm モジュールに
- [ ] add: `call $constructor` (新オブジェクト生成) + プロパティ計算
- [ ] dot: GetProperty × 4 + Mul × 2 + Add
- [ ] ループ: block/loop/br パターン (Phase 6 と同じ)
- [ ] テスト: 結果が TW / VM と一致 (1498500)
- [ ] ベンチマーク: TW / VM / Wasm JIT の 3 層比較

---

## 8E-5. JitManager の自動コンパイル

- [ ] 型フィードバック: `this` が monomorphic JSObject と判定
- [ ] `compileMultiSync` でオブジェクト引数を検出
- [ ] 呼び出しラッパー: JSObject ↔ Wasm memory のコピー
  - 入: JSObject の slots → memory に書き込み
  - 出: memory → JSObject の slots に書き戻し
- [ ] テスト: VM の Call から自動的に Wasm JIT 実行

---

## 実装フロー

```
8E-0: メモリレイアウト設計
  ↓
8E-1: 静的解析 (オブジェクトローカル検出)
  ↓
8E-2: GetProperty/SetPropertyAssign → i32.load/i32.store
  ↓
8E-3: Construct (new) の Wasm 化
  ↓
8E-4: Vec ベンチ全体の Wasm 化 ← ゴール
  ↓
8E-5: JitManager の自動コンパイル
```

8E-0〜8E-2 は Phase 6 の配列 JIT と同じ構造 (メモリレイアウト + 静的解析 + Wasm 変換)。
8E-3 が新しい要素 (Wasm 内でのオブジェクト生成)。

---

## 難しいポイント

### prototype 経由のメソッド呼び出し

`sum.add(v)` は:
1. `sum` の HC で `add` を探す → 見つからない
2. `sum.__proto__` の HC で `add` を探す → offset N → prototype.slots[N] が関数

Wasm 内でこれを解決するには:
- prototype のメソッドも Wasm 関数としてコンパイル済み
- `call $add` で Wasm 内の関数を呼ぶ (prototype の解決は不要)
- **IC が monomorphic** なら「常に同じメソッド」なので、直接 `call $add` に変換できる

### this の扱い

Wasm 関数の引数に `this_base` (メモリ上のアドレス) を渡す:
```wasm
(func $add (param $this_base i32) (param $other_base i32) (result i32)
  ;; new Vec の base address を返す
)
```

### new によるオブジェクト生成

ループ内で `new Vec(i, i*2)` を 1000 回呼ぶ。
Wasm 内で bump allocator を使って memory 上にオブジェクトを配置:
```wasm
(global $heap_ptr (mut i32) (i32.const 0))

(func $alloc (param $size i32) (result i32)
  global.get $heap_ptr
  global.get $heap_ptr
  local.get $size
  i32.add
  global.set $heap_ptr
)
```
