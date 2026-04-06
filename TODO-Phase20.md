# TODO Phase 20 — Range Analysis + Overflow Safety + 配列 IR 対応

## 動機

### 1. i32 overflow で結果が壊れる

jsmini の IR JIT は全演算を i32 で行うが、i32 overflow 時に結果が壊れる。

```js
function addUp(n) {
  var sum = 0;
  for (var i = 0; i < n; i++) { sum = sum + i * i; }
  return sum;
}
addUp(50000);
// TW/VM: 41665416675000 (正しい)
// IR JIT: -61063496 (i32 overflow で壊れる)
```

Range Analysis でコンパイル時に「i32 で安全か」を判定し、安全でなければ f64 に昇格。
実行時チェックは一切不要。

### 2. 配列が IR に載らない

IR パスでは配列アクセス (`arr[i]`, `arr[i] = v`, `arr.length`) が未対応。
quicksort 等の配列ベンチが IR パスに載らない。

WasmGC の `array.get` / `array.set` は Wasm ランタイムが bounds check を保証するので
jsmini 側で bounds check する必要はない。

## ステップ

### 20-1: Range 型 + 伝播

- [x] 20-1a: `src/ir/range.ts` — Range 型, analyzeRanges (fixpoint), canFitI32, functionNeedsF64
- [x] 20-1b: Op に range フィールドを追加
- [x] 20-1c: Range 伝播 (Const, Param, Add, Sub, Mul, Div, Mod, Negate, 比較, ビット, Phi, TypeGuard, LoadGlobal)
- [x] 20-1d: テスト (8 tests)

### 20-2: i32 安全判定 + f64 昇格

Range に基づいてコンパイル時に決定。実行時チェックなし。

- [x] 20-2a: `canFitI32(range)` + `functionNeedsF64` で判定
- [x] 20-2b: 安全 → i32 演算のまま
- [x] 20-2c: 危険 → codegen に forceF64 フラグ、params/locals/results 全て f64
- [x] 20-2d: 全 634 テストパス、addUp(50000) 正しい結果

### 20-3: 配列 IR 対応

- [ ] 20-3a: IR opcode 追加: ArrayGet, ArraySet, ArrayLength
- [ ] 20-3b: IR builder: GetPropertyComputed → ArrayGet, SetPropertyComputed → ArraySet
  - 配列かどうかは型フィードバックの `smi_array` / `double_array` で判定
- [ ] 20-3c: IR codegen: WasmGC array.get / array.set / array.len に変換
  - bounds check は Wasm ランタイムが保証 (jsmini 側で不要)
- [ ] 20-3d: テスト

### 20-4: ベンチマーク

- [ ] 20-4a: addUp(50000) が正しい結果を返す (f64 昇格)
- [ ] 20-4b: addUp(100) は i32 のまま高速
- [ ] 20-4c: bench.ts の i32 overflow テストが match=true になる
- [ ] 20-4d: 配列ベンチ (quicksort 等) が IR パスで動く

## 目標

- overflow で結果が壊れない (正確性)
- Range Analysis で i32/f64 をコンパイル時に決定 (実行時チェック不要)
- 配列が IR パスで動く (quicksort が IR JIT 対象に)

## 技術メモ

### Range Analysis のアプローチ

コンパイル時に各値の [min, max] を追跡:
- i32 に収まる → i32 演算 (最速、チェックなし)
- i32 を超える → f64 演算 (少し遅いけど正確、チェックなし)
- 実行時の overflow チェック (6命令) は不要

### ループの Range

ループカウンタが定数上限なら range 確定:
```
for (var i = 0; i < 100; i++) sum += i;
// i: [0, 99], sum: [0, 4950] → i32 安全
```

動的上限 (Param) は最悪ケース [0, 2^31):
```
for (var i = 0; i < n; i++) sum += i * i;
// n が Param → i: [0, 2^31), i*i: [0, 2^62) → f64 昇格
```

### 配列の bounds check

WasmGC の array.get/array.set は Wasm ランタイムが bounds check を保証。
範囲外アクセスは trap。jsmini 側で判定不要。
V8 はネイティブ機械語で Range Analysis + bounds check elimination をやるが、
Wasm 経由ではそもそも省略できない (Wasm の安全性保証)。
