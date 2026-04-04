# TODO Phase 17 — Type Specialization in IR

## 動機

Phase 16 で IR (CFG + SSA) を導入し、Constant Folding + DCE で 1.6-1.9x の効果を確認した。
次のステップは **型フィードバックを IR レベルで活用** すること。

現在の JIT (Phase 5) は bytecode → Wasm 変換時に型フィードバックで型特殊化しているが、
IR を経由する場合は IR のレベルで型情報を活用する必要がある。

```
今の IR:
  v2 = Add(v0, v1)         // type: "any" — 実行時に型チェック

Type Specialization 後:
  v3 = TypeGuard(v0, "i32") // v0 が i32 でなければ deopt
  v4 = TypeGuard(v1, "i32")
  v2 = I32Add(v3, v4)       // i32 専用の加算 (型チェック不要)
```

V8 の Maglev/TurboFan、JSC の DFG、SpiderMonkey の Warp が全てやっていること。
jsmini では既に型フィードバック (feedback.ts) があるので、これを IR に接続する。

## 現状

```
Phase 5:  bytecode → wasm-compiler.ts → Wasm (型フィードバックで i32/f64 選択)
Phase 16: bytecode → IR (SSA) → optimize → codegen.ts → Wasm (型情報なし、全部 i32 扱い)
```

IR パスでは型フィードバックを無視しており、`Add(any, any)` を常に `i32.add` に変換している。
これは型が合ってる場合は動くが、f64 が来たら壊れる。

## ステップ

### 17-1: IR に型フィードバックを注入 ✅

- [x] 17-1a: `buildIR()` に `FeedbackCollector` をオプション引数で渡す
- [x] 17-1b: パラメータの型を feedback の argTypes から設定
- [x] 17-1c: 算術命令の型を引数の型から伝播 (inferBinType: f64 widening)
- [x] 17-1d: 既存テスト全パス

### 17-2: TypeGuard ノード ✅

- [x] 17-2a: `TypeGuard` opcode を IR に追加 (guardType フィールド)
- [x] 17-2b: SSA Builder でパラメータに TypeGuard を挿入
- [x] 17-2c: Printer で TypeGuard 表示対応
- [x] 17-2d: Codegen で passthrough (deopt は JitManager 側で処理)

### 17-3: IR codegen の型対応 ✅

- [x] 17-3a: `Add(f64, f64)` → `f64.add` 等の切り替え (getWasmBinOp 既存対応)
- [x] 17-3b: パラメータ/戻り値の型を IR から取得 (getParamTypes, getReturnType)
- [x] 17-3c: f64 比較 (f64.lt, f64.le 等)、f64 negate (f64.neg)
- [x] 17-3d: 既存テスト全パス

### 17-4: Deoptimization ✅

- [x] 17-4a: 既存の JitManager.executeWasm() が型チェック + deopt を処理
  - IR パスで生成された CachedWasm も同じ経路で実行
- [x] 17-4b: deopt テスト: i32 で JIT → string が来る → deopt → VM で "ab" 正しく出力
- [x] 17-4c: `--trace-tier` で deopt が見える

## 目標

- IR パスが f64 にも対応 (direct JIT は既に対応済み、IR パスが i32 固定なのを修正)
- 型ガードによる安全な型特殊化
- deopt が正しく動く (JIT → VM フォールバック)
- `--jit --ir` のベンチマークが `--jit` (direct) と同等以上

## 技術メモ

### V8 の型スペキュレーション

V8 の Maglev は bytecode の inline cache (feedback vector) から型情報を取得し、
CheckInt32, CheckFloat64 などのガードノードを挿入。ガード失敗時は eager deoptimization
で Ignition (bytecode) に戻る。

### JSC の SpecType

JSC の DFG は SpecType (ビットマスク) で型を表現。
`SpecInt32Only | SpecBoolInt32` のように複数の型を OR で表現できる。
フォワードデータフロー解析で型を伝播し、speculation check を挿入。

### jsmini の型フィードバック

既存の `feedback.ts` が以下を収集:
- `argTypes`: 各引数の型 ("int32", "uint32", "f64", "string", "object", ...)
- `isMonomorphic`: 常に同じ型パターンかどうか
- `callCount`: 呼び出し回数

これを IR Builder に渡せば、V8/JSC と同じ型スペキュレーションが可能。

### Wasm での deopt

Wasm には「途中で脱出して JS に戻る」仕組みとして:
1. `return` で特殊な値を返す (deopt marker)
2. trap (unreachable) で例外を投げる
3. 関数の戻り値で deopt かどうかを判定

jsmini は (1) の方式を既に使っている (Phase 5 の deoptimization)。
IR パスでも同じ仕組みを使えば良い。
