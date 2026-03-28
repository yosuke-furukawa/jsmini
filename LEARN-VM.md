# Bytecode VM で学んだこと

jsmini の Tree-Walking Interpreter と Bytecode VM を実装・比較する中で得た知見をまとめる。

---

## 1. TW と VM の違いは「木を辿った後に何をするか」

パーサーがソースコードから AST を作るところは共通。その後の分岐:

```
ソースコード → パーサー → AST
                          ├→ TW:  木を辿りながら「計算する」
                          └→ VM:  木を辿りながら「命令列を作る」→ 命令列を実行
```

- **TW** — AST を再帰的に辿りながら即座に評価する。実装がシンプル
- **Bytecode VM** — AST を辿って命令列 (bytecode) にコンパイルし、dispatch ループで実行する
- **JIT** — bytecode を実行しながら型情報を収集し、ホット関数をネイティブコード (Wasm) に変換する

各段階が解決する問題は異なる:
- TW → Bytecode: **関数呼び出しのコスト削減**
- Bytecode → JIT: **dispatch オーバーヘッドの排除**

---

## 2. VM が TW に勝てる唯一の要因は「関数呼び出しのコスト差」

V8-JITless (Ignition のみ) で計測した結果:

```
fibonacci(25)  — 242,785 回の関数呼び出し
  TW:   750ms
  VM:   715ms  ← VM wins (1.05x)

for loop sum (10000)  — 関数呼び出しなし
  TW:    20ms
  VM:    31ms  ← TW wins (0.65x)

quicksort (200 elements)  — 再帰 + ループ混在
  TW:    22ms
  VM:    27ms  ← TW wins (0.82x)
```

**VM が勝つのは再帰的な関数呼び出しが支配的な場合のみ。** ループや算術では TW が勝つ。

理由は関数呼び出しのコスト構造の差:

```
TW の関数呼び出し:
  1. new Environment()       ← オブジェクト生成
  2. 引数を env.set() × N    ← Map 操作
  3. var ホイスティング       ← AST を再帰的に辿る
  4. 本体を再帰実行          ← JS の call stack 消費
  5. ReturnSignal catch      ← 例外的フロー

VM の関数呼び出し:
  1. CallFrame を配列に push  ← 軽い
  2. locals[] に引数コピー    ← 配列操作
  3. pc = 0 で続行
```

TW は 1 回の関数呼び出しで重い処理が 5 ステップ。VM は配列操作だけ。
この差が 24 万回積み重なると逆転する。

---

## 3. 関数呼び出し 15 回で VM が逆転する

クロスオーバーポイントの計測 (V8-JITless):

```
fib( 5)  calls=     15  VM wins (1.02x)
fib( 7)  calls=     41  VM wins (1.14x)
fib(10)  calls=    177  VM wins (1.04x)
fib(15)  calls=  1,973  VM wins (1.06x)
fib(20)  calls= 21,891  VM wins (1.05x)
```

24 万回も要らない。**15 回の関数呼び出しで既に VM が逆転**。
ただし比率は 1.02x〜1.14x で安定し、回数に比例して広がるわけではない。
**関数呼び出しが発生すること自体** が VM の構造的メリット。

---

## 4. ループや算術では dispatch コストが TW を上回る

VM の dispatch ループは毎命令:
```
const instr = bytecode[pc++];  // 配列アクセス → オブジェクト参照
switch (instr.op) {            // プロパティアクセス + 文字列比較
```

TW のノード訪問は:
```
switch (expr.type) {           // プロパティアクセス + 文字列比較
```

ステップ数が VM のほうが多い。V8-JITless ではステップごとに bounds check や type check が入るため、**コードが少ないほうが速い**。TW のほうがステップが少ないから速い。

dispatch コストの内訳 (for loop sum 10000, V8-JITless):

```
手書き最小 VM (9 case, 直接アクセス):   8.8ms  ← ベースライン
+ push/pop メソッド化:                 +4.1ms
+ case 40 個:                          +4.8ms
+ frames[frames.length-1] 毎回:        +3.5ms
= 全部盛り:                            20.9ms  ← TW とほぼ同速
+ VM クラスの残りオーバーヘッド:        +10.1ms
= jsmini VM:                           31.0ms
```

手書き最小 VM なら 8.8ms で TW (20ms) の 2.3 倍速い。しかし実際の VM に必要な機能 (多数の opcode、push/pop 抽象化、CallFrame 管理) を入れると恩恵が消える。

---

## 5. コードの複雑さではなく「実行時の関数呼び出し回数」が決め手

```
式のネスト深さ (depth=100):     TW wins (0.49x)  ← 木が深くても TW が勝つ
関数呼び出しの深さ (depth=5):   VM wins (1.07x)  ← 5 段で逆転
if-else チェーン (depth=50):    VM wins (1.39x)  ← 分岐もVMが得意
文の数 (width=50):              TW wins (0.82x)  ← 幅を広げても TW が勝つ
```

AST が深い・広いだけでは VM は勝てない。
**関数呼び出しや条件分岐のように、TW で 1 ノードあたりの処理が重いノード** が多いとき VM が勝つ。

---

## 6. 全エンジンが Bytecode を採用するのは「実プログラムは関数呼び出しだらけ」だから

実際の JS プログラムは:
- React コンポーネントの render → 関数呼び出し
- イベントハンドラ → コールバック関数
- Promise チェーン → 関数呼び出し
- Array.map/filter/reduce → コールバック関数

**実プログラムでは関数呼び出しが支配的** なので、Bytecode VM の構造的メリットが活きる。
jsmini のベンチで TW が勝つのは、ベンチが単純な for ループ中心だったから。

---

## 7. V8 の各 tier の効果

同じアルゴリズムを native JS で実行した場合 (V8 の各 tier):

```
                    fib(25)    loop sum    hot add
Ignition のみ:       6.2ms     0.10ms     0.33ms
Sparkplug+Ignition:  2.2ms     0.06ms     0.10ms
全 tier (TurboFan):  0.56ms    0.008ms    0.007ms
```

jsmini は全ケースで native JS の **100〜300 倍遅い**。
TypeScript で JS エンジンを書くと、V8 の上で別のインタプリタを動かす「二重解釈」になるため。

Sparkplug (ベースラインコンパイラ) だけで Ignition の 3 倍速くなり、TurboFan で更に 10 倍速くなる。
本物のエンジンが C/C++ で書かれ、複数の JIT tier を持つ理由がここにある。

---

## 8. Sparkplug 有効時は VM が圧勝する

```
Sparkplug + Ignition (--noopt --no-maglev):
  fibonacci(25):
    TW:    2810ms  ← 激遅
    VM:     494ms  ← TW の 5.7 倍速い

  hot add (10000):
    TW:      77ms
    VM:      35ms  ← TW の 2.2 倍速い
```

Sparkplug が V8 bytecode をネイティブコードに変換すると、jsmini VM の `while+switch` が高速化される。
一方 TW の再帰呼び出しは Sparkplug だけでは最適化しきれない。

**V8 の最適化階層が上がるほど、VM の構造的メリットが発揮される。**

---

## 9. Flat VM (Uint8Array) は TypeScript では効果なし

RESEARCH の仮説: 命令を `Instruction[]` (オブジェクト) から `Uint8Array` (フラットバイト列) に変えれば速くなる。

実測結果 (V8-JITless):
```
Object VM:  31ms
Flat VM:    40ms  ← むしろ遅い
```

原因:
- V8-JITless では `Uint8Array` アクセスは `Array` アクセスとほぼ同速
- Uint8Array からオペランドを複数バイト読む追加コスト (`code[pc++]` を何度も) がオブジェクトの `instr.operand` 1 回より重い
- 変数アクセスが `Map.get/set` のままなので、最大のボトルネックが共通

**命令フォーマットの変更は TypeScript では効果がない。C/C++ でのみ意味がある最適化。**

---

## 10. dispatch を速くする手段は限られる

TypeScript で VM の dispatch を速くするアイデア:

| 手法 | 効果 | 実用性 |
|------|------|--------|
| push/pop インライン化 | −4ms | 可能だが VM クラスの構造を崩す |
| スーパーインストラクション | dispatch 回数削減 | 複雑、コンパイラも変更が必要 |
| frame キャッシュ | −3.5ms | Call/Return 時のみ更新すれば可能 |
| computed goto | 不可能 | JS に存在しない |
| Wasm dispatch ループ | 根本解決 | もはや JIT の領域 |

**TypeScript の限界: `switch` をジャンプテーブルにできない。** C/C++ コンパイラなら `switch(code[pc++])` を 1 命令のジャンプに最適化するが、V8 のインタプリタでは毎回比較が走る。

dispatch を本質的に速くするには **dispatch をなくす = JIT でネイティブコードに変換する** しかない。
これが TW → Bytecode → JIT という 3 段階が存在する理由。

---

## まとめ: 3 段階の実行方式が存在する理由

```
TW (Tree-Walking)
  ✓ 実装がシンプル
  ✗ 関数呼び出しが重い (Environment 生成、AST 再帰)
  ✗ 同じコードを何度も木を辿り直す

Bytecode VM
  ✓ 関数呼び出しが軽い (CallFrame push だけ)
  ✓ 一度コンパイルした命令列を使い回せる
  ✓ JIT の入口になる (型情報収集、ホット関数検出)
  ✗ dispatch オーバーヘッド (while+switch)

JIT
  ✓ dispatch をなくす (ネイティブコードに変換)
  ✓ 型特殊化で更に高速化
  ✗ 実装が複雑
  ✗ コンパイル時間のコスト
```

各段階は前の段階の **特定の弱点** を解決するために存在する。
全部一度に解決しないのは、各段階が前の段階の出力 (AST → bytecode → native code) を入力として必要とするから。
