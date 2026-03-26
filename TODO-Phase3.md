# TODO - Phase 3: モダン JavaScript

PLAN.md の Step 3 をタスク単位に分解したもの。
Phase 2 で構築したオブジェクト・配列・スコープ・try/catch の上にモダン構文を追加していく。

---

## 3-1. アロー関数 [P3]

### Lexer 拡張

- [x] TokenType 追加: `Arrow` (`=>`)
- [x] `=>` のスキャン（`==`, `===` との優先順位で正しく区別）
- [x] テスト追加

### Parser 拡張

- [x] AST ノード追加:
  - `ArrowFunctionExpression` (params, body, expression)
- [x] アロー関数のパース:
  - `(a, b) => a + b` (式本体)
  - `(a, b) => { return a + b; }` (ブロック本体)
  - `a => a + 1` (括弧省略、単一引数)
  - `() => 42` (引数なし)
- [x] `isArrowParams()` で先読みして `(ident, ident) =>` パターンを判定
- [x] テスト追加

### Evaluator 拡張

- [x] `ArrowFunctionExpression` の評価 → `isArrow: true` 付き JSFunction
- [x] アロー関数は自身の `this` を持たない（`isFunctionScope = false` で親の this を継承）
- [x] 式本体の場合は暗黙の `ReturnStatement` に変換
- [x] アロー関数は `new` できない（TypeError）
- [x] テスト追加
- [x] Codex レビュー済み（new 不可を指摘→修正済み）

```javascript
// ゴール
var add = (a, b) => a + b;
console.log(add(3, 4)); // 7

var nums = [1, 2, 3];
var doubled = nums; // map は Phase 3 では未実装、基本動作のみ

var obj = {
  x: 10,
  getX: function getX() {
    var inner = () => this.x; // アロー関数は this を継承
    return inner();
  }
};
console.log(obj.getX()); // 10
```

**マイルストーン: `(a, b) => a + b` が動く。アロー関数が this を継承する**

---

## 3-2. テンプレートリテラル [P3]

### Lexer 拡張

- [x] TokenType 追加: `NoSubstitutionTemplate`, `TemplateHead`, `TemplateMiddle`, `TemplateTail`
- [x] `scanTemplate()` で `` ` `` 〜 `` ` `` / `${` / `}` のスキャン
- [x] `templateDepthStack` + `braceDepth` でネスト管理（テンプレート内テンプレート対応）
- [x] `{ }` を singleCharMap から分離して depth 追跡
- [x] エスケープ処理: `\n`, `\t`, `\r`, `\\`, `` \` ``, `\$`, 行継続、未知エスケープ保持
- [x] テスト追加

### Parser 拡張

- [x] AST ノード追加:
  - `TemplateLiteral` (quasis: TemplateElement[], expressions: Expression[])
  - `TemplateElement` (value: { raw, cooked }, tail)
- [x] `parseTemplateLiteral()`: TemplateHead → Expression → (TemplateMiddle → Expression)* → TemplateTail
- [x] テスト追加

### Evaluator 拡張

- [x] `TemplateLiteral` の評価 → quasis と expressions を交互に結合
- [x] テスト追加（埋め込みなし、式埋め込み、複数式、空、ネスト）
- [x] Codex レビュー済み（エスケープ修正、braceDepth ガード追加）

```javascript
// ゴール
var name = "world";
console.log(`hello ${name}`);       // "hello world"
console.log(`1 + 2 = ${1 + 2}`);   // "1 + 2 = 3"
```

**マイルストーン: `` `hello ${name}` `` が動く**

---

## 3-3. プロトタイプチェーン [P3]

Phase 2 の `new` は新オブジェクトを作るだけだった。ここでプロトタイプを導入する。

### Evaluator 拡張

- [x] 内部 `[[Prototype]]` の仕組み:
  - `__proto__` キーでプロトタイプリンクを管理
  - `getProperty()` / `hasProperty()` でチェーン探索
- [x] `new Ctor()` で `newObj.__proto__ = constructor.prototype` を設定
- [x] `FunctionDeclaration` / `FunctionExpression` に `prototype: {}` を自動付与
- [x] アロー関数は `prototype: undefined`（ECMAScript 準拠）
- [x] MemberExpression の読み取りで `getProperty()` を使用
- [x] CallExpression のメソッド呼び出しでも `getProperty()` を使用
- [x] `null` / `undefined` のプロパティアクセスで TypeError
- [x] テスト追加（prototype メソッド呼び出し、優先順位、チェーン継承、後から追加、null/undefined エラー）
- [x] Codex レビュー済み（null/undefined TypeError 追加、アロー prototype 修正）

```javascript
// ゴール
function Animal(name) {
  this.name = name;
}
Animal.prototype.speak = function speak() {
  return this.name + " makes a sound";
};

var dog = new Animal("Rex");
console.log(dog.speak());       // "Rex makes a sound"
console.log(dog.name);          // "Rex"
```

**マイルストーン: `Ctor.prototype` に定義したメソッドが `new` で作ったインスタンスから呼べる**

---

## 3-4. クラス構文 [P3]

プロトタイプチェーンの上に構文糖衣としてのクラスを実装する。

### Lexer 拡張

- [x] キーワード追加: `class`, `extends`, `super`
- [x] KEYWORDS を `Object.create(null)` に変更（`constructor` が `Object.prototype.constructor` と衝突するバグを修正）

### Parser 拡張

- [x] AST ノード追加: `ClassDeclaration`, `ClassBody`, `MethodDefinition`
- [x] `class Foo { constructor() {} method() {} }` のパース
- [x] `class Bar extends Foo { ... }` のパース
- [x] `super` を `__super__` Identifier として処理（CallExpression で特別扱い）
- [x] テスト追加

### Evaluator 拡張

- [x] `ClassDeclaration` の評価:
  - constructor メソッドから JSFunction を作成（`isClass: true`）
  - メソッドを `prototype` に登録
  - `extends`: プロトタイプチェーン接続、`__super__` を closure に注入
  - constructor なし: 空コンストラクタ or 親コンストラクタ使用
- [x] `super()` 呼び出し: 現在の `this` で親コンストラクタを実行
- [x] class を `new` なしで呼ぶと TypeError
- [x] テスト追加
- [x] Codex レビュー済み（class new 必須を修正）

```javascript
// ゴール
class Animal {
  constructor(name) {
    this.name = name;
  }
  speak() {
    return this.name + " makes a sound";
  }
}

class Dog extends Animal {
  constructor(name) {
    super(name);
  }
  speak() {
    return this.name + " barks";
  }
}

var d = new Dog("Rex");
console.log(d.speak()); // "Rex barks"
```

**マイルストーン: `class` / `extends` / `super` が動く**

---

## 3-5. 分割代入 (基本) [P3]

### Parser 拡張

- [x] AST ノード追加: `ObjectPattern`, `ArrayPattern`, `AssignmentProperty`, `Pattern` 型
- [x] `VariableDeclarator.id` を `Pattern` に拡張
- [x] `parseBindingPattern()` でオブジェクト/配列パターンをパース（ネスト対応）
- [x] 関数パラメータを `parseBindingPattern()` に統一（関数宣言・式・クラスメソッド）
- [x] テスト追加

### Evaluator 拡張

- [x] `bindPattern()` ヘルパーで Pattern に対して値を分解して定義（var/let/const 対応）
- [x] `collectBoundNames()` で Pattern から束縛名を収集（ホイスティング・TDZ 対応）
- [x] VariableDeclaration、関数引数、new、super() の引数バインドを `bindPattern()` に統一
- [x] テスト追加（オブジェクト/配列分割、let/const、存在しないプロパティ、ネスト、関数引数）
- [x] Codex レビュー済み（ホイスティング・TDZ の BoundNames 対応を修正）
- [x] 代入式での分割代入（カバー文法）:
  - `({ a, b } = obj)` — ObjectExpression → ObjectPattern に事後変換
  - `[a, b] = arr` — ArrayExpression → ArrayPattern に事後変換
  - `assignPattern()` で既存変数への set を実行
  - オブジェクトリテラルのショートハンド `{ a }` → `{ a: a }` も対応

```javascript
// ゴール
var obj = { x: 10, y: 20 };
var { x, y } = obj;
console.log(x); // 10

var arr = [1, 2, 3];
var [a, b] = arr;
console.log(a); // 1
```

**マイルストーン: `var { x } = obj` と `var [a, b] = arr` が動く**

---

## 3-6. スプレッド / レスト演算子 [P3]

### Lexer 拡張

- [x] TokenType 追加: `DotDotDot` (`...`)

### Parser 拡張

- [x] AST ノード追加: `SpreadElement`, `RestElement`
- [x] 配列リテラル `[...arr]`、オブジェクトリテラル `{ ...obj }` のスプレッド
- [x] 関数呼び出し `f(...args)` のスプレッド
- [x] 関数パラメータ `function f(a, ...rest) {}` のレスト
- [x] rest は末尾1つのみ（SyntaxError 制約）
- [x] `parseArguments()` / `parseCallArgument()` / `parseParam()` ヘルパー追加
- [x] クラスメソッドのパラメータも `parseParam()` に統一
- [x] テスト追加

### Evaluator 拡張

- [x] ArrayExpression: SpreadElement を展開
- [x] ObjectExpression: SpreadElement を Object.assign で展開
- [x] `evalArguments()`: SpreadElement を展開した引数配列を返す
- [x] 引数バインドで RestElement → `args.slice(i)` で残り引数を配列化
- [x] テスト追加
- [x] Codex レビュー済み（rest 末尾制約追加）

```javascript
// ゴール
var arr = [1, 2, 3];
var arr2 = [0, ...arr, 4]; // [0, 1, 2, 3, 4]

function sum(a, b, ...rest) {
  var total = a + b;
  for (var i = 0; i < rest.length; i = i + 1) {
    total = total + rest[i];
  }
  return total;
}
console.log(sum(1, 2, 3, 4)); // 10
```

**マイルストーン: `...` によるスプレッド/レストが動く**

---

## 3-7. for...of ループ [P3]

### Lexer 拡張

- [x] キーワード追加: `of`

### Parser 拡張

- [x] AST ノード追加: `ForOfStatement`
- [x] `for` パーサーのリファクタ: `var/let/const` の後に `of` → ForOfStatement、`;` → ForStatement
- [x] `for (var x of arr)` / `for (let x of arr)` / `for (var [a, b] of pairs)` のパース
- [x] テスト追加

### Evaluator 拡張

- [x] `ForOfStatement` の評価: 配列をイテレーションし bindPattern で変数に束縛
- [x] let/const は forEnv で閉じる、var は貫通
- [x] ホイスティングに ForOfStatement 対応
- [x] テスト追加（基本、let/var スコープ、空配列、分割代入）

```javascript
// ゴール
var arr = [10, 20, 30];
var sum = 0;
for (var x of arr) {
  sum = sum + x;
}
console.log(sum); // 60
```

**マイルストーン: `for (var x of arr)` が動く**

---

## Phase 3 完了チェック

以下のプログラムが正しく動作すること:

```javascript
// アロー関数
var add = (a, b) => a + b;
console.log(add(1, 2)); // 3

// テンプレートリテラル
var name = "world";
console.log(`hello ${name}`); // "hello world"

// クラス
class Animal {
  constructor(name) {
    this.name = name;
  }
  speak() {
    return this.name + " makes a sound";
  }
}

class Dog extends Animal {
  constructor(name) {
    super(name);
  }
  speak() {
    return this.name + " barks";
  }
}

var d = new Dog("Rex");
console.log(d.speak()); // "Rex barks"

// 分割代入
var { x, y } = { x: 10, y: 20 };
console.log(x + y); // 30

// スプレッド
var arr = [1, 2, 3];
var arr2 = [0, ...arr];
console.log(arr2.length); // 4

// for...of
var sum = 0;
for (var n of [10, 20, 30]) {
  sum = sum + n;
}
console.log(sum); // 60
```

- [ ] 上記プログラムの期待出力を確認
- [ ] 全ユニットテストが通過
- [ ] Test262 通過率が Phase 2 (21.4%) から改善

---

## 実装順序

```
Step 3-1: アロー関数
    ↓
Step 3-2: テンプレートリテラル
    ↓
Step 3-3: プロトタイプチェーン
    ↓
Step 3-4: クラス (extends / super)
    ↓
Step 3-5: 分割代入
    ↓
Step 3-6: スプレッド / レスト
    ↓
Step 3-7: for...of
    ↓
Test262 再実行・通過率更新
```

順序の理由:
- 3-1 (アロー関数) は FunctionExpression の延長で比較的軽い
- 3-2 (テンプレートリテラル) は Lexer の拡張が面白い（式埋め込みのトークン化）
- 3-3 → 3-4 はプロトタイプを先に入れないとクラスが作れない
- 3-5, 3-6 はパターンマッチ系で独立性が高い
- 3-7 (for...of) はイテレータの入り口だが、配列限定なら簡単
