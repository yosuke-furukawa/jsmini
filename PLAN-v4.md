# PLAN v4 — jsmini の次のステップ

Phase 1-14 完了。test262: TW 41.1%, VM 41.9%。

---

## これまでの全体像

```
Phase 1-3:   言語の基礎 (Lexer, Parser, TW)
Phase 4:     Bytecode VM (スタックマシン)
Phase 5:     Wasm JIT (型フィードバック + コンパイル)
Phase 6:     Element Kind (配列の型追跡 → Wasm linear memory)
Phase 7:     Hidden Class (プロパティレイアウト)
Phase 8:     Inline Cache + Object JIT
Phase 9:     独自文字列表現 (ConsString/SlicedString/Intern)
Phase 10:    Mark-and-Sweep GC + Wasm GC (struct)
Phase 11:    Closure (Upvalue) + OSR
Phase 12:    プロトタイプチェーン + Object.prototype
Phase 13:    構文拡大 + Generator + Symbol + Iterator Protocol
Phase 14:    WasmGC Array + ビルトイン自前実装
```

---

## Phase 15: 構文対応拡大 — test262 パス率向上

### 動機

test262 の失敗パターンを分析すると、少数の未実装構文が大量のテスト失敗を引き起こしている。
特に destructuring 関連 (dstr ディレクトリ) が 2,861 件の失敗を占め、
generator メソッド構文の未対応が ~575 件のパースエラーを起こしている。

ターゲットを絞って実装すれば、VM パス率を 41.9% → 55-60% に引き上げられる見込み。

### 現状

```
test262 VM:  3,746 / 8,947 (41.9%)
test262 TW:  3,680 / 8,947 (41.1%)
差: 66件
ユニットテスト: 584+
```

### 失敗の内訳 (VM, 上位)

| ディレクトリ | 失敗数 | 主な原因 |
|---|---|---|
| dstr (destructuring) | ~2,861 | 関数パラメータの分割代入、for-of/for-in での分割代入 |
| class/elements | ~627 | static fields, private methods |
| expressions/object | ~125 | generator メソッド `*method()` |
| statements/function | ~89 | generator 関連、edge cases |
| for-of (non-dstr) | ~79 | for-of iteration edge cases |
| expressions/call | ~64 | call expression edge cases |

### ステップ

#### 15-1: 関数パラメータの分割代入

現在の分割代入は `var {a, b} = obj` のような変数宣言のみ対応。
関数パラメータでの分割代入が未対応で、dstr テストの大半がこれで落ちている。

- [ ] 15-1a: オブジェクトパターン in パラメータ (`function f({a, b}) {}`)
- [ ] 15-1b: 配列パターン in パラメータ (`function f([x, y]) {}`)
- [ ] 15-1c: デフォルト値付き (`function f({a = 1} = {}) {}`)
- [ ] 15-1d: ネストパターン (`function f({a: {b}}) {}`)
- [ ] 15-1e: rest パターン in パラメータ (`function f({a, ...rest}) {}`)
- [ ] 15-1f: for-of / for-in での分割代入 (`for (const {a} of arr)`)
- [ ] 15-1g: TW + VM 両対応、test262 検証

**想定インパクト: ~1,000-1,500 テスト**

#### 15-2: Generator メソッド

オブジェクトリテラルとクラスでの generator メソッド構文が未対応。
パーサが `*` を見て SyntaxError になり、~575 件のテストが落ちている。

- [ ] 15-2a: オブジェクトリテラルの generator メソッド (`{ *gen() { yield 1; } }`)
- [ ] 15-2b: クラスの generator メソッド (`class C { *gen() { yield 1; } }`)
- [ ] 15-2c: computed + generator (`{ *[Symbol.iterator]() {} }`)
- [ ] 15-2d: TW + VM 両対応、test262 検証

**想定インパクト: ~500-700 テスト**

#### 15-3: `arguments` オブジェクト

多くのテストが暗黙的に `arguments` に依存している。

- [ ] 15-3a: 基本の `arguments` オブジェクト (array-like, length, 引数アクセス)
- [ ] 15-3b: `arguments` と分割代入の相互作用
- [ ] 15-3c: アロー関数では外側の `arguments` を参照 (レキシカル)
- [ ] 15-3d: TW + VM 両対応、test262 検証

**想定インパクト: ~100-200 テスト**

#### 15-4: デフォルトパラメータ

`function f(a = 1, b = a + 1) {}` — test262 の function テストで頻出。

- [ ] 15-4a: 基本のデフォルトパラメータ
- [ ] 15-4b: 先行パラメータの参照 (`b = a + 1`)
- [ ] 15-4c: 分割代入との組み合わせ
- [ ] 15-4d: TW + VM 両対応、test262 検証

**想定インパクト: ~200-300 テスト**

#### 15-5: `eval()` 基本サポート

141 テストが直接 `eval` に依存。test ハーネスでも間接的に使われる。

- [ ] 15-5a: direct eval (現在のスコープでコード実行)
- [ ] 15-5b: indirect eval (`(0, eval)(code)` — グローバルスコープ)
- [ ] 15-5c: TW + VM 両対応、test262 検証

**想定インパクト: ~150-250 テスト**

#### 15-6: その他の構文補完

- [ ] 15-6a: ラベル文 (`label: for (...)` / `break label`)
  - 現在 `{ x: 1 }` がパースエラーになる原因でもある
- [ ] 15-6b: `typeof` 未定義変数で `undefined` を返す (現在は ReferenceError)
- [ ] 15-6c: `void` 演算子
- [ ] 15-6d: tagged template literals (`` tag`hello ${x}` ``)

**想定インパクト: ~100-200 テスト**

### 目標

```
test262 VM:  41.9% → 55-60%
test262 TW:  41.1% → 53-58%
差: 66件 → 50件以内を維持
```

---

## Phase 16 以降 (検討中)

### Generational GC
- Young generation (Nursery) + Old generation (Tenured)
- Minor GC: Young だけ走査 (高速)
- Write barrier: Old → Young の参照を追跡

### Register-based bytecode
- V8 の Ignition はレジスタベース
- スタックの push/pop を減らし、レジスタ間の直接転送に

### IR (中間表現) ベースの JIT
- 定数畳み込み、デッドコード削除、ループ不変式移動
- Escape Analysis (オブジェクトのスタック割り当て)

### 未実装構文 (Phase 15 以降)
- `yield*` (generator 委譲)
- `generator.throw()` / `generator.return()`
- `async` / `await`
- 正規表現 (RegExp)
- `Proxy` / `Reflect`
- `WeakMap` / `WeakSet`
- `Promise`
