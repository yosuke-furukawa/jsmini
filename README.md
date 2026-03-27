# jsmini

TypeScript で段階的に構築する教育用 JavaScript エンジン。

[browser-book](https://github.com/yosuke-furukawa/browser-book) Part 02 / 第12章「JavaScript エンジン」の執筆における解像度向上を目的として、Lexer, Parser, Tree-Walking Interpreter, Bytecode VM を一から実装しています。

## 特徴

- **手書きの再帰下降パーサ** (パーサジェネレータ不使用)
- **ESTree 準拠の AST**
- **2つの実行エンジン**: Tree-Walking Interpreter と Bytecode VM
- **Test262** で仕様準拠を検証 (strict mode 前提)
- **`--print-bytecode`** で V8 の `node --print-bytecode` と同じ体験

## アーキテクチャ

```
Source Code
  → Lexer (字句解析)
    → Parser (構文解析, 再帰下降)
      → AST (ESTree 準拠)
        ├→ Tree-Walking Interpreter (AST を直接辿って評価)
        └→ Bytecode Compiler → Bytecode → Stack VM (命令列を順次実行)
```

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
- `for...of`、`++` / `--`、複合代入 (`+=` 等)
- `break` / `continue`、`in` 演算子、カンマ演算子

### Phase 4 — Bytecode VM

- スタックベースの VM（オペランドスタック + CallFrame）
- AST → バイトコードコンパイラ（パッチバック、ローカルスロット割り当て）
- `--print-bytecode` でバイトコードダンプ
- 例外ハンドラテーブルによる try/catch
- Phase 1〜3 の全構文に対応

### Phase 5 — Wasm JIT

- 型フィードバック収集 (`--print-feedback`)：callCount, argTypes (int32/uint32/f64), isMonomorphic
- ホットコード検出 → Wasm バイナリを手で組み立て → `WebAssembly.instantiate()`
- 型特殊化: int32 → `i32.add`, float → `f64.add`
- 脱最適化: 型推測が外れたら Bytecode VM にフォールバック
- 多層実行の可視化 (`--trace-tier`)

## パフォーマンス比較

V8-JIT を無効にした状態での純粋な jsmini の性能比較 (`npm run bench`):

| Benchmark | Tree-Walking | Bytecode VM | jsmini-JIT (Wasm) |
|-----------|-------------|-------------|-------------------|
| fibonacci(25) | 757ms | 709ms (1.07x) | — |
| for loop sum (10K) | 21ms | 32ms (0.64x) | — |
| hot add (10K calls) | 43ms | 55ms (0.79x) | 47ms (0.91x) |
| nested loop (100x100) | 22ms | 30ms (0.71x) | — |

*V8-JIT を有効にすると Bytecode VM が 2〜3x 速くなるが、それは V8 の TurboFan が jsmini の VM ループを最適化しているため。詳細は [LEARN-JIT.md](./LEARN-JIT.md) を参照。*

## Test262 準拠率

| エンジン | Pass | Fail | Skip | Total | Pass Rate |
|----------|------|------|------|-------|-----------|
| Tree-Walking | 225 | 591 | 25 | 841 | **27.6%** |
| Bytecode VM | 225 | 591 | 25 | 841 | **27.6%** |

*両エンジンで同一の結果。Skip は noStrict (非厳格モード限定テスト) のみ。*

## セットアップ

```bash
npm install
```

## Playground

ブラウザで試せます: https://yosuke-furukawa.github.io/jsmini/

## 使い方

### JS コードを実行

```bash
# Tree-Walking (デフォルト)
npm start -- '1 + 2 * 3;'

# Bytecode VM
npm start -- --vm '1 + 2 * 3;'
```

### バイトコードダンプ

```bash
npm start -- --print-bytecode 'function add(a, b) { return a + b; }'
```

```
== <script> (params: 0, locals: 0) ==
  0000: LdaConst         0 ; <function add>
  0001: StaGlobal        1 ; add
  0002: Pop

== add (params: 2, locals: 2) ==
  0000: LdaLocal         0
  0001: LdaLocal         1
  0002: Add
  0003: Return
```

### JIT

```bash
# JIT 有効で実行
npm start -- --jit 'function add(a,b){return a+b;} for(var i=0;i<200;i=i+1){add(i,1);}'

# 型フィードバック表示
npm start -- --print-feedback 'function add(a,b){return a+b;} for(var i=0;i<100;i=i+1){add(i,1);}'

# 多層実行トレース
npm start -- --trace-tier 'function add(a,b){return a+b;} for(var i=0;i<110;i=i+1){add(i,1);} add("a","b");'
```

### テストを実行

```bash
# ユニットテスト (379 tests)
npm test

# ベンチマーク
npm run bench

# Test262
# 初回のみ test262 リポジトリの取得が必要:
git clone --depth 1 --filter=blob:none --sparse https://github.com/tc39/test262.git test262
cd test262 && git sparse-checkout set harness test/language/expressions/addition test/language/expressions/subtraction test/language/expressions/multiplication test/language/expressions/division test/language/statements/variable test/language/statements/if test/language/statements/while test/language/statements/for test/language/types && cd ..

npm run test262            # tree-walking
npm run test262 -- --vm    # bytecode VM
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
  vm/
    bytecode.ts         # Opcode 定義、命令型、disassembler
    compiler.ts         # AST → バイトコードコンパイラ
    vm.ts               # スタックベース VM
    vm.test.ts          # VM テスト
    compat.test.ts      # Tree-Walking と VM の互換テスト
    index.ts            # vmEvaluate() エントリポイント
  test262/
    runner.ts           # Test262 テストランナー (--vm 対応)
  bench.ts              # ベンチマーク
  index.ts              # CLI エントリポイント (--vm, --print-bytecode)
```

## ロードマップ

- [x] **Phase 1** — Lexer + Parser + 最小 Tree-Walking Interpreter
- [x] **Phase 2** — オブジェクト、配列、let/const、typeof、try/catch、new、this
- [x] **Phase 3** — アロー関数、テンプレートリテラル、クラス、分割代入、スプレッド/レスト、for...of
- [x] **Phase 4** — Bytecode VM (スタックベース、`--print-bytecode`)
- [x] **Phase 5** — Wasm JIT (型フィードバック → 型特殊化 → 脱最適化、[学んだこと](./LEARN-JIT.md))

詳細は [PLAN.md](./PLAN.md) を参照。

## 参考

- [ECMAScript 仕様](https://tc39.es/ecma262/)
- [ESTree](https://github.com/estree/estree) — AST 仕様
- [Test262](https://github.com/tc39/test262) — ECMAScript 公式テストスイート
- [engine262](https://github.com/engine262/engine262) — TypeScript 製 tree-walking JS エンジン
- [Crafting Interpreters](https://craftinginterpreters.com/) — Robert Nystrom
