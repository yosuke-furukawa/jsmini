# TODO - Phase 1: Lexer + Parser + 最小 Tree-Walking Interpreter

PLAN.md の Step 1-1 〜 1-7 をタスク単位に分解したもの。
各タスクは上から順に実施する。チェックボックスで進捗を管理する。

---

## 0. プロジェクトセットアップ

- [x] `package.json` 作成 (`npm init`)
- [x] `tsconfig.json` 作成 (target: ES2022, module: Node16, strict: true)
- [x] テストフレームワーク導入 (Node.js 組み込み test runner)
- [x] `src/` ディレクトリ構成作成 (`lexer/`, `parser/`, `interpreter/`)
- [x] ビルド & 実行の動作確認 (`npx tsx src/index.ts`)

---

## 1-1. 数値リテラルと四則演算 [P0]

パイプライン貫通が最優先。Lexer → Parser → Evaluator を最小構成で繋ぐ。

### Lexer

- [x] `src/lexer/token.ts` — トークン型定義
  - TokenType (string literal union): `Number`, `Plus`, `Minus`, `Star`, `Slash`, `Percent`, `LeftParen`, `RightParen`, `Semicolon`, `EOF`
  - Token 型: `{ type: TokenType, value: string, line: number, column: number }`
- [x] `src/lexer/lexer.ts` — Lexer 実装
  - 入力: ソースコード文字列
  - 出力: Token 配列
  - 数値リテラルのスキャン (整数 + 小数)
  - 演算子のスキャン (`+`, `-`, `*`, `/`, `%`)
  - 括弧のスキャン (`(`, `)`)
  - セミコロン `;`
  - 空白・改行のスキップ
  - 不明な文字に対するエラー報告
- [x] `src/lexer/lexer.test.ts` — Lexer のテスト (コロケーション配置)
  - `"1 + 2"` → `[Number(1), Plus, Number(2), EOF]`
  - `"(1 + 2) * 3"` → 正しいトークン列
  - 空白や改行が無視されること

### Parser

- [x] `src/parser/ast.ts` — AST ノード型定義
  - `Program` (body: Statement[])
  - `ExpressionStatement` (expression: Expression)
  - `NumericLiteral` (value: number)
  - `BinaryExpression` (operator: string, left: Expression, right: Expression)
- [x] `src/parser/parser.ts` — 再帰下降パーサ
  - 演算子優先順位の処理 (優先度別の関数)
    - 低: `+`, `-`
    - 高: `*`, `/`, `%`
  - グループ化 `( expr )`
  - `ExpressionStatement` のパース
  - `Program` (複数の文) のパース
- [x] `src/parser/parser.test.ts` — Parser のテスト (コロケーション配置)
  - `"1 + 2 * 3"` → AST で `*` が `+` より深い位置にあること
  - `"(1 + 2) * 3"` → AST でグループ化が反映されること

### Evaluator

- [x] `src/interpreter/evaluator.ts` — Tree-Walking 評価器
  - `NumericLiteral` → number を返す
  - `BinaryExpression` → 左右を再帰評価して演算
  - `ExpressionStatement` → 式を評価
  - `Program` → 全文を順番に評価
- [x] `src/interpreter/evaluator.test.ts` — Evaluator のテスト (コロケーション配置)
  - `"1 + 2 * 3"` → `7`
  - `"(1 + 2) * 3"` → `9`
  - `"10 % 3"` → `1`

### 結合テスト

- [x] `src/index.ts` — エントリポイント (ソース文字列 → Lexer → Parser → Evaluator → 結果表示)
- [x] E2E テスト: `1 + 2 * 3` → `7` を確認済み

**マイルストーン: `1 + 2 * 3` が `7` を返す** ✅

---

## 1-2. var と変数参照 [P0]

### Lexer 拡張

- [x] TokenType 追加: `Identifier`, `Var` (キーワード), `Equals` (`=`)
- [x] 識別子のスキャン (先頭が英字 or `_`、以降は英数字 or `_`)
- [x] キーワード判定: `var` を Identifier と区別する
- [x] テスト追加: `"var x = 10;"` が正しくトークン化されること

### Parser 拡張

- [x] AST ノード追加:
  - `Identifier` (name: string)
  - `VariableDeclaration` (declarations: VariableDeclarator[])
  - `VariableDeclarator` (id: Identifier, init: Expression | null)
  - `AssignmentExpression` (operator: string, left: Identifier, right: Expression)
- [x] `var x = 10;` のパース
- [x] `x = x + 1;` (代入式) のパース
- [x] テスト追加

### Evaluator 拡張

- [x] `src/interpreter/environment.ts` — Environment クラス
  - `define(name, value)` — 変数定義
  - `get(name)` — 変数参照 (見つからなければエラー)
  - `set(name, value)` — 変数更新 (未定義ならエラー)
- [x] Evaluator に Environment を組み込み
  - `VariableDeclaration` → environment.define()
  - `Identifier` → environment.get()
  - `AssignmentExpression` → environment.set()
- [x] テスト追加: `var x = 10; var y = x + 5;` → `y` が `15`

**マイルストーン: `var x = 10; x + 5` が `15` を返す** ✅

---

## 1-3. 比較・論理演算 + if/else [P0]

### Lexer 拡張

- [x] TokenType 追加: `EqualEqual`, `EqualEqualEqual`, `BangEqual`, `BangEqualEqual`, `Less`, `Greater`, `LessEqual`, `GreaterEqual`, `AmpersandAmpersand`, `PipePipe`, `Bang`
- [x] 2文字トークンのスキャン (`==`, `===`, `!=`, `!==`, `<=`, `>=`, `&&`, `||`)
- [x] キーワード追加: `if`, `else`, `true`, `false`, `null`, `undefined`
- [x] TokenType 追加: `LeftBrace` (`{`), `RightBrace` (`}`)
- [x] テスト追加

### Parser 拡張

- [x] AST ノード追加:
  - `BooleanLiteral` (value: boolean)
  - `NullLiteral`
  - `UnaryExpression` (operator: string, argument: Expression) — `!` / `-` 用
  - `LogicalExpression` (operator: string, left: Expression, right: Expression)
  - `IfStatement` (test: Expression, consequent: Statement, alternate: Statement | null)
  - `BlockStatement` (body: Statement[])
- [x] 演算子優先順位: OR < AND < 等価 < 比較 < 加減 < 乗除 < 単項
- [x] `if (...) { ... } else { ... }` のパース
- [x] テスト追加

### Evaluator 拡張

- [x] boolean 型の評価
- [x] 比較演算子の評価 (`==`, `===`, `<`, `>` 等)
- [x] 論理演算子の評価 (`&&`, `||` — 短絡評価)
- [x] 単項 `!` の評価
- [x] `IfStatement` の評価
- [x] `BlockStatement` の評価
- [x] `null`, `undefined` リテラルの評価
- [x] テスト追加

**マイルストーン: `if (10 > 5) { ... } else { ... }` が正しく分岐する** ✅

---

## 1-4. while / for [P1]

### Parser 拡張

- [x] キーワード追加: `while`, `for`
- [x] AST ノード追加:
  - `WhileStatement` (test: Expression, body: Statement)
  - `ForStatement` (init, test, update, body)
- [x] `while (cond) { ... }` のパース
- [x] `for (init; test; update) { ... }` のパース（init は var 宣言 or 式 or 空）
- [x] テスト追加

### Evaluator 拡張

- [x] `WhileStatement` の評価 (条件が true の間 body を繰り返す)
- [x] `ForStatement` の評価 (init → [test → body → update] のループ)
- [x] ~~無限ループ対策~~ — 不要（Ctrl+C で対処）
- [x] テスト追加: `while` で合計を計算、`for` で合計を計算、ネスト

**マイルストーン: `while` と `for` で 0〜4 の合計 10 が計算できる** ✅

---

## 1-5. 関数宣言・呼び出し・return [P1]

### Lexer 拡張

- [x] キーワード追加: `function`, `return`
- [x] TokenType 追加: `Comma` (`,`) — 引数区切り用

### Parser 拡張

- [x] AST ノード追加:
  - `FunctionDeclaration` (id: Identifier, params: Identifier[], body: BlockStatement)
  - `CallExpression` (callee: Expression, arguments: Expression[])
  - `ReturnStatement` (argument: Expression | null)
- [x] 関数宣言のパース: `function name(a, b) { ... }`
- [x] 関数呼び出しのパース: `name(arg1, arg2)` — Primary の後に `(` が続けば CallExpression
- [x] `return expr;` のパース
- [x] テスト追加

### Evaluator 拡張

- [x] 関数オブジェクトの内部表現 (params, body, closure environment)
- [x] `FunctionDeclaration` → 関数ホイスティングで事前登録
- [x] `CallExpression` の評価:
  - 引数を評価
  - 新しい Environment を作成 (親 = 関数定義時のスコープ = クロージャ)
  - 仮引数に実引数をバインド（不足分は undefined）
  - body を評価（内部の var/function もホイスト）
- [x] `ReturnStatement` の処理 (ReturnSignal 例外で制御フローを中断)
- [x] テスト追加: `function add(a, b) { return a + b; } add(3, 4)` → `7`
- [x] テスト追加: 再帰関数 (factorial(5) → 120)

**マイルストーン: `function add(a, b) { return a + b; } add(3, 4)` が `7` を返す** ✅

---

## 1-6. 文字列リテラル + console.log [P1]

### Lexer 拡張

- [x] TokenType 追加: `String`
- [x] 文字列リテラルのスキャン (`"..."` と `'...'`)
- [x] エスケープシーケンス (`\"`, `\\`, `\n`, `\t`)
- [x] TokenType 追加: `Dot` (`.`) — MemberExpression 用
- [x] テスト追加

### Parser 拡張

- [x] AST ノード追加 (ESTree 準拠):
  - 文字列は `Literal` (value: string) で表現
  - `MemberExpression` (object: Expression, property: Identifier, computed: false)
- [x] 文字列リテラルのパース
- [x] `console.log(...)` のパース (MemberExpression + CallExpression)
- [x] テスト追加

### Evaluator 拡張

- [x] string 型の評価
- [x] `+` 演算子: 片方が string なら文字列連結
- [x] 組み込みオブジェクト `console` の用意 (グローバル環境に readOnly で登録)
- [x] `console.log` の実装 (ネイティブ関数として呼び出し)
- [x] `evaluate()` に `ConsoleOptions` を渡せるようにしてテスト可能に
- [x] テスト追加: `"hello " + "world"` → `"hello world"`
- [x] テスト追加: `console.log("hello")` が出力される

**マイルストーン: `console.log("hello " + "world")` が `hello world` を出力する** ✅

---

## 1-7. Test262 ハーネス導入 [P1]

- [x] `test262` を sparse clone で導入 (必要なディレクトリだけ取得)
- [x] `src/test262/runner.ts` — テストランナー作成
  - フロントマター (メタデータ) のパース
  - ハーネス関数 (Test262Error, assert, assert.sameValue) をネイティブ注入
  - 未対応構文のテストを自動スキップ
  - テスト実行 & 結果レポート
- [x] Step 1 対象カテゴリの Test262 テストを実行
  - `language/expressions/addition/`
  - `language/expressions/subtraction/`
  - `language/expressions/multiplication/`
  - `language/expressions/division/`
  - `language/statements/variable/`
  - `language/statements/if/`
  - `language/statements/while/`
  - `language/statements/for/`
- [x] 通過率を記録し、ベースラインを確立:
  - Total: 841, Pass: 6, Fail: 36, Skip: 799
  - **Pass rate: 14.3%** (実行可能テストのうち)
- [x] 失敗するテストを分析:
  - `eval` 未対応 (多数)
  - `Function` コンストラクタ未対応
  - 空文 `if (x);` 未対応
  - `let` 未対応
  - → Phase 2 以降で対応

---

## Phase 1 完了チェック

以下のプログラムが正しく動作すること:

```javascript
var x = 10;
var y = 20;

function add(a, b) {
  return a + b;
}

var result = add(x, y);
console.log(result); // 30

if (result > 25) {
  console.log("large");
} else {
  console.log("small");
}

var sum = 0;
for (var i = 0; i < 5; i = i + 1) {
  sum = sum + i;
}
console.log(sum); // 10
```

- [x] 上記プログラムを `src/index.ts` で実行し、期待出力を確認
  - `30` ✅
  - `large` ✅
  - `10` ✅
- [x] 全ユニットテストが通過 (107 tests)
- [x] Test262 ベースライン: 14.3% (6/42 実行可能テスト通過, 799 スキップ)
