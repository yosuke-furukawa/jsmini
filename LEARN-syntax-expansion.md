# Phase 13-extra: 構文拡大と Generator 実装

## 概要

test262 準拠率を 29.6% → 44.3% (VM) に引き上げた。
パーサーの拡張から始まり、最終的に Generator の TW / VM 両方の実装に至った。

## 成果

| | 開始時 (Phase 13-7) | 完了時 |
|---|---|---|
| VM | 2,650 (29.6%) | 3,964 (44.3%) |
| TW | 2,649 (29.6%) | 3,680 (41.1%) |

+1,314 テスト改善 (VM)。

---

## 1. パーサー拡張（低コスト・高リターン）

### 予約語をプロパティキーに (+65件)

JS では `return`, `class`, `delete` 等の予約語もプロパティ名として使える。

```js
var o = { return: 1, class: 2 };
o.return; // 1
```

`parsePropertyKey()` を導入し、プロパティキー位置では予約語トークンも識別子として許可した。

### class expression (+128件に貢献)

```js
var C = class { x() { return 42; } };
var c = new C();
```

`parsePrimary()` に `Class` トークンを追加。`parseClassBody()` を抽出して宣言と式で共有。

### unicode escape (+196件)

```js
var \u0061 = 42; // var a = 42
```

lexer で `\uXXXX` と `\u{XXXX}` を識別子の一部として処理。デコードした文字をキーワードルックアップにも使う。

### 簡易 ASI (+67件)

ExpressionStatement と VariableDeclaration の末尾セミコロンを optional に。`for` 文内のセミコロンは必須のまま。

---

## 2. 分割代入の拡充 (+432件)

### rest element

```js
var [a, ...rest] = [1, 2, 3];     // rest = [2, 3]
var { a, ...rest } = { a: 1, b: 2, c: 3 }; // rest = { b: 2, c: 3 }
```

パーサー: `ArrayPattern` / `ObjectPattern` 内の `...` を `RestElement` に変換。
カバー文法: `SpreadElement` → `RestElement`、`AssignmentExpression` → `AssignmentPattern` の変換も追加。

### default values

```js
var { a = 10, b = 20 } = { a: 1 }; // a = 1, b = 20
```

`bindPattern` に `defaultResolver` コールバックを追加。値が `undefined` のときにデフォルト式を評価。

### VM の対応

`compileBindingTarget` に `RestElement`（配列: `arr.slice(i)` を CallMethod）と `AssignmentPattern`（undefined チェック + JumpIfFalse でデフォルト値）を追加。

---

## 3. getter/setter と AccessorDescriptor

```js
var obj = {
  _v: 0,
  get v() { return this._v; },
  set v(x) { this._v = x; }
};
```

### VM の課題

VM のオブジェクトは Hidden Class + slots で管理されている。`Object.defineProperty` のネイティブ getter/setter は slots を経由しないため使えない。

**解決**: `AccessorDescriptor` 型を導入。getter/setter 関数をスロットに格納し、`GetProperty` / `SetPropertyAssign` で検出して呼び出す。

```ts
type AccessorDescriptor = {
  __accessor__: true;
  get?: unknown;  // BytecodeFunction or closure
  set?: unknown;
};
```

`GetProperty` の IC キャッシュヒット時も AccessorDescriptor をチェックする必要がある。

---

## 4. Symbol — 自前実装

V8 のネイティブ `Symbol` に依存せず、wrapper オブジェクトで実装。

```ts
type JSSymbol = {
  __symbol__: true;
  id: number;
  description: string;
  key: string;  // プロパティキーとして使う文字列 "@@symbol_N_desc"
};
```

- `Symbol("x") === Symbol("x")` → `false`（参照比較で自然に区別）
- `typeof Symbol()` → `"symbol"`（`isJSSymbol` チェック）
- well-known symbols: `SYMBOL_ITERATOR.key = "@@iterator"` 等

### なぜ文字列ではなく wrapper か

文字列ベースだと `"@@symbol_0_test"` という文字列を直接書いたら衝突する。wrapper オブジェクトなら参照比較で絶対に衝突しない。本物の JS と同じ「Symbol は固有のプリミティブ型」という性質を再現。

---

## 5. Iterator Protocol — 専用バイトコード

V8 と同じアプローチで、for-of を iterator protocol ベースに書き換えた。

### 4つの専用命令

| 命令 | 動作 |
|---|---|
| `GetIterator` | `obj[@@iterator]()` を呼ぶ。配列は内蔵イテレータ、文字列は1文字ずつ |
| `IteratorNext` | `iterator.next()` を呼ぶ |
| `IteratorComplete` | `result.done` を取得 |
| `IteratorValue` | `result.value` を取得 |

### コンパイル結果

```
// for (var x of iterable) { body }
GetIterator            // iterable → iterator
StaGlobal __iter       // iterator を保存
loop:
  LdaGlobal __iter
  IteratorNext         // → result
  Dup
  IteratorComplete     // → done
  JumpIfTrue exit
  IteratorValue        // → value
  StaLocal x
  ... body ...
  Jump loop
exit:
  Pop                  // done=true の result を捨てる
```

### 以前の実装との比較

以前は `arr.length` + インデックスアクセスのハードコードだった。これだとカスタム iterator が動かない。専用命令にしたことで、Generator や任意の iterable を for-of で回せるようになった。

---

## 6. Generator — TW と VM の対比

Generator は「実行の中断と再開」が必要な唯一の構文。TW と VM で実装方法が根本的に異なり、**なぜ VM が必要か**の最高の教材になる。

### VM: フレーム保存・復元

```
LdaConst 1
Yield          ← PC と locals を GeneratorObject に保存、run ループを脱出
StaLocal x     ← next() で復元された PC からここに復帰
```

`Yield` opcode は `YieldSignal` 例外を throw して run ループを抜ける。`GeneratorObject.next()` で保存した PC / locals からフレームを再構築して `run()` を再開。

```ts
// GeneratorObject の next()
next(value) {
  // 前回の状態からフレームを復元
  vm.frames.push({ func, pc: savedPc, locals: savedLocals, ... });
  if (savedPc > 0) vm.push(value); // yield 式の結果
  const result = vm.run();
  // Yield で中断 or Return で完了
}
```

**ポイント**: VM はコールスタック（frames 配列）を自前で管理しているから、任意のタイミングで保存・復元できる。

### TW: engine262 スタイル（ホスト Generator）

TW の evaluator は JS のコールスタックを使って再帰する。`yield` で途中停止したくても、**JS のコールスタックは保存できない**。

**解決**: evaluator の全関数を `function*` に変換。

```ts
// Before
function evalExpression(expr, env) { ... }

// After
function* evalExpression(expr, env) {
  case "YieldExpression": {
    const value = yield* evalExpression(expr.argument, env);
    return yield value;  // ← ホスト（V8）の yield で中断！
  }
}
```

ユーザーの `yield` → ホスト（V8）の `yield` にマッピング。`yield*` で全階層を貫通して伝播。

Generator 関数呼び出し時:
```ts
if (fn.isGenerator) {
  const bodyGen = evalBlock(fn.body.body, fnEnv); // ホスト generator
  return {
    next(value) {
      return bodyGen.next(value); // ホスト generator を進める
    }
  };
}
```

**ポイント**: engine262（ECMAScript 仕様準拠エンジン）と同じ手法。ホストの generator 機能を借りてゲストの generator を実現。評価関数の全呼び出しが `yield*` になるためオーバーヘッドがあるが、正しく動く。

### 対比まとめ

| | TW (engine262 スタイル) | VM (フレーム保存) |
|---|---|---|
| 中断方法 | ホストの `yield` | `YieldSignal` 例外 |
| 状態保存 | ホストの generator が保持 | PC + locals を手動保存 |
| 再開方法 | `bodyGen.next(value)` | フレーム再構築 + `run()` |
| 改造範囲 | evaluator 全体を `function*` に | `Yield` opcode 1つ追加 |
| オーバーヘッド | 全式評価に generator overhead | yield 時のみ |
| 教訓 | ホスト言語の機能に依存 | 自前の実行モデルの強み |

---

## 7. 残課題

### ビルトイン自前実装（別ブランチ）

VM が V8 のネイティブ `Array`, `String` 等をそのまま使っている（`vm.setGlobal("Array", Array)`）。test262 で VM が TW より 284件多く通るのはこの「ズル」が原因。教育用エンジンとしてはビルトインを自前で実装すべき。

### 未実装構文

- `yield*`（generator 委譲）
- `generator.throw()`
- `eval()`
- `arguments` オブジェクト
