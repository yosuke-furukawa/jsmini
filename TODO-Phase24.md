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

- [ ] 24-1a: Node.js で WebAssembly.Suspending / WebAssembly.promising の動作確認
- [ ] 24-1b: 手書き Wasm + JSPI で suspend/resume のミニマルサンプル
- [ ] 24-1c: Wasm 内から JS の async 関数を呼んで結果を受け取るサンプル
- [ ] 24-1d: suspend/resume のオーバーヘッド計測 (1000 回 suspend の所要時間)

### 24-2: jsmini 統合

- [ ] 24-2a: IR に Await opcode 対応 (IR builder で AwaitExpression → Await op)
- [ ] 24-2b: codegen: Await → Wasm import call (Suspending でラップした関数)
- [ ] 24-2c: compileIRToWasm: Wasm export を promising でラップ
- [ ] 24-2d: JitManager: async 関数の IR JIT パス (JSPI 有効時)
- [ ] 24-2e: テスト: async function が Wasm JIT で動作確認

### 24-3: ベンチマーク

- [ ] 24-3a: async loop (100 awaits): VM vs JSPI Wasm の比較
- [ ] 24-3b: sync loop inside async function: JSPI で JIT の恩恵を受けるか
- [ ] 24-3c: await のオーバーヘッド: JSPI vs VM YieldSignal
- [ ] 24-3d: 既存ベンチとの比較 (全体の回帰なし確認)

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
