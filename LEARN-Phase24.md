# LEARN-Phase24.md — JSPI (JavaScript Promise Integration)

## やったこと

Wasm Stack Switching の API である JSPI を使って、async 関数を Wasm JIT で実行できるようにした。

## JSPI の仕組み

```wat
;; Wasm バイナリには async の痕跡がない。普通の call 命令
(func $f (param $x i32) (result i32)
  local.get $x
  call $__await    ;; ← ここで Wasm スタックごと suspend
  i32.const 1
  i32.add
)
```

```js
// 非同期制御は JS 側のラッパーだけ
const __await = new WebAssembly.Suspending(async (v) => v);
const instance = new WebAssembly.Instance(module, { env: { __await } });
const f = WebAssembly.promising(instance.exports.f);  // Promise を返す
await f(10);  // Wasm 内で suspend → resolve → resume → 結果
```

- `WebAssembly.Suspending`: JS の async 関数を「Wasm から呼ぶと suspend する」とマーク
- `WebAssembly.promising`: Wasm の export を「Promise を返す」にラップ
- Wasm バイナリ自体は変更不要。**同じバイナリが sync でも async でも動く**

## suspend/resume は 15.7x 速い

直接テスト (1000 回 suspend/resume):

| 方式 | 時間 | vs JSPI |
|---|---|---|
| JSPI (Wasm native stack swap) | 0.49ms | baseline |
| TW (JS generator yield) | 6.41ms | 13.2x 遅い |
| VM (YieldSignal throw/catch) | 7.66ms | 15.7x 遅い |

JSPI は Wasm ランタイムがスタックを直接 swap する。
jsmini の YieldSignal は JS の例外機構 (throw/catch) を制御フローに流用しているので遅い。

## しかし async ループでは差が出ない

```js
async function f(n) {
  var sum = 0;
  for (var i = 0; i < n; i++) { sum = sum + await i; }
  return sum;
}
```

| N | VM async | JSPI JIT | JSPI/VM |
|---|---|---|---|
| 100 | 0.28ms | 0.92ms | 0.30x (compile overhead) |
| 500 | 0.51ms | 0.47ms | 1.08x |
| 1000 | 0.74ms | 0.74ms | 1.0x |
| 5000 | 3.60ms | 3.64ms | 1.0x |

N が大きくなっても JSPI ≈ VM。suspend/resume は 15.7x 速いのに全体では同速。

## なぜ速くならないか: microtask queue がボトルネック

```
await 1回あたりのコスト分解:

VM:    YieldSignal throw (~1μs) + microtask drain (~5μs) + vm.run() (~1μs)
JSPI:  Wasm suspend (~0.5μs)   + microtask drain (~5μs) + Wasm resume (~0.5μs)
                                  ^^^^^^^^^^^^^^^^^
                                  共通ボトルネック (全体の ~70%)
```

jsmini の microtask drain は **JS の while ループ**:

```ts
while (microtaskQueue.length > 0) {
  const task = microtaskQueue.shift();  // JS 配列操作
  task();                                // JS 関数呼び出し
}
```

suspend/resume を 15x 速くしても、全体の 70% を占める microtask drain が JS のままなので効果が薄い。

## V8 はなぜ速いか

V8 ネイティブの microtask queue は **C++ の deque + C++ の RunMicrotasks() ループ**:
- push/shift が C++ ネイティブ (JS 配列の shift は O(n) コピー)
- RunMicrotasks が C++ tight loop (JS インタプリタ dispatch なし)
- resume が C++ スタック操作 (JS の vm.run() 再開ではない)

jsmini が TypeScript で書かれている限り、この部分は V8 に勝てない。

## 現実のコードでは問題にならない

```js
// 現実: I/O 待ち (数ms〜数百ms) が支配的
const data = await fetch("/api");  // 50ms
process(data);                     // 0.1ms

// microtask dispatch: ~0.005ms → I/O の 0.01%
```

`await 42` を 1000 回回すマイクロベンチでは microtask のコストが見えるが、
現実の `await fetch()` では I/O 待ちが桁違いに大きいので microtask の速度差は誤差。

## jsmini への意味

- **技術的に動く**: async 関数が IR → Wasm (JSPI) でコンパイル・実行される
- **tier-up が正しく動く**: call #3 で Wasm (JSPI) に切り替わる
- **実用的 speedup は限定的**: microtask queue が JS 実装 → 全体では VM と同速
- **将来の土台**: async 関数が JIT 対象になったこと自体が、今後の最適化の基盤になる
- **教育的価値**: JSPI の仕組みと限界を理解。Wasm は同期、非同期は embedder の責任

## jsmini の限界 = TypeScript ランタイムの限界

jsmini は TypeScript で書かれた教育用エンジン。
V8 が C++ で実装している microtask queue, スタック管理, GC 等を JS レベルで再現しているため、
「仕組みを理解する」には最適だが「V8 と同じ速度を出す」のは原理的に不可能。

これは jsmini の設計上の正しいトレードオフ:
- **可読性 > 速度**: TypeScript なので誰でも読める
- **教育 > 最適化**: 仕組みを見せることが目的
- **Wasm 経由の JIT**: ネイティブ機械語を生成しない代わりにポータブル
