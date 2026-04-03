# TODO Phase 15 — 構文対応拡大 + test262 パス率向上

## 動機

test262 の失敗パターンを分析すると、少数の未実装構文が大量のテスト失敗を引き起こしている。
特に dstr (destructuring) ディレクトリが ~2,861 件の失敗を占めるが、
関数パラメータ分割代入・デフォルトパラメータ・ラベル文・typeof 未定義変数は既に実装済み。

残りの未実装構文にフォーカスして test262 パス率を引き上げる。

## 現状

```
test262 VM:  3,746 / 8,947 (41.9%)
test262 TW:  3,680 / 8,947 (41.1%)
差: 66件
```

### 実装済み (確認済み)
- 関数パラメータの分割代入 (`function f({a, b}) {}`, `function f([x, y]) {}`)
- デフォルトパラメータ (`function f(a = 1) {}`)
- ラベル文 (`label: for (...) { break label; }`)
- `typeof` 未定義変数 → `"undefined"` (ReferenceError にならない)

### 未実装
- Generator メソッド (object/class 内の `*method()`)
- `arguments` オブジェクト
- `eval()`
- `void` 演算子
- tagged template literals

## ステップ

### 15-1: Generator メソッド

オブジェクトリテラルとクラスでの generator メソッド構文が未対応。
パーサが `*` を見て SyntaxError になり、~575 件のテストが落ちている。
`function* gen()` (宣言/式) は既に対応済み。メソッド構文だけ足りない。

- [ ] 15-1a: オブジェクトリテラルの generator メソッド (`{ *gen() { yield 1; } }`)
  - パーサ: プロパティ解析で `*` トークンを検出 → メソッド定義に generator フラグ
  - AST: Property に generator: true
  - TW: 関数生成時に generator フラグを伝播
  - VM: コンパイラで generator フラグ対応

- [ ] 15-1b: クラスの generator メソッド (`class C { *gen() { yield 1; } }`)
  - パーサ: クラスメソッド解析で `*` トークン対応
  - AST: MethodDefinition に generator: true

- [ ] 15-1c: computed + generator (`{ *[expr]() {} }`)

- [ ] 15-1d: テスト追加 + test262 検証

**想定インパクト: ~500-700 テスト**

### 15-2: `arguments` オブジェクト

多くのテストが暗黙的に `arguments` に依存。

- [ ] 15-2a: 基本の `arguments` オブジェクト
  - 関数呼び出し時に `arguments` を自動バインド
  - array-like: `arguments[i]`, `arguments.length`
  - TW: Environment に arguments を設定
  - VM: 関数フレームに arguments を設定

- [ ] 15-2b: アロー関数ではレキシカル (外側の arguments を参照)

- [ ] 15-2c: `arguments` と rest パラメータの排他 (rest がある場合は arguments 不要)

- [ ] 15-2d: テスト追加 + test262 検証

**想定インパクト: ~100-200 テスト**

### 15-3: `eval()` 基本サポート

141 テストが直接 `eval` に依存。test262 ハーネスでも間接的に使われる。

- [ ] 15-3a: indirect eval (`(0, eval)(code)` — グローバルスコープで実行)
  - parse + evaluate をグローバル環境で呼び出すだけ
  - test262 ハーネスの `$262.evalScript()` もこれで動く

- [ ] 15-3b: direct eval (`eval(code)` — 現在のスコープで実行)
  - 呼び出し元の Environment を渡して parse + evaluate
  - TW: 現在の env を渡す
  - VM: eval 内は TW にフォールバック (or VM でコンパイル)

- [ ] 15-3c: テスト追加 + test262 検証

**想定インパクト: ~150-250 テスト**

### 15-4: `void` 演算子

- [ ] 15-4a: パーサ + 評価器
  - `void expr` → expr を評価して `undefined` を返す
  - Lexer: `void` キーワード追加
  - Parser: UnaryExpression で `void` 対応
  - TW + VM: 式を評価して結果を捨て、undefined を返す

**想定インパクト: ~20-50 テスト**

### 15-5: tagged template literals

- [ ] 15-5a: パーサ
  - `tag\`hello ${x}\`` → TaggedTemplateExpression AST ノード
  - tag: 関数式、quasi: テンプレートリテラル

- [ ] 15-5b: TW + VM 評価
  - strings 配列 (raw 付き) + 式の値を引数として tag 関数を呼び出す

- [ ] 15-5c: テスト追加 + test262 検証

**想定インパクト: ~50-100 テスト**

### 15-6: dstr テスト失敗の調査 + 修正

パラメータ分割代入は実装済みなのに dstr テストが ~2,861 件落ちている。
実装済み機能のバグや edge case の可能性が高い。

- [ ] 15-6a: dstr テスト失敗のサンプリング (20件) → 失敗原因の分類
- [ ] 15-6b: 分類結果に基づいて修正 (generator メソッド依存 / edge case / 別の原因)
- [ ] 15-6c: test262 再検証

**想定インパクト: 原因次第で ~500-1,000 テスト**

## 目標

```
test262 VM:  41.9% → 55-60%
test262 TW:  41.1% → 53-58%
差: 66件 → 50件以内を維持
```

## 技術メモ

### Generator メソッドの実装方針

既存の generator 関数 (`function* gen()`) は TW/VM 両方で動いている。
メソッド構文はパーサがメソッド定義を解析する際に `*` を検出して
FunctionExpression に `generator: true` を付けるだけで、
評価器側は既存の generator 処理がそのまま使えるはず。

### eval の難しさ

direct eval は「呼び出し元のスコープにアクセスできる」のが厄介。
VM の場合、eval 内のコードをその場でコンパイルする必要がある。
最初は TW にフォールバックする方式で十分。

### dstr テスト大量失敗の仮説

- generator メソッドが ~575 件のパースエラーを起こし、それが dstr テストの前提を壊している
- for-of/for-in 内の分割代入で edge case が落ちている可能性
- 15-1 (generator メソッド) を先に実装すると、dstr の失敗数が大幅に減る可能性がある
