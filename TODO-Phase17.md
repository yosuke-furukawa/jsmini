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

### 17-1: IR に型フィードバックを注入

SSA Builder で bytecode → IR 変換時に、型フィードバックを参照して IR の型情報を付ける。

- [ ] 17-1a: `buildIR()` に `FeedbackCollector` をオプション引数で渡す
- [ ] 17-1b: パラメータの型を feedback の argTypes から設定
  - `Param(0)` の type を `"any"` → `"i32"` or `"f64"` に
- [ ] 17-1c: 算術命令の型を引数の型から伝播
  - `Add(i32, i32)` → type: `"i32"`
  - `Add(f64, f64)` → type: `"f64"`
  - `Add(i32, f64)` → type: `"f64"` (widening)
- [ ] 17-1d: テスト

### 17-2: TypeGuard ノード

型の仮定が外れた場合に deoptimize するためのガード命令。

- [ ] 17-2a: `TypeGuard` opcode を IR に追加
  - `TypeGuard(value, expectedType)` — value の型が expectedType でなければ deopt
- [ ] 17-2b: SSA Builder でパラメータに TypeGuard を挿入
  - feedback が `i32` → `TypeGuard(param, "i32")` を挿入
- [ ] 17-2c: TypeGuard の後の演算は型が確定 → 型特殊化された opcode を使える
- [ ] 17-2d: テスト

### 17-3: IR codegen の型対応

- [ ] 17-3a: `Add(i32, i32)` → `i32.add`、`Add(f64, f64)` → `f64.add` の切り替え
- [ ] 17-3b: `f64` パラメータ → Wasm の `f64` local
- [ ] 17-3c: i32 → f64 の変換 (f64.convert_i32_s) を必要な箇所に挿入
- [ ] 17-3d: テスト + ベンチマーク

### 17-4: Deoptimization

TypeGuard が失敗したとき、Wasm から bytecode VM にフォールバックする。

- [ ] 17-4a: TypeGuard 失敗時の deopt パス
  - Wasm から trap or return で脱出
  - JitManager が deoptimized set に関数を追加
  - 次回以降は bytecode VM で実行
- [ ] 17-4b: deopt テスト: 最初は i32 で JIT → 途中で f64 が来る → deopt → VM で正しく実行
- [ ] 17-4c: `--trace-tier` で deopt が見えることを確認

## 目標

- IR JIT が f64 の関数にも対応
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
