# TODO - Phase 2: コア言語機能

PLAN.md の Step 2-1 〜 2-4 をタスク単位に分解したもの。
Phase 1 で構築した Lexer → Parser → Tree-Walking Evaluator に機能を追加していく。

---

## 2-1. オブジェクトリテラル・プロパティアクセス [P2]

browser-book との対応: hidden class / インラインキャッシュの基盤。

### Lexer 拡張

- [x] TokenType 追加: `Colon` (`:`) — オブジェクトリテラルのキーバリュー区切り
- [x] テスト追加

### Parser 拡張

- [x] AST ノード追加:
  - `ObjectExpression` (properties: Property[])
  - `Property` (key: Identifier | Literal, value: Expression, kind: "init")
  - `MemberExpression.property` を `Expression` に拡張、`computed: boolean` に変更
- [x] `MemberExpression` の `computed` 対応 (`obj["x"]` → computed: true)
- [x] オブジェクトリテラル `{ key: value, ... }` のパース（識別子/文字列/数値キー、trailing comma 対応）
- [x] ブラケット記法 `obj["key"]` のパース (`LeftBracket`, `RightBracket` トークン追加)
- [x] `MemberExpression` への代入 `obj.x = 10` のパース (`AssignmentExpression.left` を `Identifier | MemberExpression` に拡張)
- [x] テスト追加
- [x] Codex レビュー済み（数値キー未対応を指摘→修正済み）

### Evaluator 拡張

- [x] `ObjectExpression` の評価 → JS の plain object を生成
- [x] `MemberExpression` (computed: true) の評価
- [x] `MemberExpression` への代入の評価（評価順: LHS→RHS、ECMAScript 準拠）
- [x] `resolveMemberKey` ヘルパーで読み取り/代入のキー解決を共通化
- [x] テスト追加（ドット/ブラケット読み書き、undefined プロパティ、ネスト、変数キー、数値キー）
- [x] Codex レビュー済み（評価順の仕様違反を指摘→修正済み、キー解決重複→共通化済み）

```javascript
// ゴール
var point = { x: 10, y: 20 };
console.log(point.x + point.y);  // 30
point.x = 100;
console.log(point.x);            // 100
console.log(point["y"]);         // 20
```

**マイルストーン: `{ x: 10, y: 20 }` のドット/ブラケットアクセス・代入が動く**

---

## 2-2. 配列 [P2]

### Lexer 拡張

- [x] TokenType 追加: `LeftBracket` (`[`), `RightBracket` (`]`) — Step 2-1 で追加済み

### Parser 拡張

- [x] AST ノード追加:
  - `ArrayExpression` (elements: Expression[])
- [x] 配列リテラル `[expr, expr, ...]` のパース（trailing comma 対応）
- [x] カンマ欠落 `[1 2]` のエラー検出
- [x] テスト追加

### Evaluator 拡張

- [x] `ArrayExpression` の評価 → JS の配列を生成
- [x] 配列インデックスアクセス `arr[0]` — `MemberExpression` (computed: true) で対応済み
- [x] `.length` プロパティ — ドットアクセスで対応済み
- [x] 配列インデックスへの代入 `arr[0] = 10`
- [x] テスト追加（基本、index、length、代入、変数index、式index、範囲外、ネスト、forループ走査）
- [x] Codex レビュー済み（カンマ欠落の誤受理を指摘→修正済み）

```javascript
// ゴール
var arr = [10, 20, 30];
console.log(arr[1]);      // 20
console.log(arr.length);  // 3
arr[0] = 99;
console.log(arr[0]);      // 99
```

**マイルストーン: 配列リテラル・インデックスアクセス・`.length` が動く**

---

## 2-3. let / const・ブロックスコープ・クロージャ [P2]

### Lexer 拡張

- [x] キーワード追加: `let`, `const`

### Parser 拡張

- [x] `VariableDeclaration.kind` を `"var" | "let" | "const"` に拡張
- [x] `let` / `const` 宣言のパース
- [x] `const` の初期化なしを SyntaxError に
- [x] `for (let/const ...)` のパース対応
- [x] テスト追加

### Evaluator 拡張

- [x] `BlockStatement` で新しい子 Environment を作成（ブロックスコープ）
- [x] `var` は `findVarScope()` で関数/グローバルスコープに定義（ブロックを貫通）
- [x] `let` の評価: ブロックスコープに define
- [x] `const` の評価: `defineConst()` で再代入時に TypeError
- [x] TDZ (Temporal Dead Zone): `declareTDZ()` で事前登録、初期化前アクセスで ReferenceError
- [x] 同一スコープの `let`/`const` 重複宣言を SyntaxError に
- [x] クロージャが `let` 変数を正しくキャプチャすること
- [x] `for (let ...)` でスコープを分離（ループ外からアクセス不可）
- [x] テスト追加
- [x] Codex レビュー済み（var ホイスティングの has→hasOwn 修正、const 初期化必須、重複宣言チェック追加）

```javascript
// ゴール
let x = 1;
{
  let x = 2;
  console.log(x);  // 2
}
console.log(x);    // 1

const y = 10;
// y = 20;  // TypeError

// クロージャ
var counter = 0;
function increment() {
  counter = counter + 1;
  return counter;
}
console.log(increment()); // 1
console.log(increment()); // 2
```

**マイルストーン: `let` のブロックスコープ、`const` の再代入禁止、TDZ が動く**

---

## 2-4. this・typeof・エラーハンドリング [P2]

### 2-4a. typeof 演算子

- [x] Lexer: キーワード `typeof` 追加
- [x] Parser: `UnaryExpression` で `typeof` をパース
- [x] Evaluator: `typeof` の評価（全型対応、未定義変数は "undefined"、TDZ は ReferenceError）
- [x] 関数判定に `JS_FUNCTION_BRAND` シンボルを使用（誤検知防止）
- [x] テスト追加
- [x] Codex レビュー済み（TDZ 区別、関数判定改善）

```javascript
console.log(typeof 42);        // "number"
console.log(typeof "hello");   // "string"
console.log(typeof undefined); // "undefined"
console.log(typeof null);      // "object"
console.log(typeof notDefined); // "undefined" (エラーにならない)
```

### 2-4b. throw / try / catch

- [x] Lexer: キーワード `throw`, `try`, `catch`, `finally` 追加
- [x] Parser: AST ノード追加 (ThrowStatement, TryStatement, CatchClause)
- [x] Parser: `try {}` だけ (catch/finally なし) を SyntaxError に
- [x] Evaluator: `throw` → ThrowSignal、`catch` で捕捉（ReferenceError 等も捕捉可）
- [x] Evaluator: `finally` は常に実行（catch 内例外時も）
- [x] Evaluator: catch なし try-finally で throw は再 throw
- [x] catch の変数は子スコープに閉じる
- [x] テスト追加
- [x] Codex レビュー済み（catch なし握りつぶし、finally 未実行、ReferenceError 捕捉、try{} エラー — 全修正済み）

```javascript
// ゴール
try {
  throw "error";
} catch (e) {
  console.log(e);  // "error"
}
```

### 2-4c. new 演算子と Error オブジェクト

- [x] Lexer: キーワード `new` 追加
- [x] Parser: `NewExpression` 追加（Primary + Arguments のみ、new 後の MemberExpression チェーンは分離）
- [x] Parser: `FunctionExpression`（名前付き/無名）追加
- [x] Evaluator: `new` の評価（新オブジェクト作成 → this バインド → コンストラクタ実行）
- [x] Evaluator: コンストラクタのオブジェクト return → 使う、プリミティブ return → this を使う
- [x] 組み込み `Error` コンストラクタ（`{ message }` を返す）
- [x] 非関数呼び出しで TypeError を明示
- [x] テスト追加
- [x] Codex レビュー済み（new Foo().bar 解釈修正、非関数 TypeError 追加）

```javascript
try {
  throw new Error("something went wrong");
} catch (e) {
  console.log(e.message);  // "something went wrong"
}
```

### 2-4d. this キーワード (基本)

- [x] Lexer: キーワード `this` 追加
- [x] Parser: `ThisExpression` 追加
- [x] Evaluator: `this` の評価（Environment.getThis()）
- [x] メソッド呼び出し `obj.method()` で `this` が `obj` を指す（CallExpression で MemberExpression の場合に thisValue をバインド）
- [x] 通常の関数呼び出しでは `this` は `undefined`
- [x] `new` 時は `this` が新オブジェクトを指す
- [x] テスト追加

```javascript
var obj = { x: 10 };
// this の詳細なバインディングルールは Phase 3 (クラス) で拡充
```

**マイルストーン: `typeof`, `try/catch/throw`, `new Error()`, 基本的な `this` が動く**

---

## Phase 2 完了チェック

以下のプログラムが正しく動作すること:

```javascript
var point = { x: 10, y: 20 };
console.log(point.x + point["y"]); // 30

var arr = [1, 2, 3];
console.log(arr.length); // 3

let count = 0;
function inc() {
  count = count + 1;
  return count;
}
console.log(inc()); // 1
console.log(inc()); // 2

{
  let count = 99;
  console.log(count); // 99
}
console.log(count); // 2

console.log(typeof "hello"); // "string"
console.log(typeof 42);      // "number"

try {
  throw new Error("oops");
} catch (e) {
  console.log(e.message); // "oops"
}
```

- [x] 上記プログラムの期待出力を確認 ✅
  - `30`, `3`, `1`, `2`, `99`, `2`, `string`, `number`, `oops`
- [x] 全ユニットテストが通過 (187 tests)
- [x] Test262: Pass 9/42 (21.4%) ← Phase 1 の 14.3% から改善

---

## 実装順序

```
Step 2-1: オブジェクトリテラル・プロパティアクセス
    ↓
Step 2-2: 配列
    ↓
Step 2-3: let / const・ブロックスコープ
    ↓
Step 2-4a: typeof
    ↓
Step 2-4b: throw / try / catch
    ↓
Step 2-4c: new + Error
    ↓
Step 2-4d: this (基本)
    ↓
Test262 再実行・通過率更新
```
