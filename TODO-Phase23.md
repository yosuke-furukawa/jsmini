# TODO Phase 23 — Promise + async/await

## 動機

jsmini に非同期ランタイムを実装する。
Promise は現代 JavaScript の中核機能であり、エンジン内部のイベントループ・microtask キューの仕組みを理解するのに最適な題材。

```js
// 目標: これが動く
async function fetchData() {
  const data = await loadSomething();
  return data + 1;
}

new Promise((resolve) => {
  resolve(42);
}).then((v) => {
  console.log(v); // 42
});
```

## ステップ

### 23-1: Promise オブジェクト (TW)

- [x] 23-1a: `src/runtime/promise.ts` — JSPromise クラス (state/result/reactions)
- [x] 23-1b: `new Promise(executor)` — executor に resolve/reject を渡して即実行
- [x] 23-1c: `promise.then(onFulfilled, onRejected)` — ハンドラ登録、新 Promise を返す
- [x] 23-1d: `promise.catch(onRejected)` — `.then(undefined, onRejected)` のエイリアス
- [x] 23-1e: テスト 19 件パス (then, chain, catch, resolve, reject, execution order, throw→catch, nested, long chain, multi-then, recovery, executor throw, interleaved, adopt 等)

### 23-2: Microtask キュー

- [x] 23-2a: microtask キュー実装 (FIFO 配列) — enqueueMicrotask / drainMicrotasks
- [x] 23-2b: resolve/reject 時にハンドラを microtask キューに enqueue
- [x] 23-2c: evaluate() / vmEvaluate() 終了後に microtask を drain
- [x] 23-2d: drain 中に追加された microtask も処理 (then チェーン伝播)
- [x] 23-2e: テスト済み (実行順序 "a,c,b" = sync → microtask)

### 23-3: Promise.resolve / Promise.reject + VM 対応

- [x] 23-3a: `Promise.resolve(value)` / `Promise.reject(reason)` 静的メソッド
- [x] 23-3b: VM 対応: setHandlerCaller フックで BytecodeFunction を vm.callFunction で実行
- [x] 23-3c: VM 対応: isCallable で BytecodeFunction/クロージャを Promise handler として受け入れ
- [x] 23-3d: VM 対応: callInternal の run() 戻り値を正しく返す修正
- [x] 23-3e: VM テスト 7 件パス (then, chain, catch, order, long chain, recovery, multi-then)
- [x] 23-3f: Parser: `new Foo().method()` チェーン対応
- [x] 23-3g: ベンチ: Promise chain 1000 thens — VM 0.89ms (TW 5.0ms の 5.6x)

※ `Promise.all` / `Promise.race` はエンジン内部の対応不要 (JS で実装可能)。必要なら後から追加。

### 23-4: async/await 構文

- [ ] 23-4a: Lexer: `async`, `await` キーワード追加
- [ ] 23-4b: Parser: `async function` 宣言/式、`await` 式
- [ ] 23-4c: TW (tree-walking): async 関数 → Promise を返す、await → Promise の値を取り出す
- [ ] 23-4d: Compiler + VM: async/await の bytecode 対応 (generator ベースの状態マシン)
- [ ] 23-4e: テスト (async function, await, async arrow, try/catch + await)

### 23-5: 統合テスト + Playground

- [ ] 23-5a: Promise + async/await の複合テスト
- [ ] 23-5b: エラーハンドリング: unhandled rejection, async throw
- [ ] 23-5c: Playground プリセット追加 (Promise / async-await)
- [ ] 23-5d: 全テストパス

## 目標

- `new Promise` + `.then()` + `.catch()` が動く
- microtask キューで正しい実行順序 (sync → microtask)
- `Promise.resolve` / `Promise.reject`
- `async function` + `await` が動く
- Playground で非同期コードの実行順序を可視化

## 技術メモ

### Promise の状態遷移

```
pending ──resolve(value)──→ fulfilled
   │                            │
   └──reject(reason)──→ rejected
                                │
                         then/catch ハンドラを microtask で実行
```

一度 settled (fulfilled/rejected) になったら変わらない。

### Microtask キューとイベントループ

```
1. スクリプト実行 (同期コード)
2. microtask キューを drain (then/catch コールバック)
3. 追加の microtask があれば drain (then チェーン)
4. キューが空になったら終了
```

V8 では `%RunMicrotasks()` で drain。jsmini では `evaluate()` / `vmEvaluate()` の最後に drain。

### async/await の実装方式

`async function` は内部的に **Generator + Promise** に変換:

```js
// ソース
async function f() {
  const x = await fetch();
  return x + 1;
}

// 内部的な変換イメージ
function f() {
  return new Promise((resolve, reject) => {
    const gen = f_generator();
    function step(value) {
      const { done, value: v } = gen.next(value);
      if (done) { resolve(v); return; }
      Promise.resolve(v).then(step, reject);
    }
    step();
  });
}
```

jsmini は既に Generator (function*) を実装しているので、
async function を「Generator を Promise でラップする」形で実装できる。

### Tree-Walking vs VM

Tree-Walking (evaluator.ts) は Generator ベースの実行なので、
async/await は generator の yield/resume の仕組みをそのまま使える。

VM (vm.ts) では bytecode レベルで状態マシンを実装する必要がある:
- `Await` opcode: Promise の完了を待ち、値を取り出す
- 状態の保存/復元: locals + stack + pc をキャプチャ
- Generator と同じ仕組みで中断/再開
