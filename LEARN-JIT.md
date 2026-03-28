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

## 2. JIT の本来の威力は「再帰を Wasm 内で完結させる」こと

以前の jsmini-JIT は `add(a, b) { return a + b; }` のような一直線の算術関数しか Wasm 化できなかった。
ループの中から毎回 Wasm 関数を呼ぶため、JS↔Wasm ブリッジのコストが積み重なり、効果がなかった。

```
hot add (10000 calls), V8-JITless:
  VM only:      53ms
  VM + JIT:     60ms  ← むしろ遅い (feedback +5ms, tryCall +1.5ms)
```

**再帰関数 (fibonacci) を Wasm 内で自己再帰できるようにしたら劇的に変わった:**

```
fibonacci(25), V8-JITless (WebAssembly は有効):
  TW:       749ms
  VM:       709ms
  VM+Wasm:  0.56ms  ← TW の 1337 倍速い
```

24 万回の関数呼び出しが全部 Wasm 内で完結する。JS↔Wasm ブリッジは最初の 1 回だけ。

**教訓**: JIT の恩恵は **「関数を速くする」ではなく「dispatch をなくす」**。
Wasm 内で再帰が完結すれば、VM の dispatch ループを完全にバイパスできる。

---

## 3. 小さい関数の per-call JIT は逆効果

`add(a, b)` のような小さい関数を JIT しても効果がない理由:

```
1回の add(a, b) 呼び出し:
  Wasm 内の計算: ~0.001μs (i32.add 1命令)
  JS→Wasm ブリッジ: ~0.5μs (引数変換 + コンテキスト切り替え)
  → ブリッジコストが計算の 500 倍
```

10000 回呼ぶと `0.5μs × 10000 = 5ms` のブリッジコスト。VM の dispatch (53ms) より小さいが、
feedback 記録 (+5ms) と tryCall チェック (+1.5ms) で相殺される。

fibonacci が速いのは、1 回 Wasm に入ったら 24 万回の再帰が全部内部で完結するから。
ブリッジは 1 回だけ。

**教訓**: JIT が効くのは **Wasm 内で多くの仕事が完結する** 場合。
小さい関数を外から何度も呼ぶパターンでは、ブリッジコスト > dispatch コスト。

---

## 4. feedback 記録のコストは呼び出し回数に比例する

```
fibonacci(25) — 242,785 回の関数呼び出し:
  VM only:           706ms
  + feedback:        +97ms   ← recordCall × 24万回
  + jit check:       +43ms   ← tryCall × 24万回
  = JIT 有効時:      845ms   ← 20% 遅くなる！
```

皮肉なことに、**VM が TW に勝てるパターン (関数呼び出しが多い) ほど JIT のオーバーヘッドも大きい**。

改善策:
- Wasm コンパイル成功後は feedback 記録をスキップ
- tryCall のキャッシュヒット時は即座に Wasm を呼ぶ (型チェック簡略化)

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

jsmini の全層比較 — fibonacci(25):
```
                                         V8-JITless
Tree-Walking:                             749ms  (1x)
Bytecode VM:                              709ms  (1.06x — 関数呼び出しの軽さで僅差で勝つ)
VM + jsmini-JIT (per-call add):           効果なし (ブリッジコスト > 恩恵)
VM + jsmini-JIT (再帰 fibonacci):         0.56ms (1337x — dispatch を完全排除)
```

```
TW → VM:    関数呼び出しのコスト削減 (Environment 生成 → CallFrame push)
VM → JIT:   dispatch の排除 (while+switch → Wasm ネイティブ)
```

---

## 10. 「JIT を作る」と「JIT の恩恵を受ける」は別

jsmini は TypeScript で書かれ、V8 上で動く。つまり:

- jsmini の Tree-Walking は **V8-JIT の恩恵を受けている** （evalExpression の再帰が最適化される）
- jsmini の Bytecode VM は **V8-JIT の恩恵を受けている** （while+switch が最適化される）
- jsmini-JIT は **V8 の Wasm コンパイラの恩恵を受けている** （Wasm バイナリがネイティブコードに変換される）

全ての層が V8 の上に乗っている。V8-JIT を切ると jsmini の全層が遅くなる。これは「メタ循環インタプリタ」の本質的な特性で、ホスト環境の性能がゲスト言語の性能の上限を決める。

C++ で書かれた V8 の Ignition は CPU の命令を直接実行する。jsmini の Bytecode VM は V8 のバイトコードを経由して実行する。この **間接参照の層** が性能差の根本原因であり、同時に「TypeScript で JS エンジンを書くと何が起きるか」を理解する最良の教材でもある。

---

## まとめ: 3 段階の実行方式

```
TW (Tree-Walking)
  → AST を辿りながら即座に計算
  → 実装がシンプル。関数呼び出しが重い

Bytecode VM
  → AST を辿って命令列を作り、dispatch ループで実行
  → 関数呼び出しが軽い。dispatch オーバーヘッドあり

JIT (Wasm)
  → 命令列をネイティブコード (Wasm) に変換
  → dispatch を排除。再帰が Wasm 内で完結すれば桁違いに速い
  → 小さい関数の per-call では JS↔Wasm ブリッジが支配的で効果薄い
```

各段階は前の段階の **特定の弱点** を解決する:
- TW → Bytecode: 関数呼び出しコストの削減
- Bytecode → JIT: dispatch オーバーヘッドの排除

fibonacci(25) で実測:
```
TW:       749ms (1x)
VM:       709ms (1.06x)
Wasm JIT: 0.56ms (1337x)
```
