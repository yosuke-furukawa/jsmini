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

- [ ] 13-8: 予約語をプロパティキーに許可 (~190件)
  - `{ return: 1 }`, `obj.class`, `class { delete() {} }` 等
  - パーサーの `parseIdentifier` を拡張するだけ

- [ ] 13-9: class expression (~128件)
  - `var x = class {}`, `var x = class Foo {}`
  - `parseExpression` で `Class` トークンを式として扱う

### 中コスト

- [ ] 13-10: rest parameters in function (`...args`) (~277件)
  - パーサー: 関数パラメータの最後に `...ident` を許可
  - TW: `arguments` 的な配列を作る
  - VM: locals の最後のスロットに残り引数を配列化

- [ ] 13-11: unicode escape `\uXXXX` in identifiers (~200件)
  - lexer: `\u0061` → `a` に変換

- [ ] 13-12: class body ASI 改善 (~211件)
  - セミコロンなしのフィールド宣言が次のメソッドと衝突

### 高コスト (やるかどうか要検討)

- [ ] 13-13: generator `function*` / `yield` (~1,461件)
  - 実行の中断・再開が必要
  - TW: GeneratorObject + next() で状態マシン
  - VM: フレームの保存/復元
  - 効果は最大だがコストも最大

- [ ] 13-14: Symbol (~107件)
  - Symbol.iterator で for-of カスタムイテレータ
  - Well-known symbols の一部だけ対応でも効果あり

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
Pass:  2,859 (32.0%)
Fail:  6,088
```
