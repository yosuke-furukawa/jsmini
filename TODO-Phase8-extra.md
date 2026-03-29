# TODO — Phase 8+: オブジェクト JIT (HC + IC → Wasm)

HC + IC の情報を使って Wasm コンパイラがオブジェクトアクセスを自動変換する。

**ゴール**: Vec class の dot/constructor が Wasm JIT で動き、TW の 100 倍以上速くなる。

---

## 8E-0. PLAN-v2 に Phase 8+ の実測結果を反映

- [x] PLAN-v2.md に Phase 7-8 の実測結果と Phase 8+ の位置づけを記載

---

## 8E-1. Wasm コンパイラ — GetProperty / SetPropertyAssign / LoadThis

- [x] `LoadThis` → `local.get(paramCount)` (this を追加パラメータとして渡す)
- [x] `GetProperty "x"` → `i32.load(base + propOffset * 4)` (HC の offset を使用)
- [x] `SetPropertyAssign "x"` → `i32.store(base + propOffset * 4, value)`
- [x] memory 自動有効化 (LoadThis/SetPropertyAssign がある関数)
- [x] テスト: `dot(Vec(3,4), Vec(1,1)) = 7` が Wasm memory 経由で動く

---

## 8E-2. Construct (new) の Wasm 化

- [x] WasmBuilder に global 変数サポート追加 (Global section, global.get/set)
- [x] `Construct` → Wasm 内で bump allocate + constructor 呼び出し
  - heap pointer (global) を進めて新オブジェクトの base address を確保
  - `call $constructor(arg0, arg1, base)` で初期化
  - base address を返す
- [x] `LdaGlobal` が Construct の前でも skip されるように修正
- [x] テスト: `new Vec(1, 2)` が Wasm memory 上に正しく配置される

---

## 8E-3. add メソッドの Wasm 化

- [x] add 内の `Construct` → bump allocate + `call $Vec`
- [x] add 全体: GetProperty × 4 + Add × 2 + Construct → Wasm
- [x] WAT 表示: Vec, add, dot 全て OK
- [x] テスト: `Vec(1,2).add(Vec(3,4))` の結果が `(4, 6)`

---

## 8E-4. ベンチマーク + playground + ドキュメント

- [x] Vec add+dot ベンチ: TW 10.0ms / VM 22.4ms / Wasm 0.045ms (222x vs TW)
- [x] Global export でヒープポインタをリセット可能に
- [x] playground リビルド
- [x] TODO チェック

---

## 8E-5. コールバック関数のインライン化

map/reduce のコールバック (`fn(arr[i])`, `fn(acc, arr[i])`) を Wasm 内にインライン展開する。

- [x] `LdaLocal N + Call` パターンで inlineCandidates から paramCount 一致する関数を展開
- [x] インライン展開の仕組み:
  1. Call の引数 N 個をスタックから extra local に退避 (`local.set`)
  2. コールバックの本体内 `LdaLocal K` → `local.get (baseLocal + K)` に置換
  3. `Return` → break (値をスタックに残す)
- [x] `CreateArray 0` → bump allocate で配列領域を確保 (length ヘッダ + 1024 要素分)
- [x] テスト: `map([10,20,30], double)` → `[20,40,60]` via Wasm
- [x] テスト: `reduce([1,2,3,4], add, 0)` → `10` via Wasm
- [x] ベンチマーク: reduce(500, add, 0) — TW 3.9ms / VM 5.2ms / Wasm 0.011ms (364x)

---

## 実装フロー

```
8E-0: PLAN-v2 更新
  ↓
8E-1: GetProperty/SetPropertyAssign/LoadThis → i32.load/store
  ↓
8E-2: Construct (new) → bump allocator
  ↓
8E-3: add メソッド全体の Wasm 化
  ↓
8E-4: ベンチ + docs
```
