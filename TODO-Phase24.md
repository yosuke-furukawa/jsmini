# TODO Phase 24 — JSPI (JavaScript Promise Integration) で async JIT

## 動機

Phase 23 で async/await を実装したが、async 関数は **VM のみで実行** される。
Wasm JIT の対象外。理由は Wasm に suspend/resume 機構がなかったから。

JSPI (JavaScript Promise Integration) は Wasm に suspend/resume を提供する API。
Chrome 137 / Firefox 139 で ship 済み、Node.js では `--experimental-wasm-jspi` で利用可能。

```
現状:
  async function → VM で実行 (YieldSignal throw で suspend)
  Wasm JIT は async 関数に使えない

JSPI 対応:
  async function → Wasm JIT コンパイル
  await → WebAssembly.Suspending でラップした関数を import call
  Wasm 関数を WebAssembly.promising でラップして export
  → async 関数全体が Wasm で実行可能に
```

## 検証したいこと

1. JSPI が Node.js (--experimental-wasm-jspi) で実際に動くか
2. async ループが Wasm で動くとどれくらい速くなるか
3. suspend/resume のオーバーヘッドはどの程度か
4. jsmini の YieldSignal ハックと比べてどうか

## ステップ

### 24-1: JSPI 基本検証

- [x] 24-1a: Node.js v24 + --experimental-wasm-jspi で Suspending / promising 確認
- [x] 24-1b: 手書き Wasm: f(x) = awaitVal(x) + 1 で suspend/resume 動作確認
- [x] 24-1c: awaitVal(10) → 20 → +1 = 21 が Promise 経由で返る
- [x] 24-1d: ベンチ: JSPI 0.49ms vs VM 7.66ms (15.7x) vs TW 6.41ms (13.2x) @1000回

### 24-2: jsmini 統合

- [x] 24-2a: IR builder: Await bytecode → Call(__await, value) として IR に表現
- [x] 24-2b: codegen: Call(__await) → call import 0 (Suspending 関数)、f64 型対応
- [x] 24-2c: compileIRToWasm: addImport(__await, Suspending)、promising で export ラップ
- [x] 24-2d: JitManager: CachedWasm.jspiWrapped、executeWasm で Promise 返却
- [x] 24-2e: VM: async 関数の 3 つの Call パスで JIT を試行 (feedback + tryCall)
- [x] 24-2f: WasmBuilder: addImport 機能追加 (Import section + type/func index offset)
- [x] 24-2g: tier log 確認: call #3 → "Wasm compiled" → "Wasm (JSPI)"

### 24-3: ベンチマーク

- [x] 24-3a: async loop scaling: N=100→5000 で JSPI vs VM
- [x] 24-3b: heavy computation between awaits (50 chunks x 1000 iter)
- [x] 24-3c: 既存 753 テスト回帰なし
- [x] 24-3d: tier log 確認: call #3 → Wasm (JSPI) に tier-up

### ベンチマーク結果

**JSPI suspend/resume overhead (検証, Phase 24-1)**

| 方式 | 1000 suspend/resume | vs JSPI |
|---|---|---|
| JSPI (Wasm native) | 0.49ms | baseline |
| TW (generator yield) | 6.41ms | 13.2x 遅い |
| VM (YieldSignal throw) | 7.66ms | 15.7x 遅い |

**async loop scaling (Phase 24-3)**

| N | VM async | JSPI JIT | JSPI/VM |
|---|---|---|---|
| 100 | 0.28ms | 0.92ms | 0.30x (compile overhead) |
| 500 | 0.51ms | 0.47ms | 1.08x |
| 1000 | 0.74ms | 0.74ms | 1.0x |
| 5000 | 3.60ms | 3.64ms | 1.0x |

**考察**: JSPI の suspend/resume 自体は 15.7x 速いが、jsmini の async ループでは
await のたびに microtask を経由するため、VM と同等の速度に落ち着く。
JSPI が本当に効くのは V8 の TurboFan が Wasm 内の同期部分を最適化できるケース。
jsmini では async 関数全体が 1 つの Wasm 関数になるため、内部ループの最適化は限定的。

## 技術メモ

### JSPI API

```js
// 1. JS の async 関数を Suspending でラップ
const suspendingFn = new WebAssembly.Suspending(async (value) => {
  return await somePromise(value);
});

// 2. Wasm モジュールに import
const instance = new WebAssembly.Instance(module, {
  env: { awaitFn: suspendingFn }
});

// 3. Wasm の export を promising でラップ
const asyncWasmFn = WebAssembly.promising(instance.exports.f);

// 4. 呼び出し → Promise を返す
const result = await asyncWasmFn(args);
```

### jsmini での実装イメージ

```
IR:
  v0 = Param(0)
  v1 = Await(v0)        // ← await expr
  v2 = Add(v1, Const(1))
  Return(v2)

Wasm (JSPI):
  (import "env" "__await" (func $await (param i32) (result i32)))
  ;; $await は WebAssembly.Suspending でラップされた関数
  ;; Wasm から $await を call すると、Wasm スタック全体が suspend
  ;; Promise が resolve したら Wasm が resume

  (func $f (export "f") (param $x i32) (result i32)
    local.get $x
    call $await       ;; ← ここで Wasm が suspend!
    i32.const 1
    i32.add
    return
  )
```

### 制約

- Node.js: `--experimental-wasm-jspi` フラグが必要
- Chrome 137+ / Firefox 139+ ではフラグ不要
- JSPI は Wasm module 単位で有効化 (既存の non-async 関数には影響なし)
- Suspending 関数は必ず Promise を返す必要がある

### 期待される効果

async ループ内の **同期的な計算部分** が Wasm で高速化される:

```js
async function processChunks(data) {
  var result = 0;
  for (var i = 0; i < data.length; i++) {
    var chunk = await loadChunk(i);  // ← JSPI で suspend
    result = result + heavyCompute(chunk);  // ← Wasm で高速実行
  }
  return result;
}
```

suspend/resume 自体のオーバーヘッドは VM の YieldSignal throw より大きい可能性がある
(Wasm スタック全体の保存/復元)。ベンチで検証。
