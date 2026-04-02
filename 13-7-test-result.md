# Phase 13-7: test262 準拠率レポート

## 実行環境
- テスト対象: test262/test/language/ 配下 69 ディレクトリ
- Total: 10,697 files, Skip: 1,750 (module/async/raw/noStrict)
- 実行対象: 8,947 tests

## runner (test262/runner.ts) の結果

| モード | Pass | Fail | Rate |
|--------|------|------|------|
| TW     | 2,649 | 6,298 | 29.6% |
| VM     | 2,650 | 6,297 | 29.6% |
| JIT    | ≈2,650 | ≈6,297 | ≈29.6% (VM と同等 ※) |

※ JIT は 10,697 テストだと実行時間が長いため、以前の小規模テスト (1,216件) で
TW=VM=JIT が完全一致していることを確認済み。

## 直接比較の結果 (同一ハーネスで TW vs VM)

| | 件数 |
|---|---|
| Both pass | 2,572 |
| TW only pass | 51 |
| VM only pass | 16 |
| Both fail | 6,308 |

## TW only (51件) の内訳

TW で pass するが VM で fail するテスト。

- [object Object] (14件) — スコープ/toString: for-head-lex, try-catch scope 等
- Not a function (9件) — negative テストのエラー型差
- X is not defined (7件) — 関数内スコープの差
- Not a constructor (5件) — negative テストのエラー型差
- null/undef access (5件) — GetPropertyComputed の null チェック未対応
- Cannot convert (2件) — 残りの ToPrimitive 漏れ
- timeout (2件) — VM が遅くてタイムアウト
- その他 (7件)

## VM only (16件) の内訳

VM で pass するが TW で fail するテスト。

- Cannot convert object to primitive value (7件) — TW の ToPrimitive 未対応箇所
- Right-hand side of instanceof is not callable (5件) — TW の instanceof チェック
- その他 (4件)

## 共通 fail (6,308件) の主な原因

| 原因 | 件数 | 説明 |
|------|------|------|
| parse error (Unexpected...) | 2,466 | パーサーが未対応の構文 |
| Expected Identifier but got Eq/St/Do/Le | 1,279 | デフォルト引数 `=`, getter/setter 等 |
| X is not defined | 380 | ビルトイン未定義 (Symbol, Map, Set, Proxy 等) |
| not a function | 345 | メソッド呼び出しの解決失敗 |
| Expected LeftParen but got ... | 421 | 構文拡張が必要 |
| Expected Semicolon but got ... | 315 | for-of/arrow/labeled statement 等 |
| Invalid destructuring assignment | 71 | 分割代入のエッジケース |
| null/undef access | 47 | null/undefined のプロパティアクセス |
| [object Object] | 30 | toString/ToPrimitive の未対応箇所 |

## 改善のインパクト予測

最もインパクトが大きいもの:
1. **デフォルト引数** (`function f(x = 10)`) — ~593件 の fail に影響
2. **getter/setter** (`get x() {}`) — class/object 定義で頻出
3. **ビルトイン** (Symbol, Map, Set, Promise) — 380件の fail
4. **labeled statement** — for/while のラベル付き break/continue
5. **正規表現** — 一部のテストで使われる

## Phase 13 で追加した構文

- ternary `? :`
- switch/case/default
- do-while
- for-in
- bitwise (`&`, `|`, `^`, `~`) + shift (`<<`, `>>`, `>>>`)
- exponent `**`
- 0x/0b/0o 数値リテラル
- optional chaining `?.`
- nullish coalescing `??`

## Phase 13 で修正したバグ

- VM var/function hoisting
- VM for-of 分割代入
- VM 代入式の分割代入
- VM 関数パラメータの分割代入
- VM typeof が BytecodeFunction に "function" を返す
- VM ++/-- / == / != の ToPrimitive
- VM continue のジャンプ先パッチ
- VM TypeError (Not a function/constructor)
- VM null/undefined プロパティアクセスの unwindToHandler
- TW new ネイティブコンストラクタ
- TW == / != の ToPrimitive
- TW テンプレートリテラルの ToPrimitive
- TW/VM: Boolean, Number, String, Array, Function グローバル
