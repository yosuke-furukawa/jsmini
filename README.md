# jsmini

TypeScript で段階的に構築する教育用 JavaScript エンジン。

[browser-book](https://github.com/nicknisi/nicknisi-browser-book) Part 02 / 第12章「JavaScript エンジン」の執筆における解像度向上を目的として、Lexer, Parser, Tree-Walking Interpreter を一から実装しています。

## 特徴

- **手書きの再帰下降パーサ** (パーサジェネレータ不使用)
- **ESTree 準拠の AST**
- **Tree-Walking Interpreter** (将来 Bytecode VM、Wasm JIT に移行予定)
- **Test262** で仕様準拠を検証 (strict mode 前提)

## 対応している構文

### Phase 1 — 基本

- 数値・文字列・真偽値・null リテラル
- 四則演算、比較演算、論理演算、単項演算
- `var` 宣言、変数参照、代入 (ホイスティング対応)
- `if` / `else`、`while` / `for`
- 関数宣言、関数呼び出し、`return` (クロージャ、再帰対応)
- `console.log`

### Phase 2 — コア言語機能

- オブジェクトリテラル `{ key: value }`（ショートハンド対応）、ドット / ブラケットアクセス
- 配列リテラル `[1, 2, 3]`、インデックスアクセス、`.length`
- `let` / `const` (ブロックスコープ、TDZ、重複宣言エラー)
- `typeof`、`throw` / `try` / `catch` / `finally`
- `new` 演算子、組み込み `Error`
- `this` (メソッド呼び出し、コンストラクタ)
- 関数式 (`function` expression)

### Phase 3 — モダン JavaScript

- アロー関数 (`=>`)、レキシカル `this`
- テンプレートリテラル (`` `${expr}` ``、ネスト対応)
- プロトタイプチェーン (`Ctor.prototype`、`instanceof`)
- クラス (`class` / `extends` / `super`)
- 分割代入 (`var { x } = obj`、`var [a, b] = arr`、代入式でのカバー文法)
- スプレッド / レスト (`...`)
- `for...of`
- `++` / `--`、複合代入 (`+=` 等)
- `break` / `continue`
- `in` 演算子
- カンマ演算子
- Statement vs Declaration の区別

## Test262 準拠率

| 対象 | Pass | Fail | Skip | Total | Pass Rate |
|------|------|------|------|-------|-----------|
| 現在 | 225 | 591 | 25 | 841 | **27.6%** |

*Skip は noStrict (非厳格モード限定テスト) のみ。それ以外は全て実行。*

対象カテゴリ: `expressions/addition`, `expressions/subtraction`, `expressions/multiplication`, `expressions/division`, `statements/variable`, `statements/if`, `statements/while`, `statements/for`

## セットアップ

```bash
npm install
```

## Playground

ブラウザで試せます: https://yosuke-furukawa.github.io/jsmini/

## 使い方

### JS コードを実行

```bash
npm start -- '1 + 2 * 3;'
# => 7
```

```bash
npm start -- 'var add = (a, b) => a + b; console.log(add(3, 4));'
# => 7
```

### テストを実行

```bash
# ユニットテスト (272 tests)
npm test

# Test262
# 初回のみ test262 リポジトリの取得が必要:
git clone --depth 1 --filter=blob:none --sparse https://github.com/tc39/test262.git test262
cd test262 && git sparse-checkout set harness test/language/expressions/addition test/language/expressions/subtraction test/language/expressions/multiplication test/language/expressions/division test/language/statements/variable test/language/statements/if test/language/statements/while test/language/statements/for test/language/types && cd ..

npm run test262
```

## プロジェクト構成

```
src/
  lexer/
    token.ts            # トークン型定義
    lexer.ts            # 字句解析器
    lexer.test.ts
  parser/
    ast.ts              # ESTree 準拠 AST ノード定義
    parser.ts           # 再帰下降パーサ
    parser.test.ts
  interpreter/
    values.ts           # JS値の型定義、シグナル、プロトタイプヘルパー
    environment.ts      # スコープ / 環境レコード
    evaluator.ts        # Tree-Walking 評価器
    evaluator.test.ts   # Phase 1 テスト
    core.test.ts        # Phase 2 テスト
    features.test.ts    # Phase 3 テスト
  test262/
    runner.ts           # Test262 テストランナー
  index.ts              # エントリポイント
```

## ロードマップ

- [x] **Phase 1** — Lexer + Parser + 最小 Tree-Walking Interpreter
- [x] **Phase 2** — オブジェクト、配列、let/const、typeof、try/catch、new、this
- [x] **Phase 3** — アロー関数、テンプレートリテラル、クラス、分割代入、スプレッド/レスト、for...of
- [ ] **Phase 4** — Bytecode VM 移行
- [ ] **Phase 5** — Wasm JIT (ホットコード検出 → Wasm 生成 → 脱最適化)

詳細は [PLAN.md](./PLAN.md) を参照。

## 参考

- [ECMAScript 仕様](https://tc39.es/ecma262/)
- [ESTree](https://github.com/estree/estree) — AST 仕様
- [Test262](https://github.com/tc39/test262) — ECMAScript 公式テストスイート
- [engine262](https://github.com/engine262/engine262) — TypeScript 製 tree-walking JS エンジン
- [Crafting Interpreters](https://craftinginterpreters.com/) — Robert Nystrom
