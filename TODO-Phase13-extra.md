# TODO Phase 13-extra — 構文拡大 (続き)

## 動機

Phase 13 で基本構文を一通り対応し、test262 29.6% → 32.0% まで来た。
残り 6,088 fail のうちパーサー起因が大半。簡単に稼げるものから潰して通過率を上げる。

## 完了済み (このブランチ)

- [x] getter/setter (`get x() {}`, `set x(v) {}`) — parser + TW + VM (AccessorDescriptor)
- [x] labeled break/continue — parser + TW + VM
- [x] class fields (`x = 1`, `static y = 2`) — parser + TW + VM
- [x] private fields (`#x`) — lexer + parser + TW + VM
- [x] computed property (`[expr]`) — parser + TW + VM (SetPropertyComputed)
- [x] default parameters (`function f(a = 1)`) — 前コミットで対応済み
- [x] test262 ハーネス拡充 — verifyProperty, assert_throws, compareArray

## 残りの fail 分析 (6,088件)

| カテゴリ | 件数 | 難易度 | メモ |
|---|---|---|---|
| generator `function*` / `yield` | 1,461 | **高** | 実行モデル大改造。coroutine/状態マシン |
| destructuring default `{a = 1}` | 862 | 中 | メソッドパラメータの分割代入デフォルト |
| missing builtin/method | 506 | 中 | 各種ビルトイン不足 |
| rest/spread `...` (関数パラメータ) | 277 | 中 | `function(...args)` のパース |
| unexpected semicolon (class ASI) | 211 | 低 | class body の ASI 処理 |
| 予約語をプロパティキーに | 190 | **低** | `{ return: 1 }` — 予約語をキーに許可 |
| eval | 156 | **高** | ランタイム全体へのアクセスが必要 |
| class expression | 128 | **低** | `var x = class {}` |
| parser: paren mismatch | 126 | 中 | 複雑なアロー関数パラメータ等 |
| unicode escape `\uXXXX` | ~200 | 中 | 識別子内のユニコードエスケープ |
| Symbol | 107 | 中 | Symbol, Symbol.iterator 等 |
| destructuring エッジケース | 89 | 中 | rest in destructuring 等 |
| arguments | 39 | 中 | Array-like + パラメータ連動が厄介 |
| string key in class | 33 | **低** | `class { "foo"() {} }` — 対応済みかも |

## ステップ

### パーサーだけで稼げる (低コスト)

- [x] 13-8: 予約語をプロパティキーに許可 (~190件) → +65件
  - `{ return: 1 }`, `obj.class`, `class { delete() {} }` 等
  - parsePropertyKey() で予約語を識別子として許可

- [x] 13-9: class expression (~128件) → 上記に含む
  - `var x = class {}`, `var x = class Foo {}`
  - parseClassBody() 抽出、ClassExpression を TW/VM 対応

### 中コスト

- [x] 13-10: rest/default in destructuring + function rest params → +432件
  - パーサー: [...rest], {...rest}, {a=1}, [x=5] in patterns
  - パーサー: cover grammar SpreadElement→RestElement, AssignmentExpr→AssignmentPattern
  - パーサー: arrow params で rest/destructuring/default 対応
  - TW: bindPattern defaultResolver, RestElement handling
  - VM: compileBindingTarget で RestElement (slice CallMethod) + AssignmentPattern
  - VM: hasRestParam フラグ, Call handler で args.slice

- [x] 13-11: unicode escape `\uXXXX` in identifiers → +196件
  - lexer: `\u0061` → `a`, `\u{62}` → `b` に変換

- [x] 13-12: 簡易 ASI → 上記参照

### 高コスト (やるかどうか要検討)

- [ ] 13-13: generator `function*` / `yield` (~1,461件)
  - 実行の中断・再開が必要
  - TW: GeneratorObject + next() で状態マシン
  - VM: フレームの保存/復元
  - 効果は最大だがコストも最大

- [x] 13-12: 簡易 ASI (ExpressionStatement, VariableDeclaration) → +67件
- [x] 13-14: Symbol (wrapper オブジェクト) + for-of iterator protocol → +74件
  - JSSymbol 型: `{ __symbol__: true, id, description, key }` で文字列と衝突しない
  - typeof Symbol() → "symbol", Symbol("x") === Symbol("x") → false
  - Well-known symbols: SYMBOL_ITERATOR 等 (.key = "@@iterator")
  - TW for-of: "@@iterator" キーで iterator protocol 対応
  - ネイティブ V8 Symbol に一切依存しない設計

- [ ] 13-15: eval (~156件)
  - parse + evaluate を実行時に呼ぶ
  - スコープチェーンのアクセスが複雑

## 目標

- 13-8 〜 13-9 で **33-34%** (パーサーだけ)
- 13-10 〜 13-12 まで含めて **36-37%**
- generator 対応で **50%超** が見える (1,461件は全体の16%)

## 現在の test262 結果

```
Total: 10,697 / Skip: 1,750 / 実行: 8,947
Pass:  3,819 VM (42.7%)
Fail:  5,128 VM

Phase 13-7 比: +1,169件, +13.1pt
```
