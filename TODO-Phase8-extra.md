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

- [ ] WasmBuilder に global 変数サポート追加 (bump allocator 用の heap pointer)
- [ ] `Construct` → Wasm 内で bump allocate + constructor 呼び出し
  - heap pointer を進めて新オブジェクトの base address を確保
  - `call $constructor(base, arg0, arg1)` で初期化
  - base address を返す
- [ ] テスト: `new Vec(1, 2)` が Wasm memory 上に正しく配置される

---

## 8E-3. add メソッドの Wasm 化

- [ ] add 内の `Construct` → bump allocate + `call $Vec`
- [ ] add 全体: GetProperty × 4 + Add × 2 + Construct → Wasm
- [ ] テスト: `Vec(1,2).add(Vec(3,4))` の結果が `(4, 6)`

---

## 8E-4. ベンチマーク + playground + ドキュメント

- [ ] Vec dot ベンチ: TW / VM / Wasm の 3 層比較
- [ ] playground リビルド: WAT 表示確認
- [ ] BENCHMARK.md 更新
- [ ] TODO チェック

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
