# Crafting Interpreters — 要約

https://craftinginterpreters.com/contents.html

Robert Nystrom 著。言語処理系の実装を **2つのアプローチ** で解説する書籍。
対象言語は著者が設計した **Lox** という動的型付け言語。

---

## 書籍の構成

### Part I: Welcome（導入）

言語実装の全体像を俯瞰する。

| 章 | 内容 |
|---|---|
| 1. Introduction | 書籍の目的と構成 |
| 2. A Map of the Territory | **言語実装パイプラインの全体図**（下記参照） |
| 3. The Lox Language | 実装対象の Lox 言語の仕様定義 |

#### パイプライン（"山" のメタファー）

```
Source Code
  → Scanning (字句解析)        ─┐
  → Parsing (構文解析)          │ フロントエンド
  → Static Analysis (静的解析) ─┘
  → Intermediate Representation ─ ミドルエンド
  → Optimization (最適化)       ─┘
  → Code Generation (コード生成) ─┐
  → Virtual Machine              │ バックエンド
  → Runtime                     ─┘
```

#### 実装アプローチの分類

- **Single-pass compiler**: パースと生成を同時に行う（中間表現なし）
- **Tree-walk interpreter**: AST を直接走査して評価（Part II で実装）
- **Bytecode compiler**: バイトコードを生成し VM で実行（Part III で実装）
- **Transpiler**: 別言語のソースコードに変換
- **JIT compilation**: 実行時にネイティブコードを生成

#### Lox 言語の仕様

- **型**: Boolean, Number（倍精度浮動小数点）, String, Nil
- **演算子**: 算術 (`+`, `-`, `*`, `/`)、比較 (`<`, `<=`, `>`, `>=`)、等価 (`==`, `!=`)、論理 (`!`, `and`, `or`)
- **文**: `print`, `var`, ブロック `{}`, `if`/`else`, `while`, `for`
- **関数**: `fun` で宣言、第一級オブジェクト、クロージャ対応
- **クラス**: `init()`, `this`, 単一継承 (`<`)、`super`
- **標準ライブラリ**: `print` 文 と `clock()` のみ（最小限）

---

### Part II: A Tree-Walk Interpreter（Java で実装）

AST を直接走査して評価する方式。jsmini の **Phase 1-3** に直接対応する。

| 章 | 内容 | jsmini との対応 |
|---|---|---|
| 4. Scanning | Lexer の実装。文字列→トークン列 | Phase 1a: Lexer |
| 5. Representing Code | AST ノードの定義。Visitor パターン | Phase 1b: AST 定義 |
| 6. Parsing Expressions | 再帰下降パーサ。Pratt parsing の考え方 | Phase 1b: Parser |
| 7. Evaluating Expressions | AST を走査して式を評価 | Phase 1c: Evaluator |
| 8. Statements and State | 文の実行、変数宣言、Environment チェーン | Phase 1c: 変数・スコープ |
| 9. Control Flow | `if`, `while`, `for`, 論理演算子 | Phase 1c: 制御フロー |
| 10. Functions | 関数宣言・呼び出し、コールスタック、クロージャ | Phase 1c: 関数 |
| 11. Resolving and Binding | 変数解決（静的スコープの実装） | Phase 2: スコープ改善 |
| 12. Classes | クラス宣言、インスタンス、メソッド | Phase 3: クラス |
| 13. Inheritance | 継承、`super` | Phase 3: プロトタイプ |

**Design Notes（設計メモ）**:
- Ch.4: 暗黙のセミコロン（ASI）の是非
- Ch.6: 文法設計における論理 vs 歴史
- Ch.7: 静的型付け vs 動的型付け
- Ch.8: 暗黙の変数宣言の是非
- Ch.9: 構文糖の設計思想
- Ch.12: プロトタイプベース vs クラスベース

---

### Part III: A Bytecode Virtual Machine（C で実装）

同じ Lox 言語をバイトコード VM で再実装する。jsmini の **Phase 4** に直接対応する。

| 章 | 内容 | jsmini との対応 |
|---|---|---|
| 14. Chunks of Bytecode | バイトコード命令セットの設計、チャンク構造 | Phase 4: 命令セット設計 |
| 15. A Virtual Machine | VM のメインループ（fetch-decode-execute） | Phase 4: VM 実装 |
| 16. Scanning on Demand | オンデマンド Lexer（Part II とは異なる設計） | — |
| 17. Compiling Expressions | AST→バイトコードのコンパイル | Phase 4: Compiler |
| 18. Types of Values | VM における値の表現（tagged union / NaN boxing） | Phase 4: 値の表現 |
| 19. Strings | 文字列オブジェクトとメモリ管理 | Phase 4 |
| 20. Hash Tables | ハッシュテーブルの実装（プロパティ格納用） | Phase 4 |
| 21. Global Variables | グローバル変数の実装 | Phase 4 |
| 22. Local Variables | ローカル変数とスタック上の管理 | Phase 4 |
| 23. Jumping Back and Forth | 制御フロー命令（ジャンプ、ループ） | Phase 4 |
| 24. Calls and Functions | 関数呼び出し、CallFrame | Phase 4 |
| 25. Closures | Upvalue によるクロージャの実装 | Phase 4 |
| 26. Garbage Collection | Mark-and-sweep GC | Phase 5 |
| 27. Classes and Instances | クラスとインスタンスの VM 上での表現 | Phase 4 |
| 28. Methods and Initializers | メソッド呼び出し、bound method | Phase 4 |
| 29. Superclasses | 継承の VM 実装 | Phase 4 |
| 30. Optimization | NaN boxing、プロファイリング、最適化テクニック | Phase 5 |

**Design Notes（設計メモ）**:
- Ch.14: テスト駆動で言語を作る方法
- Ch.15: レジスタベース vs スタックベースのバイトコード
- Ch.19: 文字列エンコーディングの選択（UTF-8 / UTF-16 / UTF-32）
- Ch.25: ループ変数のクロージャ問題
- Ch.26: 世代別 GC の設計
- Ch.28: "Novelty Budget"（新規性の予算）

---

## 付録

- **Appendix I**: Lox の完全な文法定義（BNF）
- **Appendix II**: 自動生成される AST クラスの一覧

---

## jsmini にとっての活用ポイント

1. **Part II の章立てがそのまま Phase 1 の実装順序になる**: Scanning → AST → Parsing → Evaluating → Statements → Control Flow → Functions
2. **Part III の設計判断が Phase 4 の参考になる**: 特に Ch.14 (バイトコード設計)、Ch.15 (VM ループ)、Ch.18 (値の表現)
3. **Design Notes が設計判断の根拠を提供**: Lox と JavaScript の違いを意識しつつ、設計のトレードオフを理解できる
4. **Lox は JavaScript のサブセットに近い**: 動的型付け、クロージャ、クラス+継承。ただし Lox には `this` の複雑なバインディングルール、プロトタイプチェーン、`==` vs `===` などがない点が JavaScript との主な差分
