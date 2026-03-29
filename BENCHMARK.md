# jsmini ベンチマーク結果

## V8-JITless (Ignition のみ)

計測条件: `node --noopt --no-sparkplug --no-maglev` (V8-JIT 無効、WebAssembly は有効)

### Tree-Walking vs Bytecode VM vs Wasm JIT

| Benchmark | Tree-Walking | Bytecode VM | 比率 | Wasm JIT | JIT vs TW |
|-----------|-------------|-------------|------|----------|-----------|
| **fibonacci(25)** | 763ms | 745ms | **1.02x VM wins** | **0.36ms** | **2098x** |
| for loop sum (10K) | 22ms | 35ms | 0.62x TW wins | — | — |
| hot add (10K calls) | 45ms | 59ms | 0.75x TW wins | 51ms | 0.87x |
| hot mul (10K calls) | 44ms | 59ms | 0.75x TW wins | 51ms | 0.86x |
| nested loop (100x100) | 23ms | 34ms | 0.67x TW wins | — | — |
| map/reduce (500 elements) | 6ms | 9ms | 0.66x TW wins | — | — |
| **quicksort (200 x10)** | 220ms | 305ms | 0.72x TW wins | **41ms** | **5.4x** |
| **ackermann(3,4)** | 43ms | 40ms | **1.06x VM wins** | — | — |
| mutual recursion (10K) | 14ms | 15ms | 0.91x TW wins | — | — |
| callback chain (1500 calls) | 4ms | 6ms | 0.57x TW wins | — | — |
| Vec class (1K iter) | 11ms | 25ms | 0.46x TW wins | — | — |
| **string concat (1K)** | 2.5ms | 4.0ms | 0.61x TW wins | — | — |
| **string compare (10K)** | 32ms | 47ms | 0.68x TW wins | — | — |
| **template literal (1K)** | 2.9ms | 5.3ms | 0.55x TW wins | — | — |

### 何がわかるか

#### VM が TW に勝つパターン

- **fibonacci** (1.02x) — 242,785 回の再帰関数呼び出し
- **ackermann** (1.09x) — 10,547 回の深い再帰
- **mutual recursion** (1.01x) — 相互再帰

**共通点: 関数呼び出しが支配的な再帰パターン。** TW は関数呼び出しごとに Environment 生成 + var ホイスティング + ReturnSignal catch が走る。VM は CallFrame を配列に push するだけ。

#### VM が TW に負けるパターン

- **for loop** (0.62x) — 単純ループ、関数呼び出しなし
- **Vec class** (0.46x) — オブジェクト生成 + メソッド呼び出し + HC/IC オーバーヘッド
- **template literal** (0.55x) — 文字列生成 + 連結

**共通点: ループの dispatch コストが支配的。** VM は 1 命令ごとに `bytecode[pc++]` → `instr.op` → string switch という間接参照が入る。

#### 文字列操作 (Phase 9: 独自 JSString)

- **string concat** (0.61x) — ConsString 生成 + Uint8Array コピー
- **string compare** (0.68x) — intern 済みでも `isJSString` チェック + `jsStringEquals` のオーバーヘッド
- **template literal** (0.55x) — 毎イテレーション JSString 生成

V8 の `string` を独自 JSString に置き換えたことで文字列操作が遅くなる。
直接比較: V8 `===` は 1.4ms/100K 回、intern 済み `jsStringEquals` は 2.3ms/100K 回。
V8 の string 操作は C++ で最適化されており、JS で再実装しても勝てない。

#### Wasm JIT が劇的に効くパターン

- **fibonacci** (1928x) — 再帰が Wasm 内で完結。24 万回の dispatch を完全排除
- **quicksort** (5.3x) — 整数配列を Wasm linear memory にコピーし `i32.load`/`i32.store` で直接操作

#### Wasm JIT が効かないパターン

- **hot add/mul** (0.85x, TW より遅い) — 小さい関数を外から 1 万回呼ぶ。JS→Wasm ブリッジのコストが毎回発生

---

## V8-JIT 有効時

計測条件: `npx tsx src/bench.ts` (V8 のデフォルト、全 JIT tier 有効)

| Benchmark | Tree-Walking | Bytecode VM | 比率 | Wasm JIT | JIT vs TW |
|-----------|-------------|-------------|------|----------|-----------|
| **fibonacci(25)** | 140ms | 42ms | **3.32x VM wins** | **0.31ms** | **454x** |
| for loop sum (10K) | 2.1ms | 1.8ms | **1.15x VM wins** | — | — |
| hot add (10K calls) | 6.8ms | 3.1ms | **2.15x VM wins** | 4.0ms | 1.70x |
| hot mul (10K calls) | 6.3ms | 3.2ms | **1.98x VM wins** | 3.9ms | 1.60x |
| nested loop (100x100) | 2.4ms | 1.4ms | **1.70x VM wins** | — | — |
| map/reduce (500 elements) | 1.1ms | 0.6ms | **1.90x VM wins** | — | — |
| **quicksort (200 x10)** | 26ms | 13ms | **1.94x VM wins** | **2.8ms** | **9.3x** |
| **ackermann(3,4)** | 7.7ms | 2.2ms | **3.45x VM wins** | — | — |
| mutual recursion (10K) | 2.6ms | 1.2ms | **2.16x VM wins** | — | — |
| callback chain (1500 calls) | 0.5ms | 0.3ms | **1.55x VM wins** | — | — |
| Vec class (1K iter) | 1.8ms | 2.8ms | 0.64x TW wins | — | — |

V8-JIT が有効だと **Vec class 以外の全ベンチで VM が勝つ**。

### V8-JITless vs V8-JIT あり の比較

| Benchmark | JITless: 勝者 | JIT あり: 勝者 | 変化 |
|-----------|-------------|--------------|------|
| fibonacci | VM (1.02x) | VM (3.32x) | VM の優位が拡大 |
| for loop | TW (0.61x) | VM (1.15x) | **逆転** |
| quicksort | TW (0.72x) | VM (1.94x) | **逆転** |
| ackermann | VM (1.09x) | VM (3.45x) | VM の優位が拡大 |
| hot add | TW (0.76x) | VM (2.15x) | **逆転** |
| Vec class | TW (0.58x) | TW (0.64x) | TW のまま (差は縮小) |

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
