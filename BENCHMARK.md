# jsmini ベンチマーク結果

計測条件: `node --noopt --no-sparkplug --no-maglev` (V8-JIT 無効、WebAssembly は有効)

## Tree-Walking vs Bytecode VM vs Wasm JIT

| Benchmark | Tree-Walking | Bytecode VM | 比率 | Wasm JIT | JIT vs TW |
|-----------|-------------|-------------|------|----------|-----------|
| **fibonacci(25)** | 738ms | 701ms | **1.05x VM wins** | **0.56ms** | **1309x** |
| for loop sum (10K) | 20ms | 34ms | 0.59x TW wins | — | — |
| hot add (10K calls) | 42ms | 55ms | 0.76x TW wins | 49ms | 0.86x |
| hot mul (10K calls) | 42ms | 56ms | 0.75x TW wins | 50ms | 0.85x |
| nested loop (100x100) | 21ms | 33ms | 0.66x TW wins | — | — |
| map/reduce (500 elements) | 6ms | 8ms | 0.70x TW wins | — | — |
| **quicksort (200 elements)** | 22ms | 29ms | 0.76x TW wins | — | — |
| **ackermann(3,4)** | 40ms | 36ms | **1.10x VM wins** | — | — |
| mutual recursion (10K) | 13ms | 14ms | 0.96x ほぼ同速 | — | — |
| callback chain (1500 calls) | 3ms | 5ms | 0.60x TW wins | — | — |
| Vec class (1000 iter) | 11ms | 19ms | 0.56x TW wins | — | — |

## 何がわかるか

### VM が TW に勝つパターン

- **fibonacci** (1.05x) — 242,785 回の再帰関数呼び出し
- **ackermann** (1.10x) — 10,547 回の深い再帰

**共通点: 関数呼び出しが支配的な再帰パターン。** TW は関数呼び出しごとに Environment 生成 + var ホイスティング + ReturnSignal catch が走る。VM は CallFrame を配列に push するだけ。

### VM が TW に負けるパターン

- **for loop** (0.59x) — 単純ループ、関数呼び出しなし
- **Vec class** (0.56x) — オブジェクト生成 + メソッド呼び出し

**共通点: ループの dispatch コストが支配的。** VM は 1 命令ごとに `bytecode[pc++]` → `instr.op` → string switch という間接参照が入る。TW は `switch(node.type)` → 即座に評価で、ステップ数が少ない。

### Wasm JIT が劇的に効くパターン

- **fibonacci** (1309x) — 再帰が Wasm 内で完結。24 万回の dispatch を完全排除

### Wasm JIT が効かないパターン

- **hot add** (0.86x, TW より遅い) — 小さい関数を外から 1 万回呼ぶ。JS→Wasm ブリッジのコストが毎回発生

## V8 の各 tier での比較

同じアルゴリズムを native JS で実行した場合:

| V8 tier | fib(25) | loop sum(10K) | hot add(10K) |
|---------|---------|---------------|--------------|
| Ignition のみ (`--jitless`) | 6.2ms | 0.10ms | 0.33ms |
| Sparkplug + Ignition | 2.2ms | 0.06ms | 0.10ms |
| 全 tier (TurboFan) | 0.56ms | 0.008ms | 0.007ms |

jsmini は全ケースで native JS の **100〜300 倍遅い**。TypeScript で JS エンジンを書くと「V8 の上で別のインタプリタを動かす」二重解釈になるため。

## クロスオーバーポイント

関数呼び出し回数と VM の勝敗 (V8-JITless):

```
fib( 5)  calls=     15  VM wins (1.02x)
fib( 7)  calls=     41  VM wins (1.14x)
fib(10)  calls=    177  VM wins (1.04x)
fib(15)  calls=  1,973  VM wins (1.06x)
fib(20)  calls= 21,891  VM wins (1.05x)
```

**15 回の関数呼び出しで VM が逆転する。** ただし比率は 1.02x〜1.14x で安定し、回数に比例して広がるわけではない。

## V8-JIT 有効時の結果

計測条件: `npx tsx src/bench.ts` (V8 のデフォルト、全 JIT tier 有効)

| Benchmark | Tree-Walking | Bytecode VM | 比率 | Wasm JIT | JIT vs TW |
|-----------|-------------|-------------|------|----------|-----------|
| **fibonacci(25)** | 144ms | 41ms | **3.55x VM wins** | **0.34ms** | **420x** |
| for loop sum (10K) | 2.1ms | 1.5ms | **1.44x VM wins** | — | — |
| hot add (10K calls) | 6.4ms | 3.0ms | **2.09x VM wins** | 3.8ms | 1.70x |
| hot mul (10K calls) | 6.3ms | 3.1ms | **2.04x VM wins** | 3.9ms | 1.64x |
| nested loop (100x100) | 2.3ms | 1.3ms | **1.80x VM wins** | — | — |
| map/reduce (500 elements) | 1.0ms | 0.6ms | **1.70x VM wins** | — | — |
| **quicksort (200 elements)** | 2.9ms | 1.6ms | **1.79x VM wins** | — | — |
| **ackermann(3,4)** | 7.6ms | 2.2ms | **3.39x VM wins** | — | — |
| mutual recursion (10K) | 2.6ms | 1.1ms | **2.39x VM wins** | — | — |
| callback chain (1500 calls) | 0.5ms | 0.3ms | **1.57x VM wins** | — | — |
| Vec class (1K iter) | 1.7ms | 2.6ms | 0.66x TW wins | — | — |

V8-JIT が有効だと **Vec class 以外の全ベンチで VM が勝つ**。

### V8-JITless vs V8-JIT あり の比較

| Benchmark | JITless: 勝者 | JIT あり: 勝者 | 変化 |
|-----------|-------------|--------------|------|
| fibonacci | VM (1.05x) | VM (3.55x) | VM の優位が拡大 |
| for loop | TW (0.59x) | VM (1.44x) | **逆転** |
| quicksort | TW (0.76x) | VM (1.79x) | **逆転** |
| ackermann | VM (1.10x) | VM (3.39x) | VM の優位が拡大 |
| hot add | TW (0.76x) | VM (2.09x) | **逆転** |
| Vec class | TW (0.56x) | TW (0.66x) | TW のまま (差は縮小) |

V8 の TurboFan が VM の `while + switch` ディスパッチループを最適化するため、JITless で TW が勝っていたベンチの多くで VM が逆転する。Vec class だけは `new` + prototype チェーンの処理が重く、TW が勝ち続ける。

## 再現方法

```bash
# V8-JIT 無効 (デフォルト)
npm run bench

# V8-JIT 有効
npx tsx src/bench.ts
```
