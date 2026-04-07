# jsmini Architecture — JavaScript Engine の仕組み

jsmini は教育目的の JavaScript エンジン。
V8 / JSC / SpiderMonkey と同じパイプラインを TypeScript で実装している。

```
Source Code
    |
    v
 [Lexer]  ........... Token 列に分解
    |
    v
 [Parser] ........... AST (抽象構文木) に変換
    |
    v
 [Compiler] ......... Bytecode (バイトコード) に変換
    |
    v
 [VM] ............... Bytecode を逐次実行 (+ 型フィードバック収集)
    |
    v  (hot function 検出)
 [JIT Manager] ...... Wasm JIT コンパイルを判断
    |
    +---> [Direct JIT]  bytecode → Wasm 直接変換
    |
    +---> [IR Builder]  bytecode → SSA IR (CFG + SSA)
              |
              v
          [Optimizer]   Inlining, CF, CSE, DCE, LICM, SR
              |
              v
          [Codegen]     IR → Wasm バイナリ
              |
              v
          [V8 Wasm]     Liftoff → TurboFan でネイティブ実行
```

---

## 1. Lexer (字句解析)

**ソースコード → Token 列**

```js
var x = 1 + 2;
```
```
[Var] [Identifier:"x"] [Assign] [Number:"1"] [Plus] [Number:"2"] [Semicolon]
```

- 100 以上のトークン型: キーワード (var, if, for, class, ...)、演算子、リテラル
- テンプレートリテラル (`${expr}`) も対応
- `{ type: TokenType; value: string; line: number; column: number }`

**V8 との対応**: V8 の Scanner に相当。

ファイル: `src/lexer/lexer.ts`

---

## 2. Parser (構文解析)

**Token 列 → AST (Abstract Syntax Tree)**

```js
var x = 1 + 2;
```
```
Program
  └─ VariableDeclaration (var)
       └─ VariableDeclarator
            ├─ id: Identifier("x")
            └─ init: BinaryExpression(+)
                 ├─ left: Literal(1)
                 └─ right: Literal(2)
```

- ESTree 準拠の AST
- 再帰下降パーサー (Pratt parsing for 演算子優先順位)
- 対応構文: var/let/const, if/else, for/while, function, class, arrow function, template literal, destructuring, for...of, try/catch/finally, generator (function*)

**V8 との対応**: V8 の Parser に相当。V8 は lazy parsing (関数呼び出し時まで遅延) もやるが、jsmini は eager。

ファイル: `src/parser/parser.ts`

---

## 3. Bytecode Compiler

**AST → Bytecode (スタックマシン命令列)**

```js
function add(a, b) { return a + b; }
```
```
[LdaLocal 0]    // a をスタックに push
[LdaLocal 1]    // b をスタックに push
[Add]           // pop 2, push (a + b)
[Return]        // pop してreturn
```

- スタックマシン方式: 引数を push → 演算 → 結果を push
- `Instruction = { op: Opcode; operand?: number; icSlot?: number }`
- `BytecodeFunction` = name + paramCount + localCount + bytecode[] + constants[] + upvalues[]
- クロージャの自由変数は `upvalues` (UpvalueInfo: 親関数の slot 番号) で管理

**主な Opcode**:
| カテゴリ | Opcode |
|---|---|
| 定数 | LdaConst, LdaUndefined, LdaTrue, LdaFalse |
| 変数 | LdaLocal, StaLocal, LdaGlobal, StaGlobal, LdaUpvalue, StaUpvalue |
| 算術 | Add, Sub, Mul, Div, Mod, Negate |
| 比較 | Equal, StrictEqual, LessThan, GreaterThan, ... |
| 制御 | Jump, JumpIfFalse, Return, Call, Construct |
| オブジェクト | GetProperty, SetProperty, CreateObject, LoadThis |
| 配列 | CreateArray, GetPropertyComputed, SetPropertyComputed |

**V8 との対応**: V8 の Ignition (bytecode compiler) に相当。

ファイル: `src/vm/compiler.ts`

---

## 4. VM (バイトコード実行)

**Bytecode を 1 命令ずつ逐次実行**

- スタックマシン: `stack: unknown[]` に値を push/pop
- コールフレーム: `{ func, pc, locals[], thisValue, icSlots[], upvalueBoxes[] }`
- Inline Cache (IC): プロパティアクセスの高速化。Hidden Class + slot offset をキャッシュ

```
Frame: add(3, 4)
  locals: [3, 4]
  stack: []
  pc: 0 → LdaLocal 0 → stack: [3]
  pc: 1 → LdaLocal 1 → stack: [3, 4]
  pc: 2 → Add        → stack: [7]
  pc: 3 → Return     → 7
```

### Hidden Class (隠しクラス)

V8 と同じ仕組み。オブジェクトのプロパティレイアウトを追跡:

```js
var p = {};     // HC0: {}
p.x = 1;       // HC0 → HC1: {x: slot 0}
p.y = 2;       // HC1 → HC2: {x: slot 0, y: slot 1}
```

同じ順序でプロパティを追加したオブジェクトは同じ Hidden Class を共有。
IC が Hidden Class をチェックして、slot offset で直接アクセス (ハッシュ検索不要)。

### 型フィードバック (Type Feedback)

JIT コンパイルの判断に使う実行時型情報:

```
add(1, 2)     → argTypes: [int32, int32]   → i32 特殊化可能
add(1, 2)     → 同上 (monomorphic)
add("a", "b") → argTypes が変わる           → polymorphic → JIT 不可
```

- 呼び出しごとに引数の型を記録 (最大 10 サンプル)
- monomorphic (全呼び出しで同じ型パターン) なら JIT 対象
- 型分類: int32, f64, smi_array, interned_string, object, ...

**V8 との対応**: V8 の Ignition + Feedback Vector に相当。

ファイル: `src/vm/vm.ts`, `src/jit/feedback.ts`

---

## 5. JIT Manager (コンパイル階層管理)

**hot function を検出して Wasm JIT コンパイル**

```
呼び出し 1-4:  Bytecode VM (型フィードバック収集)
呼び出し 5:    → Wasm コンパイル (threshold 到達)
呼び出し 6+:   Wasm 実行 (高速)
```

### 2 つの JIT パス

| パス | 方式 | 特徴 |
|---|---|---|
| Direct JIT | bytecode → Wasm 直接変換 | シンプル、低レイテンシ |
| IR JIT | bytecode → IR → optimize → Wasm | Inlining + 最適化、正確性 |

### Deoptimization (脱最適化)

JIT コンパイル時の仮定 (i32 特殊化等) が実行時に崩れたら VM にフォールバック:

```
add(1, 2)   → Wasm (i32.add)
add(1.5, 2) → deopt! → VM にフォールバック
```

**V8 との対応**: V8 の TurboFan + OSR (On-Stack Replacement) に相当。
jsmini も OSR (ループ途中からの JIT 切替) を back-edge counter で実装。

ファイル: `src/jit/jit.ts`

---

## 6. IR (中間表現)

**Bytecode → CFG + SSA 形式の IR**

V8 の Turbofan / Turboshaft、JSC の B3、SpiderMonkey の MIR に相当。

### CFG (Control Flow Graph)

```js
function f(n) {
  var sum = 0;
  for (var i = 0; i < n; i++) sum += i;
  return sum;
}
```
```
B0 (entry):
  v0 = Param(0)        // n
  v1 = Const(0)        // sum = 0
  v2 = Const(0)        // i = 0
  Jump → B1

B1 (loop header):      ← B0, B2
  v3 = Phi(B0:v1, B2:v6)   // sum
  v4 = Phi(B0:v2, B2:v7)   // i
  v5 = LessThan(v4, v0)    // i < n
  Branch(v5) → B2, B3

B2 (loop body):
  v6 = Add(v3, v4)         // sum + i
  v7 = Add(v4, Const(1))   // i + 1
  Jump → B1

B3 (exit):
  Return(v3)
```

### SSA (Static Single Assignment)

各値に一意の ID (v0, v1, ...) を付与。値は一度だけ定義される。
合流点 (ループヘッダ等) では **Phi ノード** が値を選択:

```
v3 = Phi(B0:v1, B2:v6)
// B0 から来たら v1 (初期値 0)
// B2 から来たら v6 (前回の sum + i)
```

### IR Opcode

| カテゴリ | Opcode |
|---|---|
| 定数 | Const, Param, Undefined |
| 算術 | Add, Sub, Mul, Div, Mod, Negate |
| 比較 | LessThan, Equal, StrictEqual, ... |
| ビット | BitAnd, BitOr, ShiftLeft, ShiftRight |
| 制御 | Branch, Jump, Return |
| 配列 | ArrayGet, ArraySet, ArrayLength |
| オブジェクト | LoadThis, LoadProperty, StoreProperty, Alloc |
| 変数 | LoadGlobal, StoreGlobal, LoadUpvalue, StoreUpvalue |
| 関数 | Call, TypeGuard |
| SSA | Phi |

ファイル: `src/ir/types.ts`, `src/ir/builder.ts`

---

## 7. 最適化パス

**IR 上で複数のパスを繰り返し適用 (fixpoint)**

```
Inlining → Constant Folding → CSE → DCE → LICM → Strength Reduction
  ↑                                                       |
  +--------- changed? もう一度 ←--------------------------+
```

### Inlining (関数インライン展開)

```
// Before                        // After
v3 = Call(square, v0)            v3 = Mul(v0, v0)
```

呼び出し先の IR を呼び出し元にコピー。SSA なので変数の衝突がない。

### Constant Folding (定数畳み込み)

```
Add(Const(3), Const(4)) → Const(7)
```

### CSE (Common Subexpression Elimination)

```
v5 = Mul(v0, v1)
v6 = Mul(v0, v1)    → v6 の使用を v5 に付け替え
```

### DCE (Dead Code Elimination)

```
v7 = Mul(100, 200)   // 誰にも使われない → 削除
```

### LICM (Loop-Invariant Code Motion)

```
// Before: x*2 がループ内で毎回計算
for (i < n) { sum += x * 2; }

// After: x*2 をループ外に移動
t = x * 2;
for (i < n) { sum += t; }
```

**LoadProperty のループ外移動** が特に効果的:
`this.x * this.x` のメモリアクセスをループ外に出すと 79 倍高速化。

### Strength Reduction (演算強度削減)

```
x * 4  → x << 2    (シフトに変換)
x * 0  → 0         (恒等変換)
x + 0  → x
```

### Range Analysis (値域解析)

各値の [min, max] を追跡して i32 overflow を検出:

```
for (i = 0; i < n; i++) sum += i * i;
// n が Param → i の range: [0, 2^31)
// i*i の range: [0, 2^62) → i32 に収まらない → f64 に昇格
```

**V8 との対応**: V8 の TurboFan / Turboshaft の最適化パスに相当。

ファイル: `src/ir/optimize.ts`, `src/ir/inline.ts`, `src/ir/licm.ts`, `src/ir/cse.ts`, `src/ir/strength-reduce.ts`, `src/ir/range.ts`

---

## 8. Wasm Codegen (コード生成)

**最適化済み IR → WebAssembly バイナリ**

### Stackifier (CFG → 構造化制御フロー)

Wasm は goto がない。CFG の back edge (ループ) と forward edge (分岐) を
`block` / `loop` / `br` / `br_if` に変換:

```
;; ループ
block $exit
  loop $loop
    ;; ループ条件
    br_if $exit      ;; 条件 false → exit
    ;; ループ本体
    br $loop          ;; → loop head
  end
end
```

### 型マッピング

| IR 型 | Wasm 型 | 用途 |
|---|---|---|
| i32 | i32 | 整数演算 (Range が i32 安全な場合) |
| f64 | f64 | 浮動小数点 (overflow の可能性がある場合) |
| 配列 | WasmGC array ref | WasmGC の array.get/set (bounds check 自動) |
| this | i32 (memory addr) | Linear memory 上のオブジェクト |

### 生成される Wasm

```wat
(func $f (param $n i32) (result i32)
  (local $sum i32) (local $i i32)
  ;; sum = 0, i = 0 (locals are zero-initialized)
  block $exit
    loop $loop
      local.get $i
      local.get $n
      i32.lt_s
      i32.eqz
      br_if $exit
      ;; sum += i
      local.get $sum
      local.get $i
      i32.add
      local.set $sum
      ;; i++
      local.get $i
      i32.const 1
      i32.add
      local.set $i
      br $loop
    end
  end
  local.get $sum
)
```

**V8 との対応**: V8 の CodeGenerator (ネイティブ機械語生成) に相当。
ただし jsmini は Wasm を経由するので、V8 の Liftoff / TurboFan がさらにネイティブに変換する。

ファイル: `src/ir/codegen.ts`, `src/jit/wasm-builder.ts`

---

## 9. 実行時の全体像

```
function add(a, b) { return a + b; }
var sum = 0;
for (var i = 0; i < 10000; i++) { sum = add(sum, i); }
```

### Timeline

| 呼び出し # | add() の実行方式 | 備考 |
|---|---|---|
| 1-4 | Bytecode VM | 型フィードバック収集: add(int32, int32) |
| 5 | → Wasm compile | monomorphic + threshold 到達 |
| 6+ | Wasm (i32.add) | IR: Param(0) + Param(1) → inline 展開でループ内に |
| (もし add("a", "b")) | → deopt → VM | 型仮定が崩れた |

### 各エンジンとの対応表

| jsmini | V8 | JSC | SpiderMonkey |
|---|---|---|---|
| Lexer | Scanner | Lexer | TokenStream |
| Parser | Parser | Parser | Parser |
| Compiler | Ignition (bytecode gen) | LLInt (bytecode gen) | Bytecode Emitter |
| VM | Ignition (interpreter) | LLInt (interpreter) | Baseline Interpreter |
| Type Feedback | Feedback Vector | Watchpoints | CacheIR |
| Direct JIT | — | — | Baseline JIT |
| IR Builder | Maglev / Turboshaft | DFG / FTL (B3) | WarpBuilder (MIR) |
| Optimizer | Turboshaft passes | DFG/FTL passes | IonMonkey |
| Codegen | Code Generator | Air → asm | MIR → LIR → asm |

---

## 10. 学び: IR 最適化 × Wasm バックエンド

jsmini は Wasm を JIT のバックエンドとして使う。これにより:

**メリット**:
- ネイティブ機械語生成が不要 (V8 が Wasm をさらにネイティブに変換)
- ポータブル (どのプラットフォームでも動く)
- GC 不要 (WasmGC でランタイムが管理)

**制約**:
- V8 の TurboFan が Wasm レベルで同等の最適化をやるため、IR 側の最適化 (CSE, LICM 等) が速度差として見えにくい
- ただし **メモリアクセスの LICM** (LoadProperty のループ外移動) は V8 Liftoff がやらないため効果あり
- **正確性** (Range Analysis → f64 昇格) は IR パスの独自の価値

### 速度改善が効いたケース

| 最適化 | 効果 | 理由 |
|---|---|---|
| IR Inlining | 1.7x vs Direct | 関数呼び出しオーバーヘッド削除 |
| LICM × LoadProperty | 79x vs Direct | メモリアクセスをループ外に |
| Range → f64 昇格 | 正確性 | i32 overflow を防止 |
| クロージャ IR 対応 | 13x vs VM | VM → Wasm に載せただけで高速化 |

### 速度改善が効かなかったケース

| 最適化 | 効果 | 理由 |
|---|---|---|
| CSE (純粋算術) | ~0x | V8 TurboFan が同等の最適化 |
| LICM (純粋算術) | ~0x | 同上 |
| Strength Reduction | ~0x | 現代 CPU では mul ≒ shl |
