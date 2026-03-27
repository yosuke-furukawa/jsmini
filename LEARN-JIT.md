# JIT コンパイラで学んだこと

jsmini の Phase 5 (Wasm JIT) を実装する中で得た知見をまとめる。

**用語の区別:**
- **V8-JIT**: Node.js の V8 エンジンに内蔵された JIT コンパイラ（TurboFan, Sparkplug, Maglev）。jsmini 自体の TypeScript コードを最適化する
- **jsmini-JIT**: jsmini が実装した Wasm JIT。jsmini に入力された JS コードのホット関数を Wasm にコンパイルする

---

## 1. バイトコード VM が速い理由は「V8-JIT が VM 自体を最適化する」から

jsmini の Bytecode VM は Tree-Walking Interpreter より速い。だが **V8-JIT を無効にすると逆転する**。

```
V8-JIT あり:
  Tree-Walking: 6.5ms
  Bytecode VM:  2.9ms  ← 2.2倍速い

V8-JIT なし (--noopt --no-sparkplug --no-maglev):
  Tree-Walking: 44ms
  Bytecode VM:  53ms   ← 0.83倍、VM の方が遅い
```

Bytecode VM の `while + switch` ディスパッチループは、V8-JIT の TurboFan が得意とするパターン:
- ループの認識 → ホットコードとして最適化
- switch の文字列比較 → インラインキャッシュ + ジャンプテーブルに変換
- 配列アクセス → バウンドチェック除去
- オブジェクトプロパティ → hidden class で高速化

一方 Tree-Walking の再帰呼び出しパターンは、V8-JIT が最適化しにくい（コールスタックが深く、インライン化の効果が出にくい）。

**教訓**: 「バイトコード VM が速い」のではなく「バイトコード VM は **V8-JIT が効きやすい構造** をしている」。

---

## 2. jsmini-JIT のコンパイルコストは無視できない

jsmini-JIT (Wasm JIT) を有効にすると、Bytecode VM より遅くなった。

```
Bytecode VM:                    2.9ms
VM + jsmini-JIT (per-call):     4.7ms  ← 遅い！
```

原因:
- `WebAssembly.Module()` の同期生成コストがベンチマーク中に含まれる
- 10000回中、最初の100回はフィードバック収集で VM 実行

V8 も同じ問題を抱えている。だからこそ **V8-JIT は段階的にコンパイルする**:
1. Ignition (インタプリタ) → 即座に実行開始、フィードバック収集
2. Sparkplug (ベースライン JIT) → 軽いコンパイル、そこそこ速い
3. Maglev (中間層 JIT) → 中程度のコンパイル
4. TurboFan (最適化 JIT) → 重いコンパイル、最速

コンパイルコストと実行速度のトレードオフを「ギアの切り替え」で最適化している。

---

## 3. 関数呼び出しのオーバーヘッドが jsmini-JIT の効果を殺す

jsmini-JIT は関数単位でコンパイルする。ループの中から毎回 Wasm 関数を呼ぶ。

```javascript
for (var i = 0; i < 10000; i++) {
  sum += wasmAdd(i, 1);  // 毎回 JS → Wasm → JS のブリッジ
}
```

100万回の純粋な関数呼び出し比較:
```
jsmini-JIT (Wasm i32 add): 4.76ms  (JS → Wasm ブリッジあり)
V8-JIT (Native TS add):   1.60ms  (V8-JIT が関数をインライン化、ブリッジなし)
```

jsmini-JIT の Wasm の方が V8-JIT のネイティブ TS より **3倍遅い**。Wasm 内部の計算は速いが、呼び出しのたびにブリッジを越えるコストが積み重なる。

**教訓**: V8-JIT の TurboFan が最も効果を発揮するのは **インライン化** — 関数呼び出し自体をなくすこと。jsmini-JIT にはこの機能がない。

---

## 4. インライン化すると桁が変わる

ループ + add を丸ごと1つの Wasm 関数に手書きした実験（jsmini-JIT ではなく手動で組み立て）:

```
Tree-Walking:              6.57ms  (1x)
Bytecode VM:               3.24ms  (2x)
VM + jsmini-JIT per-call:  4.73ms  (1.4x)
Wasm inlined (手書き):      0.02ms  (344x)
```

ループ全体が Wasm 内で完結すると **344倍速い**。JS → Wasm のブリッジを1回だけ越えて、中で10000回ループする。

これが V8-JIT の TurboFan がやっていること: ホットなループを検出し、ループ内の関数呼び出しをインライン化して、ループ全体を1つのネイティブコード塊にする。jsmini-JIT は関数単位のコンパイルしかできないため、この恩恵を受けられない。

---

## 5. 型特殊化の効果は型によって違う

jsmini-JIT のフィードバック収集で引数の型を詳細に分類:

```
classifyType(42)    → "uint32"  → Wasm i32
classifyType(-1)    → "int32"   → Wasm i32
classifyType(3.14)  → "f64"     → Wasm f64
classifyType("hi")  → "string"  → jsmini-JIT 不可
```

整数演算は `i32.add` (1 CPU 命令) で済むが、浮動小数点は `f64.add` (FPU 命令)。さらに文字列は Wasm では表現できない（可変長、GC 必要）。

V8-JIT の型推定が `number` の中でも `Smi` (Small Integer, 31bit) と `HeapNumber` (64bit float) を区別するのと同じ理由。

---

## 6. 脱最適化はセーフティネット

jsmini-JIT の型推測が外れた場合のフォールバック:

```
add(1, 2) × 100回 → フィードバック: [uint32, uint32] → jsmini-JIT が Wasm i32 にコンパイル
add(1, 2) 101回目〜 → Wasm で高速実行
add("a", "b") → 型ガード失敗 → [DEOPT] → Wasm 無効化 → Bytecode VM にフォールバック → "ab"
```

jsmini-JIT の脱最適化:
- Wasm キャッシュの無効化
- 以降は永続的に Bytecode VM で実行（再コンパイルしない）
- ログ記録 `[DEOPT] add: expected number but got (string, string)`

V8-JIT では脱最適化後に再度フィードバックを収集して再コンパイルすることもある（polymorphic IC）。jsmini-JIT では簡略化して永続的に VM 実行にしている。

---

## 7. 文字列の最適化は JIT の範疇ではない

V8 が文字列に対して行っている最適化:
- `ConsString`: 連結を遅延する特殊構造（コピーを避ける）
- Inline Cache: プロパティアクセスのキャッシュ
- ハッシュ比較: `===` を文字列ハッシュで高速化
- Irregexp: 正規表現の専用 JIT

これらは V8-JIT (TurboFan) による「機械語へのコンパイル」ではなく、**V8 内部のデータ構造とアルゴリズムの工夫**。Wasm の命令セットに文字列操作はないため、jsmini-JIT でも数値のように `i32.add` で済む話ではない。

---

## 8. switch の文字列 vs 数値 Opcode は大差ない

jsmini の Opcode が文字列 (`"Add"`) か数値 (`1`) かでどれだけ差が出るか実験した。

```
V8-JIT なし:
  文字列 switch: 181ms
  数値 switch:   170ms  (6% 速い)

V8-JIT あり:
  文字列 switch: 12.2ms
  数値 switch:   11.4ms (7% 速い)
```

差は **わずか 6〜7%**。V8 の Ignition は文字列比較をそこそこ効率的に処理している（インターン化された文字列の参照比較）。

VM が V8-JIT なしで Tree-Walking より遅い主因は文字列 switch ではなく、**命令ごとのオブジェクトプロパティアクセス** (`instr.op`, `instr.operand`) と**配列バウンドチェック**の積み重ね。

---

## 9. V8-JIT の多層構造を jsmini で体感した

jsmini の実装を通じて、V8-JIT の各層の役割が体感で理解できた。

```
V8-JIT:
                     コンパイル速度  実行速度   用途
Ignition (interp)    即座           遅い      起動時、コールド関数
Sparkplug (baseline) 速い           中程度    ウォームアップ
Maglev (mid-tier)    中程度         速い      頻繁に呼ばれる関数
TurboFan (top-tier)  遅い           最速      ホットループ、インライン化
```

jsmini で対応する層:
```
jsmini:
Tree-Walking         → 概念的には AST インタプリタ（V8 にはない）
Bytecode VM          → Ignition に相当
jsmini-JIT (per-call)→ Sparkplug/Maglev に相当（部分的な最適化）
Wasm inlined (手書き) → TurboFan に相当（ループ全体の最適化）
```

V8-JIT の全層比較（同じ add × 10000回）:
```
V8 Ignition only:  0.39ms
V8 + Sparkplug:    0.007ms (56倍速い)
V8 full JIT:       0.006ms (65倍速い)
```

jsmini の全層（同じ add × 10000回）:
```
Tree-Walking:       6.5ms
Bytecode VM:        2.9ms  (2.2倍速い)
jsmini-JIT:         4.7ms  (コンパイルコストで遅い)
Wasm inlined:       0.02ms (344倍速い、手書き)
```

jsmini の Bytecode VM (2.9ms) は V8 の Ignition (0.39ms) の **約7倍遅い**。これは jsmini が TypeScript で書かれ V8 の上で動く「メタ循環インタプリタ」であるのに対し、V8 の Ignition は C++ + アセンブリで CPU 上で直接動くため。

---

## 10. 「JIT を作る」と「JIT の恩恵を受ける」は別

jsmini は TypeScript で書かれ、V8 上で動く。つまり:

- jsmini の Tree-Walking は **V8-JIT の恩恵を受けている** （evalExpression の再帰が最適化される）
- jsmini の Bytecode VM は **V8-JIT の恩恵を受けている** （while+switch が最適化される）
- jsmini-JIT は **V8 の Wasm コンパイラの恩恵を受けている** （Wasm バイナリがネイティブコードに変換される）

全ての層が V8 の上に乗っている。V8-JIT を切ると jsmini の全層が遅くなる。これは「メタ循環インタプリタ」の本質的な特性で、ホスト環境の性能がゲスト言語の性能の上限を決める。

C++ で書かれた V8 の Ignition は CPU の命令を直接実行する。jsmini の Bytecode VM は V8 のバイトコードを経由して実行する。この **間接参照の層** が性能差の根本原因であり、同時に「TypeScript で JS エンジンを書くと何が起きるか」を理解する最良の教材でもある。
