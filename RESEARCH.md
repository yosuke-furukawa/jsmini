# jsmini - JavaScript Engine Research

TypeScript で段階的に構築する教育用 JavaScript エンジン。

## 目標

- ECMAScript 仕様に準拠した JavaScript エンジンを段階的に構築する
- 最初は tree-walking interpreter、後に bytecode VM へ移行する
- Test262 を使って仕様準拠を検証する

---

## 1. ECMAScript 仕様

### 参照先

- 仕様本体: https://tc39.es/ecma262/
- GitHub: https://github.com/tc39/ecma262
- Test262: https://github.com/tc39/test262

### エンジン実装に重要な仕様セクション

| セクション | 内容 | 重要度 |
|---|---|---|
| 6 - Data Types and Values | 8つの言語型 (undefined, null, boolean, string, symbol, number, bigint, object) | Phase 1 |
| 7 - Abstract Operations | 型変換、比較、オブジェクト操作 | Phase 1 |
| 12 - Lexical Grammar | トークン化: 識別子、キーワード、区切り文字、リテラル | Phase 1 |
| 13 - Expressions | 全ての式（識別子から代入まで） | Phase 1 |
| 14 - Statements and Declarations | 制御フロー、変数宣言、反復 | Phase 1 |
| 9 - Executable Code and Execution Contexts | 環境レコード、Realm、スコープチェーン | Phase 2 |
| 10 - Ordinary and Exotic Objects | `[[Get]]`, `[[Set]]`, `[[Call]]` 等の内部メソッド | Phase 2 |
| 15 - Functions and Classes | 関数定義、アロー関数、クラス構文 | Phase 2-3 |

---

## 2. 主要エンジンのアーキテクチャ

### V8 (Google / Chrome, Node.js)

言語: C++

```
Source → Scanner → Parser → AST → Ignition (bytecode) → Sparkplug → Maglev → TurboFan
```

- **Scanner** (`src/parsing/scanner.h`): UTF-16 文字ストリームからトークンを生成。ASCII 高速パス、キーワードの完全ハッシュ検出
- **Parser** (`src/parsing/parser.h`): CRTP ベースの `ParserBase` を Parser/PreParser で共有。再帰下降パーサ
- **Lazy parsing**: 即座に呼ばれない関数は PreParser でスキップし、初回呼び出し時にフルパース
- **Ignition**: レジスタベースのバイトコードインタープリタ。型フィードバックを収集
- **Sparkplug**: 非最適化ベースラインJIT（バイトコード→機械語を直接変換）
- **Maglev**: SSAベースのIRを使う中間層JIT
- **TurboFan**: Sea-of-Nodes IR を使う最適化JIT。インライン化、エスケープ解析、型特殊化

設計上の特徴:
- Hidden Classes (Maps/Shapes) による高速プロパティアクセス
- Inline Caches による型フィードバック
- 投機的最適化が外れた場合の Deoptimization (bailout)

### SpiderMonkey (Mozilla / Firefox)

言語: C++, Rust, JavaScript

```
Source → Parser → AST → BytecodeEmitter (Stencil形式) → Baseline Interpreter → Baseline JIT → WarpMonkey (Ion)
```

- **Stencil format**: GC フリーなバイトコード出力形式。オフスレッドパースが可能
- **Baseline Interpreter**: バイトコード実行 + Inline Cache によるプロファイリング
- **WarpMonkey (旧 IonMonkey)**: MIR → LIR → レジスタ割り当て → ネイティブコード生成

設計上の特徴:
- Inline Caches をインタープリタとコンパイラの両層で共有
- Shape ベースのオブジェクトモデル（V8 と類似）

### JavaScriptCore (Apple / Safari)

言語: C++, offlineasm（独自ポータブルアセンブリ）

```
Source → Lexer → Parser → Bytecode (AST を保持しない) → LLInt → Baseline JIT → DFG JIT → FTL JIT
```

- **特徴的設計**: パーサが AST を経由せず直接バイトコードを生成（メモリ節約）
- **LLInt**: offlineasm で記述されたポータブルインタープリタ
- **DFG**: データフローグラフベースの中間層JIT（~60回呼び出し後に発動）
- **FTL**: B3 バックエンドを使う最上位JIT（旧 LLVM）
- **双方向 OSR**: Baseline ↔ DFG 間で実行中にティアアップ/ベイルアウト

### 共通パターン

全ての主要エンジンに共通する設計:
1. **段階的コンパイル (Tiered Compilation)**: インタープリタ → ベースライン → 最適化JIT
2. **Inline Caches**: プロパティアクセスの型フィードバック
3. **Hidden Classes / Shapes**: オブジェクトのプロパティレイアウトの最適化
4. **Lazy Parsing**: 使われない関数のパースを遅延
5. **投機的最適化 + Deoptimization**: 型推測が外れたら安全にフォールバック

---

## 3. 小規模・教育用 JS エンジン

### 参考になるプロジェクト

| プロジェクト | 言語 | 方式 | 特徴 |
|---|---|---|---|
| [engine262](https://github.com/engine262/engine262) | TypeScript | Tree-walking | 仕様にほぼ1:1対応。TC39 提案の実験場。**最も参考になる** |
| [Boa](https://github.com/boa-dev/boa) | Rust | Bytecode VM | Test262 94%準拠。モジュラー設計（crate 分離） |
| [Nova](https://github.com/trynova/nova) | Rust | Bytecode VM | データ指向設計。Test262 80%準拠 |
| [QuickJS](https://bellard.org/quickjs/) | C | Bytecode VM | Fabrice Bellard 作。小さく完全な ES2023 対応 |
| [JerryScript](https://github.com/jerryscript-project/jerryscript) | C | Bytecode VM | IoT向け。<64KB RAM で動作。AST を保持しない |
| [Flathead](https://github.com/ndreynolds/flathead) | C | Tree-walking | 小さくポータブル |
| [TinyJS](https://github.com/nicknisi/tiny-js) | C++ | Tree-walking | 単一ファイル ~2000行 |

### jsmini にとっての最重要参考

- **engine262**: 同じ TypeScript、同じ tree-walking 方式。仕様の各セクションがコードに直接対応している
- **Boa**: bytecode VM 移行時の参考。Lexer/Parser/AST/ByteCompiler/VM が明確に分離
- **Crafting Interpreters** (Robert Nystrom 著): tree-walking → bytecode VM の両方をカバーする定番書籍

---

## 4. 参考資料

実装計画・プロジェクト構成は [PLAN.md](./PLAN.md) を参照。

### 書籍
- **Crafting Interpreters** (Robert Nystrom) — tree-walking → bytecode VM の両方をカバー

### 仕様・テスト
- ECMAScript 仕様: https://tc39.es/ecma262/
- Test262: https://github.com/tc39/test262
- Test262 ハーネス: https://github.com/nicknisi/test262-harness

### エンジンソースコード
- V8: https://chromium.googlesource.com/v8/v8.git
- SpiderMonkey: https://searchfox.org/mozilla-central/source/js/src
- JavaScriptCore: https://github.com/nicknisi/WebKit/tree/main/Source/JavaScriptCore
- engine262 (TypeScript, tree-walking): https://github.com/engine262/engine262
- Boa (Rust, bytecode VM): https://github.com/boa-dev/boa

### ドキュメント・記事
- V8 ドキュメント: https://v8.dev/docs
- SpiderMonkey: https://spidermonkey.dev/
- WebKit JSC: https://docs.webkit.org/Deep%20Dive/JSC/JavaScriptCore.html
- Andreas Kling の LibJS 開発動画シリーズ (YouTube)
