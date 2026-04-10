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

### 23-1: Promise オブジェクト

- [ ] 23-1a: Promise 内部状態: `{ state: "pending"|"fulfilled"|"rejected", value, handlers[] }`
- [ ] 23-1b: `new Promise(executor)` — executor に resolve/reject を渡して即実行
- [ ] 23-1c: `promise.then(onFulfilled, onRejected)` — ハンドラ登録、新 Promise を返す
- [ ] 23-1d: `promise.catch(onRejected)` — `.then(undefined, onRejected)` のエイリアス
- [ ] 23-1e: テスト (同期 resolve, then チェーン, catch)

### 23-2: Microtask キュー

- [ ] 23-2a: microtask キュー実装 (FIFO)
- [ ] 23-2b: resolve/reject 時にハンドラを microtask キューに enqueue
- [ ] 23-2c: イベントループ: スクリプト実行完了後に microtask を drain
- [ ] 23-2d: then チェーン: then のコールバックの戻り値で次の Promise を resolve
- [ ] 23-2e: テスト (実行順序: sync → microtask, then チェーン順序)

### 23-3: Promise 静的メソッド

- [ ] 23-3a: `Promise.resolve(value)` — fulfilled な Promise を返す
- [ ] 23-3b: `Promise.reject(reason)` — rejected な Promise を返す
- [ ] 23-3c: `Promise.all(iterable)` — 全 fulfilled で resolve, 1 つでも reject で reject
- [ ] 23-3d: `Promise.race(iterable)` — 最初に settle した値で resolve/reject
- [ ] 23-3e: テスト (Promise.resolve, Promise.all, Promise.race)

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
- `Promise.resolve` / `Promise.all` / `Promise.race`
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
