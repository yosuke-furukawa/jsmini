# TODO Phase 15 — 構文対応拡大 + test262 パス率向上

## 動機

test262 の失敗パターンを分析すると、少数の未実装構文が大量のテスト失敗を引き起こしている。
残りの未実装構文にフォーカスして test262 パス率を引き上げる。

## 現状

```
test262 VM:  4,531 / 8,947 (50.6%)
test262 TW:  4,592 / 8,947 (51.3%)
```

## 完了済み

### 15-1: Generator メソッド ✅

- [x] 15-1a: オブジェクトリテラルの generator メソッド (`{ *gen() { yield 1; } }`)
- [x] 15-1b: クラスの generator メソッド (`class C { *gen() { yield 1; } }`)
- [x] 15-1c: computed + generator (`{ *[expr]() {} }`)
- [x] 15-1d: テスト追加 (3 cases) + TW/VM 両対応
  - VM の CallMethod に generator チェックが抜けていたのを修正

### 15-2: `arguments` オブジェクト ✅

- [x] 15-2a: 基本の arguments (array-like: arguments[i], arguments.length)
  - TW: evalCallExpression の通常パス・generator パス・evalCallWithJSFunction の3箇所
  - VM: compileFunctionBody でパラメータ後にローカルスロット予約、setArguments() ヘルパー
- [x] 15-2b: アロー関数ではレキシカル (arguments を設定しない)

### 15-ex: 追加で実装した項目 ✅

- [x] Function.name プロパティ (TW: 全関数生成箇所 + 変数名推論, VM: inferredName)
- [x] Function.prototype.call/apply/bind (TW + VM)
- [x] 空文 (`;`) パース対応 (EmptyStatement)
- [x] 先頭ドット小数リテラル (`.1`, `.5e2`)
- [x] delete / void 演算子 (TW + VM)
- [x] ToPrimitive: ネイティブ関数 valueOf/toString 対応 (VM)
- [x] StringCtor: JSString 引数の変換 (TW)
- [x] GetPropertyComputed: prototype chain 対応 (VM)
- [x] 配列分割代入: Iterator Protocol 対応 (TW + VM)
- [x] test262 ハーネス: assert オブジェクト形式化 + assert.throws 型チェック + エラーメッセージ改善

### 15-3: `void` 演算子 ✅ (15-ex に含む)

### 15-4: `delete` 演算子 ✅ (15-ex に含む)

## 残りのステップ

### 15-5: `eval()` 基本サポート

141 テスト (VM) / 162 テスト (TW) が直接 `eval` に依存。

- [ ] 15-5a: indirect eval (`(0, eval)(code)` — グローバルスコープで実行)
- [ ] 15-5b: direct eval (`eval(code)` — 現在のスコープで実行)
- [ ] 15-5c: テスト追加 + test262 検証

### 15-6: tagged template literals

- [ ] 15-6a: パーサ (TaggedTemplateExpression)
- [ ] 15-6b: TW + VM 評価
- [ ] 15-6c: テスト追加 + test262 検証

## 目標

```
test262 VM:  41.9% → 50.6% ✅ (達成済み)
test262 TW:  41.1% → 51.3% ✅ (達成済み)
```
