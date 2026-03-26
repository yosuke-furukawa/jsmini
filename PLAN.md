# jsmini - 実装計画

## 背景と目的

browser-book（Part 02 / 第12章「JavaScript エンジン」）の執筆における解像度向上を目的として、
TypeScript で JavaScript エンジンを段階的に構築する。

browser-book 第12章では以下を解説している:

- パーサー（フルパース / プリパース）
- バイトコードジェネレータとインタプリタ
- JIT コンパイラの最適化（型推定、インライン化、hidden class、デッドコード除去、ループ最適化）
- 多層 JIT コンパイラ
- 脱最適化

jsmini では、これらの概念を **実際に動くコードとして体験する** ことで、
書籍の説明をより具体的・正確にすることを目指す。

---

## 技術スタック

- **言語**: TypeScript
- **テスト**: Test262 (ECMAScript 公式テストスイート)
- **パーサ方式**: 手書き再帰下降パーサ（パーサジェネレータは使わない）
- **初期方式**: Tree-walking interpreter → 後に Bytecode VM へ移行

---

## 実装ロードマップ

方針: **最小のパイプラインを最初に貫通させ、構文を一つずつ追加していく。**

### Step 1-1 [P0] 数値リテラルと四則演算

Lexer → Parser → Evaluator の全パイプラインを貫通させる最小実装。

- Lexer: 数値リテラル, 演算子 (`+`, `-`, `*`, `/`, `%`), 括弧 `()`, `;`
- Parser: 数値リテラル、二項演算式（演算子優先順位あり）、グループ化 `()`
- Evaluator: 式を評価して結果を返す

```javascript
// ゴール: これが動く
1 + 2 * 3       // => 7
(1 + 2) * 3     // => 9
10 % 3           // => 1
```

### Step 1-2 [P0] var と変数参照

- Lexer: 識別子, キーワード `var`, `=`
- Parser: VariableDeclaration, Identifier, AssignmentExpression
- Evaluator: Environment（変数の格納と参照）

```javascript
var x = 10;
var y = x + 5;   // => 15
```

### Step 1-3 [P0] 比較・論理演算 + if/else

- Lexer: `==`, `===`, `!=`, `!==`, `<`, `>`, `<=`, `>=`, `&&`, `||`, `!`
- Parser: BinaryExpression (比較), LogicalExpression, IfStatement
- Evaluator: boolean 型, 条件分岐
- 型: `true`, `false` リテラル

```javascript
var x = 10;
if (x > 5) {
  var y = 1;
} else {
  var y = 0;
}
```

### Step 1-4 [P1] while / for

- Parser: WhileStatement, ForStatement
- Evaluator: ループ実行

```javascript
var sum = 0;
var i = 0;
while (i < 5) {
  sum = sum + i;
  i = i + 1;
}
// sum => 10

for (var j = 0; j < 3; j = j + 1) {
  sum = sum + j;
}
```

### Step 1-5 [P1] 関数宣言・呼び出し・return

- Lexer: `function`, `return` キーワード
- Parser: FunctionDeclaration, CallExpression, ReturnStatement
- Evaluator: 関数オブジェクト、コールスタック、引数バインディング、スコープチェーン

```javascript
function add(a, b) {
  return a + b;
}
var result = add(3, 4);  // => 7
```

### Step 1-6 [P1] 文字列リテラル + console.log

- Lexer: 文字列リテラル (`"..."`, `'...'`)
- Parser: StringLiteral
- Evaluator: string 型, 文字列連結 (`+`), 組み込み `console.log`

```javascript
var name = "world";
console.log("hello " + name);  // => "hello world"
```

### Step 1 完了の判定基準

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

---

### Step 2-1 [P2] オブジェクトリテラル・プロパティアクセス

browser-book との対応: hidden class / インラインキャッシュの基盤。

- オブジェクトリテラル `{ key: value }`
- プロパティアクセス（ドット `obj.x` / ブラケット `obj["x"]`）
- プロパティ代入

```javascript
var point = { x: 10, y: 20 };
console.log(point.x + point.y);  // => 30
point.x = 100;
```

### Step 2-2 [P2] 配列

- 配列リテラル `[1, 2, 3]`
- インデックスアクセス `arr[0]`
- `.length` プロパティ

```javascript
var arr = [10, 20, 30];
console.log(arr[1]);      // => 20
console.log(arr.length);  // => 3
```

### Step 2-3 [P2] let / const・ブロックスコープ・クロージャ

- `let` / `const` 宣言
- ブロックスコープ（TDZ: Temporal Dead Zone）
- クロージャ（関数が外部変数をキャプチャ）

```javascript
let counter = 0;
function increment() {
  counter = counter + 1;
  return counter;
}
console.log(increment()); // 1
console.log(increment()); // 2
```

### Step 2-4 [P2] this・typeof・エラーハンドリング

- `this` キーワード（基本的なバインディングルール）
- `typeof` 演算子
- `try` / `catch` / `throw`、Error オブジェクト

---

### Step 3 [P3] モダン JavaScript

- アロー関数
- テンプレートリテラル
- 分割代入（基本）
- スプレッド / レスト演算子
- `for...of` ループ
- クラス構文
- プロトタイプチェーン

---

### Step 4 [P4] Bytecode VM 移行

browser-book との対応: 第12章「バイトコードジェネレータとインタプリタ」節。
`Ldar`, `Add`, `Return` のようなバイトコード命令を自分で設計・実装する。

- バイトコード命令セットの設計
- AST → Bytecode コンパイラ（BytecodeGenerator）
- スタックベース or レジスタベースの VM（Interpreter）
- 既存の tree-walking interpreter と同じセマンティクスを維持
- `--print-bytecode` 相当のデバッグ出力

```
# 目標: こういう出力ができる
function sum(a, b) { return a + b; }

Bytecode:
  0: Ldar a1
  1: Add a0, [0]
  2: Return
```

---

### Step 5 [P5] Wasm JIT — 最適化の体験

browser-book との対応: 第12章「JIT コンパイラ」「多層 JIT」「脱最適化」節。
**ホットコードを Wasm にコンパイルして実行する** ことで、JIT の仕組みを体験する。

TypeScript から Wasm バイナリ（バイト列）を手で組み立て、
`WebAssembly.instantiate()` で実行する。Node.js でもブラウザでも動く。

#### 5a. 型フィードバック収集

- 関数呼び出し時の引数型を統計情報として蓄積
- 呼び出し回数をカウントし、ホットコードを検出

#### 5b. Wasm コード生成

- ホットな関数のバイトコードを Wasm バイナリに変換するコンパイラ
- 最初は number 専用の算術関数のみ対象
- Wasm バイナリフォーマット（マジックナンバー、セクション、型、関数、コード）を手で組み立て

```
# 目標: ホットな関数が Wasm に変換される
function sum(a, b) { return a + b; }
// 100回呼び出し後 → Wasm モジュールを生成・実行に切り替え
```

#### 5c. 型特殊化と脱最適化

- number 型に特殊化した Wasm コードを生成（i32/f64 演算に直接マップ）
- 型推測が外れた場合（string が渡された等）、Wasm → Bytecode VM にフォールバック（脱最適化）
- 脱最適化の発生をログ出力し、可視化

#### 5d. 多層実行

最終的な実行パイプライン:

```
Source → Parser → AST → BytecodeCompiler → Bytecode
                                              ↓
                                    Bytecode VM (通常実行)
                                              ↓ (ホット判定)
                                    Wasm Compiler (型特殊化)
                                              ↓
                                    WebAssembly.instantiate() で高速実行
                                              ↓ (型推測ミス)
                                    脱最適化 → Bytecode VM に戻る
```

browser-book 第12章の多層 JIT（ベースライン → 中間層 → トップ層）を
Bytecode VM → Wasm の 2 層構成で再現する。

#### 5e. 発展機能（任意）

- インライン化（小さい関数を呼び出し元の Wasm に展開）
- Promise / async-await
- ジェネレータ
- モジュール (`import` / `export`)
- 正規表現

---

## 優先度まとめ

| 優先度 | ステップ | 内容 | ゴール |
|---|---|---|---|
| **P0** | 1-1 | 数値リテラル + 四則演算 | `1 + 2 * 3` → `7` |
| **P0** | 1-2 | `var` + 変数参照 | `var x = 10; x + 5` → `15` |
| **P0** | 1-3 | 比較・論理演算 + `if/else` | 条件分岐が動く |
| **P1** | 1-4 | `while` / `for` | ループが動く |
| **P1** | 1-5 | 関数宣言・呼び出し・`return` | 関数が動く |
| **P1** | 1-6 | 文字列リテラル + `console.log` | 結果を出力できる |
| **P2** | 2-1 | オブジェクト・プロパティアクセス | `{x:1}.x` が動く |
| **P2** | 2-2 | 配列 | `[1,2,3][0]` が動く |
| **P2** | 2-3 | `let`/`const`・クロージャ | ブロックスコープが動く |
| **P2** | 2-4 | `this`・`typeof`・`try/catch` | エラーハンドリングが動く |
| **P3** | 3 | モダン JS | アロー関数・クラス等 |
| **P4** | 4 | Bytecode VM 移行 | `--print-bytecode` が動く |
| **P5** | 5 | Wasm JIT | ホットコード → Wasm 生成・実行・脱最適化 |

---

## テスト戦略

### Test262 の導入

- テストスイート: https://github.com/tc39/test262
- ハーネス: https://github.com/nicknisi/test262-harness
- Step ごとに対応するテストカテゴリを段階的に有効化
- 準拠率を継続的にトラッキング

### Step 1 で対象とする Test262 カテゴリ

- `language/expressions/addition/`
- `language/expressions/subtraction/`
- `language/expressions/multiplication/`
- `language/expressions/division/`
- `language/expressions/comparison/`
- `language/statements/variable/`
- `language/statements/if/`
- `language/statements/while/`
- `language/statements/for/`
- `language/types/number/`
- `language/types/string/`
- `language/types/boolean/`

---

## プロジェクト構成

```
jsmini/
├── src/
│   ├── lexer/            # 字句解析器
│   │   ├── token.ts          # トークン型定義
│   │   └── lexer.ts          # Lexer 実装
│   ├── parser/           # 構文解析器
│   │   ├── ast.ts            # AST ノード型定義 (ESTree 互換)
│   │   └── parser.ts         # 再帰下降パーサ
│   ├── interpreter/      # Tree-Walking Interpreter (Step 1-3)
│   │   ├── environment.ts    # スコープ / 環境レコード
│   │   └── evaluator.ts      # AST 評価器
│   ├── vm/               # Bytecode VM (Step 4)
│   │   ├── bytecode.ts       # バイトコード命令定義
│   │   ├── compiler.ts       # AST → Bytecode コンパイラ
│   │   └── vm.ts             # VM (バイトコードインタープリタ)
│   └── index.ts          # エントリポイント (REPL / ファイル実行)
├── test/
│   ├── lexer/
│   ├── parser/
│   ├── interpreter/
│   └── test262/          # Test262 テストランナー
├── RESEARCH.md           # エンジンのリサーチ結果
├── PLAN.md               # この文書
├── package.json
└── tsconfig.json
```

---

## 実装フロー

```
Step 1-1: 数値 + 四則演算 (パイプライン貫通)
    ↓
Step 1-2: var + 変数
    ↓
Step 1-3: 比較・論理 + if/else
    ↓
Step 1-4: while / for
    ↓
Step 1-5: 関数
    ↓
Step 1-6: 文字列 + console.log
    ↓
Step 1-7: Test262 ハーネス導入・基本テスト通過
    ↓
Step 2: オブジェクト・配列・let/const・クロージャ
    ↓
Step 3: モダン JS (アロー関数・クラス・プロトタイプ)
    ↓
Step 4: Bytecode VM 移行
    ↓
Step 5: Wasm JIT (ホットコード → Wasm 生成・実行・脱最適化)
```
