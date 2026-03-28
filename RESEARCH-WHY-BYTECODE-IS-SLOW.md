# なぜ jsmini の Bytecode VM は Tree-Walking より遅いのか

## 問題

V8-JIT を無効にした状態 (`--noopt --no-sparkplug --no-maglev`) で `npm run bench` を実行すると、
Bytecode VM が Tree-Walking Interpreter より **遅い**。

```
for loop sum (10000):
  Tree-Walking:  21ms
  Object VM:     33ms  ← 1.5倍遅い
```

本物の JS エンジン（V8, SpiderMonkey, JSC）では、バイトコード VM はインタプリタの中で最も速い実行方式として使われている。jsmini の VM が遅いのは **Bytecode VM という手法の問題ではなく、jsmini の VM の実装構造の問題** である。

---

## 計測

### 1. 全体の時間

```
V8-JIT なし (for loop sum 10000):
  Tree-Walking:  21ms
  Object VM:     33ms (1.5x 遅い)

V8-JIT あり:
  Tree-Walking:  2.2ms
  Object VM:     1.6ms (1.4x 速い)
```

V8-JIT ありだと VM が速くなる。V8 の TurboFan が VM の `while + switch` ループを最適化するため。

### 2. コンパイル vs 実行

```
VM コンパイル時間: 0.13ms
VM 実行時間:      31.7ms
```

コンパイルコストは無視できる。問題は実行時のディスパッチ。

### 3. 動的命令数の比較

for ループ 1 イテレーションあたり:

```
Object VM: 15 命令/iter
  test:   LdaGlobal, LdaConst, LessThan, JumpIfFalse  (4)
  body:   LdaGlobal, LdaGlobal, Add, StaGlobal, Pop   (5)
  update: LdaGlobal, LdaConst, Add, StaGlobal, Pop    (5)
  jump:   Jump                                          (1)

Tree-Walking: 13 ノード/iter
  test:   BinaryExpression → Identifier, Literal        (3)
  body:   Block → ExprStmt → Assign → Binary → Id, Id  (6)
  update: Assign → Binary → Id, Literal                 (4)
```

命令数はほぼ同等（15 vs 13）。差は命令数ではなく **1命令あたりのコスト** にある。

### 4. 1命令あたりのコスト分析

**Object VM の 1 命令 (例: LdaGlobal)**:
```
1. bytecode[pc] → 配列インデックスアクセス + オブジェクト参照取得
2. instr.op → オブジェクトのプロパティ読み取り
3. switch (instr.op) → 文字列比較で分岐
4. instr.operand → オブジェクトのプロパティ読み取り
5. constants[operand] → 配列インデックスアクセス
6. globals.get(name) → Map のハッシュルックアップ
7. stack[++sp] = value → 配列インデックスアクセス + 代入
→ 合計: 7ステップ、うち 2回のプロパティアクセス + 1回の Map ルックアップ + 1回の文字列 switch
```

**Tree-Walking の 1 ノード (例: Identifier)**:
```
1. expr.type → オブジェクトのプロパティ読み取り
2. switch (expr.type) → 文字列比較で分岐
3. env.get(expr.name) → Map のハッシュルックアップ
4. return value → 関数の戻り値
→ 合計: 4ステップ、うち 1回のプロパティアクセス + 1回の Map ルックアップ + 1回の文字列 switch
```

**差のまとめ**: VM は 1 命令あたり 5〜7 ステップ、TW は 1 ノードあたり 2〜4 ステップ。
ループ全体では VM が ~2.7 倍のステップ数になる。

### 5. 要素別マイクロベンチマーク (100万回, V8-JIT なし)

```
object property access (arr[i].op):  22ms
switch on string (6 cases):          31ms
stack push/pop (array):              19ms
Map.get + Map.set:                   59ms
array[slot] access:                  73ms
```

文字列 switch が最も重く、Map アクセスも高い。ただし配列アクセスも V8-JIT なしでは遅い。

### 6. 文字列 vs 数値 Opcode

```
V8-JIT なし:
  文字列 switch: 181ms
  数値 switch:   170ms (6% 速い)
```

差はわずか。問題は switch 自体ではなく、**switch に至るまでの間接参照の多さ**。

---

## 根本原因

jsmini の Object VM が遅い理由は **命令のデータ構造がオブジェクト** であること:

```typescript
// 現在の jsmini
type Instruction = { op: string; operand?: number };
const bytecode: Instruction[] = [...];

// 毎命令:
const instr = bytecode[pc++];  // オブジェクト参照
switch (instr.op) {            // プロパティアクセス + 文字列比較
  case "LdaGlobal":
    const name = constants[instr.operand!];  // プロパティアクセス + 配列アクセス
    stack[++sp] = globals.get(name);         // Map ルックアップ
```

本物の JS エンジン (V8 Ignition, CPython, Lua) のバイトコード VM:
```c
// V8 Ignition (概念)
uint8_t* bytecode = ...;

// 毎命令:
uint8_t op = bytecode[pc++];    // 1バイト読み取り
switch (op) {                    // 数値比較 → ジャンプテーブル
  case OP_LDAR:
    int slot = bytecode[pc++];   // 1バイト読み取り
    stack[sp++] = locals[slot];  // 配列アクセス
```

差:
1. **オブジェクトプロパティ vs バイト読み取り** — `instr.op` vs `bytecode[pc]`
2. **文字列 switch vs 数値 switch** — 文字列比較 vs ジャンプテーブル
3. **Map ルックアップ vs 配列インデックス** — `globals.get("sum")` vs `slots[0]`
4. **unknown[] vs TypedArray** — 型不定の配列 vs 連続メモリ

---

## 検証: Flat VM の実験

`Uint8Array` + 数値 opcode + `Float64Array` スロットでミニ VM を作り、同じ for ループを実行:

```typescript
// Flat VM
const code = new Uint8Array([...]);       // 命令列
const constants = new Float64Array([...]); // 定数
const slots = new Float64Array(2);         // ローカル変数
const stack = new Float64Array(64);        // スタック

while (true) {
  switch (code[pc++]) {          // 1バイト読み取り + 数値 switch
    case OP.LDA_SLOT:
      stack[++sp] = slots[code[pc++]];  // TypedArray 直接アクセス
      break;
    case OP.ADD:
      stack[sp - 1] += stack[sp--];     // TypedArray 直接アクセス
      break;
  }
}
```

### 結果 (V8-JIT なし)

```
Tree-Walking:           21ms  (1x)
Object VM (現在):       33ms  (0.64x — 遅い)
Flat VM (Uint8Array):   9.6ms (2.2x — 速い！)
```

**Flat VM は Tree-Walking の 2.2 倍速く、Object VM の 3.4 倍速い。**

V8-JIT なしでも、データ構造を適切に選べばバイトコード VM は Tree-Walking より構造的に速い。

---

## Flat VM 実装後の検証 (2026-03)

Flat VM を実際に jsmini に実装した結果、**当初の実験とは異なる結果** が得られた。

### 実際の実装の結果 (V8-JIT なし)

```
for loop sum (10000):
  Tree-Walking:  20.5ms
  Object VM:     31.0ms
  Flat VM:       40.7ms  ← Object VM より遅い！
```

Flat VM が **Object VM よりさらに遅い** という、当初の実験と逆の結果。

### なぜ実験と実装で結果が違うのか

当初の実験と実際の実装の**条件の違い**:

| 条件 | 当初の実験 | 実際の実装 |
|------|-----------|-----------|
| スタック | `Float64Array` | `unknown[]` |
| 変数スロット | `Float64Array` (配列インデックス) | `Map<string, unknown>` (グローバル) |
| 扱う型 | 数値のみ | 全 JS 値 (文字列, オブジェクト, boolean...) |
| バイトコード | 手書き (コンパイル不要) | コンパイラ出力 |

最大の違いは**変数アクセス方法**。実験は `slots[idx]` (配列インデックス) だったが、実装ではトップレベル変数が `globals.get("name")` (Map ルックアップ) のまま。Flat VM と Object VM で変数アクセスのコストが同じなので、差が出ない。

### マイクロベンチマークによる要素別検証 (100万回, V8-JIT なし)

```
配列アクセス:
  Uint8Array read:        15.8ms
  Array (number) read:    15.4ms  → ほぼ同速。TypedArray のメリットなし。

switch コスト:
  numeric switch:         31.5ms
  string switch:          42.0ms  → 数値 switch は 25% 速い ✅

変数アクセス:
  Map.get:                24.8ms
  Array[index]:           14.2ms  → 配列インデックスは 1.75x 速い ✅

実行のみ (パース・コンパイル除外):
  Object VM execute:      31.7ms
  Flat VM execute:        40.7ms  → Flat VM のほうが遅い ❌
```

### 当初の主張の正誤

| 主張 | 正誤 | 根拠 |
|------|------|------|
| 文字列 switch → 数値 switch で速くなる | △ 25% 改善だが支配的ではない | 31.5 vs 42.0ms (100万回) |
| オブジェクトプロパティ → バイト読み取りで速くなる | ❌ Uint8Array は Array とほぼ同速 | 15.8 vs 15.4ms (100万回) |
| Map → 配列インデックスで速くなる | ✅ 1.75x 改善。**これが最大のボトルネック** | 24.8 vs 14.2ms (100万回) |
| Float64Array スタックで速くなる | ❌ unknown[] と Float64Array はほぼ同速 | 手書きベンチで 7.6 vs 7.4ms |
| Flat VM は TW の 2.2x 速い | ❌ **実験条件限定の結果だった** | 実装では TW の 0.5x (遅い) |

### Flat VM が Object VM より遅い原因

数値 switch の 25% 改善はあるが、以下の**追加コスト**が上回る:

1. **オペランド読み取りコスト**: Object VM は `instr.operand` の 1 回のプロパティアクセスでオペランドを取得。Flat VM は `code[pc++]` を複数回呼ぶ（u16 なら 2 回 + ビットシフト）
2. **Uint8Array アクセスのオーバーヘッド**: V8-JITless では Uint8Array の bounds check 等が Array よりわずかに重い
3. **変数アクセスが同じ**: 両方とも `Map.get/set` を使うため、最大のボトルネックが共通

---

## 真の改善策

### ボトルネックの優先順位

```
1位: Map.get/set による変数アクセス     → 配列スロット化で 1.75x 改善
2位: 文字列 switch                     → 数値 switch で 25% 改善
3位: オブジェクトプロパティアクセス      → 微小な差 (V8-JITless)
4位: unknown[] vs TypedArray スタック   → 差なし
```

### Map 排除 (変数の配列スロット化)

**最も効果的な最適化は Map の排除**。トップレベル変数も含めて全変数を配列インデックスアクセスに変換する:

```typescript
// Before: Map ルックアップ
globals.get("sum")  // ~25ms/100万回

// After: 配列インデックス
locals[0]           // ~14ms/100万回
```

これは Flat VM 固有の最適化ではなく、Object VM でも適用できる。
コンパイラが全変数にスロット番号を割り当て、VM がフラットな配列で変数を管理すればよい。

ただし、関数からの外部変数参照（クロージャ）では、
グローバル変数テーブルを介さずに親スコープの変数を解決する仕組みが必要になる。

---

## 結論

jsmini の Bytecode VM が遅いのは「バイトコード VM だから」ではなく「変数アクセスに Map を使っているから」。

当初の Flat VM 実験は Float64Array + 配列スロットという **Map を使わない条件** だったため速かった。
バイト列フォーマット (Uint8Array vs Instruction[]) の差は V8-JITless ではほぼ意味がない。

**改善の本丸は Map 排除 (全変数の配列スロット化)** であり、命令フォーマットの変更ではない。
