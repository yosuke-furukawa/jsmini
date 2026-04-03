# jsmini ベンチマーク結果

## V8-JITless (Ignition のみ)

計測条件: `node --noopt --no-sparkplug --no-maglev` (V8-JIT 無効、WebAssembly は有効)

### Tree-Walking vs Bytecode VM vs Wasm JIT

| Benchmark | Tree-Walking | Bytecode VM | 比率 | Wasm JIT | JIT vs TW |
|-----------|-------------|-------------|------|----------|-----------|
| **fibonacci(25)** | 1631ms | 1054ms | **1.55x VM wins** | **0.43ms** | **3822x** |
| for loop sum (10K) | 53ms | 52ms | **1.02x VM wins** | **0.70ms** | **76x** |
| hot add (10K calls) | 100ms | 86ms | **1.17x VM wins** | 79ms | 1.27x |
| hot mul (10K calls) | 99ms | 86ms | **1.15x VM wins** | 78ms | 1.26x |
| nested loop (100x100) | 54ms | 51ms | **1.06x VM wins** | **0.72ms** | **74x** |
| map/reduce (500 elements) | 14ms | 13ms | **1.05x VM wins** | — | — |
| **quicksort (200 x10)** | 484ms | 444ms | **1.09x VM wins** | **61ms** | **7.9x** |
| **ackermann(3,4)** | 88ms | 57ms | **1.55x VM wins** | **0.27ms** | **324x** |
| mutual recursion (10K) | 30ms | 21ms | **1.40x VM wins** | — | — |
| callback chain (1500 calls) | 8ms | 9ms | 0.98x TW wins | — | — |
| Vec class (1K iter) | 25ms | 34ms | 0.75x TW wins | — | — |
| **string concat (1K)** | 5.8ms | 5.9ms | 0.98x TW wins | — | — |
| **string compare (10K)** | 77ms | 67ms | **1.15x VM wins** | — | — |
| **template literal (1K)** | 6.0ms | 7.2ms | 0.83x TW wins | — | — |

### 何がわかるか

#### VM が TW に勝つパターン

- **fibonacci** (1.55x) — 242,785 回の再帰関数呼び出し
- **ackermann** (1.55x) — 10,547 回の深い再帰
- **mutual recursion** (1.40x) — 相互再帰
- **for loop** (1.02x), **nested loop** (1.06x), **hot add/mul** (1.15-1.17x) — ループ + 関数呼び出し

**共通点: 関数呼び出しが支配的なパターン。** TW は関数呼び出しごとに Environment 生成 + var ホイスティング + ReturnSignal catch が走る。VM は CallFrame を配列に push するだけ。

#### VM が TW に負けるパターン

- **Vec class** (0.75x) — オブジェクト生成 + メソッド呼び出し + HC/IC オーバーヘッド
- **template literal** (0.83x) — 文字列生成 + 連結
- **callback chain** (0.98x) — ほぼ同等

**共通点: オブジェクト生成や文字列操作が支配的。** HC/IC のオーバーヘッドや JSString 生成コストが VM 側で大きい。

#### 文字列操作 (Phase 9: 独自 JSString)

- **string concat** (0.98x) — ほぼ同等
- **string compare** (1.15x) — VM が勝つ
- **template literal** (0.83x) — 毎イテレーション JSString 生成

V8 の `string` を独自 JSString に置き換えたことで文字列操作にオーバーヘッドがある。
V8 の string 操作は C++ で最適化されており、JS で再実装しても勝てない。

#### Wasm JIT が劇的に効くパターン

- **fibonacci** (3822x) — 再帰が Wasm 内で完結。24 万回の dispatch を完全排除
- **ackermann** (324x) — 同様に再帰が Wasm 内で完結
- **for loop** (76x), **nested loop** (74x) — ループが Wasm 内で完結
- **quicksort** (7.9x) — WasmGC Array で配列操作が Wasm 内で完結 (Phase 14)

#### Wasm JIT が効かないパターン

- **hot add/mul** (1.27x) — 小さい関数を外から 1 万回呼ぶ。JS→Wasm ブリッジのコストが毎回発生するが、それでも VM より速い

---

### メモリ効率: AST vs Bytecode

| Program | AST ノード数 | AST ヒープ | BC 命令数 | BC ヒープ | 削減率 |
|---------|------------|----------|---------|---------|--------|
| 1 + 2 | 5 | 0.4KB | 3 | ~6B (flat) | 99% |
| fibonacci | 28 | 2.2KB | 26 | ~52B (flat) | 98% |
| quicksort | 171 | 13.4KB | 152 | ~304B (flat) | 98% |
| Vec class | 108 | 8.4KB | 91 | ~182B (flat) | 98% |

ソースコード量による実測 (jsmini の `Instruction[]` ベース):

| 関数数 | ソースサイズ | AST ヒープ | BC ヒープ | 削減率 |
|--------|-----------|----------|---------|--------|
| 1 | 0.1KB | 4.0KB | 3.4KB | 15% |
| 10 | 1.1KB | 24.7KB | 19.4KB | 22% |
| 50 | 5.5KB | 121KB | 95KB | 22% |
| 100 | 10.9KB | 242KB | 188KB | 22% |
| 200 | 22.0KB | 482KB | 378KB | 22% |

jsmini の bytecode は `Instruction[]` (JS オブジェクトの配列) なので **22% 削減** に留まる。
`Uint8Array` (flat bytecode) なら 1 命令 1-3 bytes で **98% 削減** が可能だが、V8-JITless での dispatch が遅くなるトレードオフがある。

**本物のエンジン (V8 Ignition)** では bytecode はコンパクトなバイト列で、AST の 50-75% 小さい。コンパイル後に AST を捨てられるのでメモリ効率が大幅に改善する。

TW は AST を実行中ずっと保持する必要がある（同じ関数を何度も呼ぶため）。大規模プログラムでは AST だけで MB 単位のメモリを消費する。これが V8 が TW を採用せず bytecode VM (Ignition) を使う理由の 1 つ。

---

## V8-JIT 有効時

計測条件: `npx tsx src/bench.ts` (V8 のデフォルト、全 JIT tier 有効)

| Benchmark | Tree-Walking | Bytecode VM | 比率 | Wasm JIT | JIT vs TW |
|-----------|-------------|-------------|------|----------|-----------|
| **fibonacci(25)** | 399ms | 71ms | **5.63x VM wins** | **0.37ms** | **1068x** |
| for loop sum (10K) | 8.9ms | 1.8ms | **4.85x VM wins** | **0.13ms** | **67x** |
| hot add (10K calls) | 20ms | 4.8ms | **4.28x VM wins** | 5.5ms | 3.71x |
| hot mul (10K calls) | 20ms | 4.9ms | **4.12x VM wins** | 5.5ms | 3.71x |
| nested loop (100x100) | 9.3ms | 1.8ms | **5.06x VM wins** | **0.12ms** | **79x** |
| map/reduce (500 elements) | 3.0ms | 0.8ms | **3.81x VM wins** | — | — |
| **quicksort (200 x10)** | 91ms | 20ms | **4.43x VM wins** | **14ms** | **6.5x** |
| **ackermann(3,4)** | 22ms | 3.7ms | **5.95x VM wins** | **0.11ms** | **201x** |
| mutual recursion (10K) | 7.0ms | 1.8ms | **3.96x VM wins** | — | — |
| callback chain (1500 calls) | 1.7ms | 0.4ms | **3.79x VM wins** | — | — |
| Vec class (1K iter) | 5.5ms | 5.0ms | **1.09x VM wins** | — | — |

V8-JIT が有効だと **全ベンチで VM が勝つ**。

### V8-JITless vs V8-JIT あり の比較

| Benchmark | JITless: 勝者 | JIT あり: 勝者 | 変化 |
|-----------|-------------|--------------|------|
| fibonacci | VM (1.55x) | VM (5.63x) | VM の優位が拡大 |
| for loop | VM (1.02x) | VM (4.85x) | VM の優位が拡大 |
| quicksort | VM (1.09x) | VM (4.43x) | VM の優位が拡大 |
| ackermann | VM (1.55x) | VM (5.95x) | VM の優位が拡大 |
| hot add | VM (1.17x) | VM (4.28x) | VM の優位が拡大 |
| Vec class | TW (0.75x) | VM (1.09x) | **逆転** |

---

## V8 の各 tier での native JS 比較

同じアルゴリズムを native JS で実行した場合:

| V8 tier | fib(25) | loop sum(10K) | hot add(10K) |
|---------|---------|---------------|--------------|
| Ignition のみ (`--jitless`) | 6.2ms | 0.10ms | 0.33ms |
| Sparkplug + Ignition | 2.2ms | 0.06ms | 0.10ms |
| 全 tier (TurboFan) | 0.56ms | 0.008ms | 0.007ms |

jsmini は全ケースで native JS の **100〜300 倍遅い**。TypeScript で JS エンジンを書くと「V8 の上で別のインタプリタを動かす」二重解釈になるため。

---

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

---

## 再現方法

```bash
# V8-JIT 無効 (デフォルト)
npm run bench

# V8-JIT 有効
npx tsx src/bench.ts
```
