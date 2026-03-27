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

## 結論

| 原因 | Object VM | Flat VM |
|------|-----------|---------|
| 命令フェッチ | `bytecode[pc]` → オブジェクト参照 | `code[pc]` → 1バイト読み取り |
| Opcode 分岐 | 文字列 switch | 数値 switch |
| オペランド取得 | `instr.operand` プロパティアクセス | `code[pc+1]` 1バイト読み取り |
| 変数アクセス | `globals.get("name")` Map ルックアップ | `slots[idx]` TypedArray アクセス |
| スタック | `unknown[]` (型不定) | `Float64Array` (型固定、連続メモリ) |

jsmini の Bytecode VM が遅いのは「バイトコード VM だから」ではなく「TypeScript のオブジェクトとして命令を表現しているから」。フラットなバイト列 + TypedArray にすれば、V8-JIT なしでも Tree-Walking を上回る。

本物の JS エンジンが C/C++ でバイトコードを `uint8_t[]` として扱う理由がここにある。
