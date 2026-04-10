# RESEARCH-Promise.md — Promise / async-await の内部実装

## ECMAScript 仕様

### Promise の内部スロット

仕様では Promise オブジェクトに以下の内部スロットを定義:

| スロット | 型 | 説明 |
|---|---|---|
| [[PromiseState]] | "pending" / "fulfilled" / "rejected" | 状態 |
| [[PromiseResult]] | any | resolve/reject された値 |
| [[PromiseFulfillReactions]] | PromiseReaction[] | .then の fulfill ハンドラリスト |
| [[PromiseRejectReactions]] | PromiseReaction[] | .then の reject ハンドラリスト |
| [[PromiseIsHandled]] | boolean | unhandled rejection 追跡用 |

### Promise Resolution Procedure

`resolve(value)` が呼ばれたとき:

1. `value` が Promise 自身 → `TypeError` で reject (自己参照禁止)
2. `value` がオブジェクトでない → そのまま fulfill
3. `value` に `.then` メソッドがある (thenable) → `PromiseResolveThenableJob` を enqueue
4. それ以外 → fulfill

**thenable 対応が重要**: `resolve(otherPromise)` すると即 fulfill ではなく、microtask を 1 つ挟んで `otherPromise.then(resolve, reject)` を呼ぶ。

### 仕様の Job (= microtask)

仕様では 2 種類の Job を定義:

- **PromiseReactionJob**: `.then`/`.catch` のハンドラを 1 つ実行
- **PromiseResolveThenableJob**: thenable の `.then` を呼んで resolve/reject に接続

Job は **Job Queue** に入り、現在のスクリプト/モジュール実行完了後に drain される。ブラウザ/Node.js では microtask キューとして実装。

### .then() は常に非同期

Promise が既に fulfilled でも `.then(onFulfilled)` は同期呼び出ししない。PromiseReactionJob を enqueue する。これにより実行順序が常に一貫する (Zalgo-free)。

```js
Promise.resolve(1).then(v => console.log(v));
console.log(2);
// 出力: 2, 1 (then は必ず後)
```

---

## V8 の実装

### 内部表現

V8 は `JSPromise` クラス (JSObject のサブクラス) で表現:

- **flags**: 状態ビット `kPending(0)`, `kFulfilled(1)`, `kRejected(2)` をパック
- **result_or_reactions**: **デュアルパーパスフィールド**
  - pending 時: `PromiseReaction` の **リンクリスト** (`.then` ハンドラチェーン)
  - settled 時: 結果値を直接保持

settled 後は reaction リストが不要なので同じフィールドを使い回す。メモリ効率が良い。

### PromiseReaction 構造体

```
PromiseReaction {
  fulfill_handler   // onFulfilled コールバック (or undefined)
  reject_handler    // onRejected コールバック
  promise_or_capability  // .then() が返す子 Promise
  next               // 次の reaction (リンクリスト)
}
```

### .then() の流れ

1. 新しい `JSPromise` (子 Promise) を作成
2. `PromiseReaction` を作成 (handler + 子 Promise)
3. **pending なら**: reactions リンクリストの先頭に追加
4. **settled なら**: 即 `PromiseReactionJob` を microtask キューに enqueue
5. 子 Promise を返す

### Microtask キュー

- `MicrotaskQueue` (deque/ring buffer)
- `EnqueueMicrotask()` で追加、`RunMicrotasks()` で drain
- embedder (Chrome, Node.js) が適切なタイミングで `RunMicrotasks()` を呼ぶ

### async/await

V8 は async 関数を **bytecode レベルの状態マシン** にコンパイル:

```js
async function f() {
  const x = await expr;
  return x + 1;
}
```

内部的には:

1. async 関数呼び出し → 暗黙の Promise を作成
2. 関数本体を実行開始
3. `await expr` → `Promise.resolve(expr)` の `.then()` に resume コールバックを登録
4. 関数を中断 (suspend)
5. microtask で resume → 関数を再開、次の await まで実行
6. return → 暗黙の Promise を resolve

**V8 v7.2 の最適化 (2018)**: `await nativePromise` のとき、PromiseResolveThenableJob を省略して直接チェーンする。microtask が 3 tick → 2 tick に削減。仕様も変更されてこれを許可。

### V8 の最適化

- **Zero-cost async stack traces**: await 地点のメタデータを Promise に保存。デバッグ時にだけ参照
- **Native Promise fast-path**: thenable ではなく native Promise なら generic パスを回避
- **Torque/CSA builtin**: Promise コンストラクタ等はインタプリタではなく C++ builtin で高速化

---

## JSC (JavaScriptCore) の実装

### 内部表現

- `JSPromise` (ユーザー向け) と `JSInternalPromise` (エンジン内部用、モジュール読み込み等) を分離
- flags で状態管理、reactions は配列的な構造
- Promise ロジックの多くは C++ builtin (`JSPromise.cpp`)

### async/await

- Generator 的な bytecode 状態マシンにコンパイル
- `@asyncFunctionResume` 内部関数で再開を管理
- DFG/FTL JIT で最適化されるが、suspend/resume 境界は最適化バリア

### V8 との違い

- `JSInternalPromise` の分離 (V8 にはない)
- await の native Promise 最適化は JSC も実装済み

---

## SpiderMonkey の実装

### 内部表現

- `PromiseObject` (NativeObject のサブクラス)
- **reserved slots** に状態・結果・reactions を格納
- V8 と同じ **デュアルパーパス**: pending 時は reactions、settled 時は結果
- reactions は **配列** (V8 のリンクリストと異なる)

### Microtask キュー

- 仕様用語通り **Job Queue** と呼ぶ
- `EnqueuePromiseJob` を embedder (Gecko) が実装
- スタンドアロンの JS shell では単純な FIFO キュー

### async/await

- bytecode 状態マシン方式
- await の native Promise 最適化も実装済み

---

## エンジン比較

| | V8 | JSC | SpiderMonkey |
|---|---|---|---|
| 状態保持 | flags bitfield | cell flags | reserved slot |
| Reactions (pending) | リンクリスト | 配列的構造 | 配列 |
| Result (settled) | reactions と同じフィールド | 同上 or 別 | reactions と同じフィールド |
| Microtask キュー | MicrotaskQueue (deque) | VM レベルキュー | Host 提供の job queue |
| async/await | bytecode 状態マシン | Generator 的 + @asyncFunctionResume | bytecode 状態マシン |
| await 最適化 (native) | v7.2+ (2018) | 実装済み | 実装済み |
| 内部/ユーザー分離 | なし | JSInternalPromise | なし |

---

## jsmini への示唆

### 最小構成で必要なもの

1. **Promise オブジェクト**: state + result + reactions (配列でOK)
2. **PromiseReaction**: `{ onFulfilled, onRejected, childPromise }`
3. **Microtask キュー**: 単純な FIFO 配列 + drain 関数
4. **.then() ロジック**: pending → reactions に追加、settled → microtask enqueue
5. **resolve ロジック**: thenable チェック → PromiseResolveThenableJob or 直接 fulfill
6. **async/await**: 既存の Generator (function*) を活用して状態マシン化

### V8 のデュアルパーパスフィールドは採用不要

V8 が result と reactions で同じフィールドを使うのはメモリ最適化。
jsmini は教育目的なので `{ state, result, fulfillReactions, rejectReactions }` と素直に持つ方がわかりやすい。

### thenable 対応は後回し可能

`resolve(otherPromise)` で PromiseResolveThenableJob を挟む仕様は正確だが、
最初は「value が Promise なら直接 adopt する」簡易実装でも `.then()` チェーンは動く。

### async/await の実装方針

jsmini は既に Generator (function*) を VM で実装している。async/await は:

1. **Parser**: `async function` / `await expr` を AST に追加
2. **Compiler**: async 関数を Generator 的な bytecode に変換 (Yield → Await)
3. **VM**: Await opcode で暗黙の Promise を作り、`.then(resume)` で中断/再開

V8 / JSC / SpiderMonkey 全てが bytecode 状態マシン方式を採用しているので、この方針は正しい。

### 参考記事

- V8 Blog: "Faster async functions and promises" (2018, Maya Lekova & Benedikt Meurer)
  - await 最適化の詳細、microtask tick 数の削減
- ECMA-262: 27.2 Promise Objects
  - Promise の仕様定義
