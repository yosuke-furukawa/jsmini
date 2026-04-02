# TODO Phase 13-extra — 構文拡大 (続き)

## 動機

Phase 13 で基本構文を一通り対応し、test262 29.6% → 44.3% (VM) まで来た。
残りの fail のうちパーサー起因が大半。簡単に稼げるものから潰して通過率を上げた。

## 完了済み (このブランチ)

### パーサー + 基本構文
- [x] getter/setter (`get x() {}`, `set x(v) {}`) — parser + TW + VM (AccessorDescriptor)
- [x] labeled break/continue — parser + TW + VM
- [x] class fields (`x = 1`, `static y = 2`) — parser + TW + VM
- [x] private fields (`#x`) — lexer + parser + TW + VM
- [x] computed property (`[expr]`) — parser + TW + VM (SetPropertyComputed)
- [x] default parameters (`function f(a = 1)`) — 前コミットで対応済み
- [x] test262 ハーネス拡充 — verifyProperty, assert_throws, compareArray

### 低コスト (パーサー中心)
- [x] 13-8: 予約語をプロパティキーに許可 → +65件
- [x] 13-9: class expression (`var x = class {}`) → 上記に含む
- [x] 13-12: 簡易 ASI (ExpressionStatement, VariableDeclaration) → +67件

### 中コスト
- [x] 13-10: rest/default in destructuring + function rest params → +432件
- [x] 13-11: unicode escape `\uXXXX` / `\u{XXXX}` in identifiers → +196件

### 高コスト
- [x] 13-13: generator `function*` / `yield` → +146件 (VM)
  - **VM**: Yield opcode + フレーム保存・復元 (GeneratorObject)
  - **TW**: engine262 スタイル — evaluator 全体を `function*` に変換、ホスト yield で中断
  - for-of: GetIterator/IteratorNext/IteratorComplete/IteratorValue 専用バイトコード
  - 両方の実装を対比して紹介（本の章として最高の教材）

- [x] 13-14: Symbol (wrapper オブジェクト) + iterator protocol → +74件
  - JSSymbol 型: `{ __symbol__: true, id, description, key }`
  - typeof Symbol() → "symbol", Symbol("x") === Symbol("x") → false
  - ネイティブ V8 Symbol に一切依存しない設計

## 未対応 (別ブランチで検討)

- [ ] ビルトイン自前実装 — VM が V8 ネイティブの Array/String 等に委譲している問題
  - `vm.setGlobal("Array", Array)` 等をやめて自前の Array コンストラクタに
  - Array.prototype.map/filter/reduce 等を jsmini の関数として実装
  - VM と TW の test262 差 (284件) の主因
  - 教育用エンジンとしてはネイティブ委譲はズルなので修正すべき

- [ ] eval (~156件) — parse + evaluate を実行時に呼ぶ
- [ ] yield* 委譲 — generator の yield* expr
- [ ] generator.throw() — generator にエラーを送り込む
- [ ] arguments オブジェクト (~39件) — Array-like + パラメータ連動

## 現在の test262 結果

```
Total: 10,697 / Skip: 1,750 / 実行: 8,947
TW:  3,680 (41.1%)
VM:  3,964 (44.3%)

Phase 13-7 比: VM +1,314件, +14.7pt
```
