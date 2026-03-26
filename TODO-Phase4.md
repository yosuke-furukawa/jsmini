# TODO - Phase 4: Bytecode VM 移行

browser-book 第12章「バイトコードジェネレータとインタプリタ」の解像度を上げるため、
tree-walking interpreter をバイトコード VM に移行する。

既存の tree-walking interpreter は残し、`--vm` フラグで切り替えられるようにする。
全ユニットテストが両方のモードで通ることを目標とする。

---

## 設計判断: スタックベース vs レジスタベース

| | スタックベース | レジスタベース |
|---|---|---|
| 例 | JVM, .NET CLR, CPython, QuickJS | V8 (Ignition), Lua |
| 命令 | `push`, `pop`, `add` (暗黙のスタック操作) | `add r0, r1, r2` (オペランド明示) |
| 実装の簡単さ | 簡単 | やや複雑 |
| 命令数 | 多い (push/pop が頻出) | 少ない |
| browser-book との関連 | — | V8 Ignition がレジスタベース |

**推奨: スタックベースから始める**。実装が簡単で、バイトコードの概念を理解するには十分。
V8 がレジスタベースであることは browser-book で説明し、jsmini はスタックベースで教育的に対比する。

---

## 4-1. バイトコード命令セットの設計

最小の命令セットから始め、テストを通しながら拡張していく。

### 最初に必要な命令 (Phase 1 相当)

```
# 定数ロード
LdaConst <index>       # 定数テーブルから値をロードしてスタックに push
LdaUndefined           # undefined を push
LdaNull                # null を push
LdaTrue                # true を push
LdaFalse               # false を push

# 算術
Add                    # pop 2つ、足し算して push
Sub                    # pop 2つ、引き算して push
Mul                    # pop 2つ、掛け算して push
Div                    # pop 2つ、割り算して push
Mod                    # pop 2つ、余りを push
Negate                 # pop 1つ、符号反転して push

# 比較
Equal                  # pop 2つ、== して push
StrictEqual            # pop 2つ、=== して push
NotEqual               # pop 2つ、!= して push
StrictNotEqual         # pop 2つ、!== して push
LessThan               # pop 2つ、< して push
GreaterThan            # pop 2つ、> して push
LessThanOrEqual        # pop 2つ、<= して push
GreaterThanOrEqual     # pop 2つ、>= して push

# 論理
LogicalNot             # pop 1つ、! して push

# 変数
LdaGlobal <name>       # グローバル変数の値を push
StaGlobal <name>       # スタックトップの値をグローバル変数に格納
LdaLocal <slot>        # ローカル変数の値を push
StaLocal <slot>        # スタックトップの値をローカル変数に格納

# 制御フロー
Jump <offset>          # 無条件ジャンプ
JumpIfFalse <offset>   # スタックトップが falsy ならジャンプ
JumpIfTrue <offset>    # スタックトップが truthy ならジャンプ

# 関数
Call <argc>            # スタックから関数 + argc 個の引数を pop、呼び出し、結果を push
Return                 # 関数から戻る（スタックトップが戻り値）

# その他
Pop                    # スタックトップを捨てる
Dup                    # スタックトップを複製
```

- [x] `src/vm/bytecode.ts` — Opcode 定義 (string literal union)
- [x] 命令のオペランド形式を決定 (Instruction = { op, operand? })
- [x] 定数テーブルの設計 (BytecodeFunction.constants)

### 追加命令 (Phase 2-3 対応)

```
# オブジェクト / プロパティ
CreateObject           # 空オブジェクトを push
SetProperty            # pop obj, key, value → obj[key] = value
GetProperty            # pop obj, key → push obj[key]

# 配列
CreateArray <length>   # 要素を pop して配列を push

# typeof
TypeOf                 # pop 1つ、typeof 結果の文字列を push

# その他
Throw                  # pop 1つ、例外を投げる
GetIterator            # for...of 用
IteratorNext           # for...of 用
```

---

## 4-2. AST → Bytecode コンパイラ

AST を走査してバイトコード列を生成する `BytecodeCompiler`。

### 設計

```typescript
// コンパイル結果
type BytecodeFunction = {
  name: string;
  params: string[];
  bytecode: Uint8Array;    // バイトコード列
  constants: unknown[];     // 定数テーブル
  localCount: number;       // ローカル変数スロット数
};
```

### 実装順序

- [x] `src/vm/compiler.ts` — BytecodeCompiler クラス
- [x] リテラル → `LdaConst`
- [x] 二項演算 → 左辺コンパイル、右辺コンパイル、`Add`/`Sub`/...
- [x] 変数宣言 → ローカルスロット割り当て + `StaLocal` / グローバル → `StaGlobal`
- [x] 変数参照 → `LdaLocal` / `LdaGlobal`
- [x] if/else → `JumpIfFalse` + `Jump`（パッチバック）
- [x] while/for → `Jump` + `JumpIfFalse`（ループ）
- [x] 関数宣言 → 内部関数を別途コンパイル、定数テーブルに格納
- [x] 関数呼び出し → 引数 push、関数 push、`Call`
- [x] return → `Return`
- [x] `--print-bytecode` デバッグ出力

### パッチバック (Backpatching)

if/else やループの実装で重要な技法。
コンパイル時にはジャンプ先がまだわからないので、仮のオフセットで命令を emit し、
後からジャンプ先が決まった時点でオフセットを書き換える。

```
// if (test) { consequent } else { alternate }

compile(test)
emit JumpIfFalse ???   ← ジャンプ先未定
compile(consequent)
emit Jump ???          ← ジャンプ先未定
patch JumpIfFalse → ここ
compile(alternate)
patch Jump → ここ
```

---

## 4-3. VM (バイトコードインタープリタ)

バイトコードを実行するスタックマシン。

### 設計

```typescript
class VM {
  stack: unknown[];         // オペランドスタック
  sp: number;               // スタックポインタ
  pc: number;               // プログラムカウンタ
  frames: CallFrame[];      // コールスタック

  execute(func: BytecodeFunction): unknown;
}

type CallFrame = {
  func: BytecodeFunction;
  pc: number;
  bp: number;               // ベースポインタ（ローカル変数の先頭）
  locals: unknown[];         // ローカル変数
};
```

### 実装順序

- [x] `src/vm/vm.ts` — VM クラス
- [x] メインループ: `while` + `switch` ディスパッチ (CallFrame ベース)
- [x] 定数ロード (`LdaConst`, `LdaUndefined`, `LdaNull`, `LdaTrue`, `LdaFalse`)
- [x] 算術演算 (`Add` (文字列連結対応), `Sub`, `Mul`, `Div`, `Mod`, `Negate`)
- [x] 比較演算 (`Equal`, `StrictEqual`, `LessThan`, 等)
- [x] 論理 (`LogicalNot`)
- [x] 変数ロード/ストア (`LdaLocal`, `StaLocal`, `LdaGlobal`, `StaGlobal`)
- [x] ジャンプ (`Jump`, `JumpIfFalse`, `JumpIfTrue`)
- [x] 関数呼び出し (`Call`, `Return`) — CallFrame の push/pop
- [x] プロパティ (`GetProperty`) + メソッド呼び出し (`CallMethod`)
- [x] ネイティブ関数対応 (console.log 等)
- [x] スタック操作 (`Pop`, `Dup`)
- [x] テスト: 316 テスト Green

### ディスパッチの実装

最初は `switch` 文でシンプルに。V8 の Ignition は computed goto (threaded dispatch) を使うが、
TypeScript では `switch` が現実的。

```typescript
while (pc < code.length) {
  const op = code[pc++];
  switch (op) {
    case Op.LdaConst: {
      const index = code[pc++];
      stack[++sp] = constants[index];
      break;
    }
    case Op.Add: {
      const right = stack[sp--];
      const left = stack[sp--];
      stack[++sp] = (left as number) + (right as number);
      break;
    }
    // ...
  }
}
```

---

## 4-4. エントリポイント統合

- [x] `src/index.ts` を修正: `--vm` フラグで tree-walking / bytecode VM を切り替え
- [x] `--print-bytecode` フラグで生成されたバイトコードをダンプ
- [x] ~~package.json に `"vm"` スクリプトを追加~~ — `npm start -- --vm` で対応済み

```bash
# tree-walking (デフォルト)
npm start -- '1 + 2 * 3;'

# bytecode VM
npm start -- --vm '1 + 2 * 3;'

# バイトコードダンプ
npm start -- --print-bytecode 'function add(a, b) { return a + b; }'
# Bytecode for add:
#   0: LdaLocal 0     ; a
#   2: LdaLocal 1     ; b
#   4: Add
#   5: Return
```

---

## 4-5. テスト戦略

- [x] 互換テスト (compat.test.ts): 49 ケースで evaluate と vmEvaluate が同一結果
- [x] VM 固有テスト (vm.test.ts): 58 件
  - 各 Step ごとにリテラル、変数、制御フロー、関数、文字列、オブジェクト等
  - disassemble 出力確認

---

## 実装ステップ (詳細)

Phase 1 の時と同じく、最小のパイプラインを最初に貫通させて構文を足していく。

---

### Step 4-1 [P0] パイプライン貫通: `1 + 2 * 3` がバイトコード経由で動く

**最重要。ここで Compiler → Bytecode → VM の全パイプラインを繋ぐ。**

- [x] `src/vm/bytecode.ts` — Opcode 定義 + Instruction 型
- [x] `src/vm/compiler.ts` — BytecodeCompiler (リテラル + 算術)
- [x] `src/vm/vm.ts` — VM (スタックマシン)
- [x] `src/vm/vm.test.ts` — テスト
- [x] `vmEvaluate(source)` 関数を export

```
ゴール: vmEvaluate("1 + 2 * 3;") === 7
```

---

### Step 4-2 [P0] 変数 + 制御フロー

- [x] Opcode 追加: `LdaGlobal`, `StaGlobal`, `LdaLocal`, `StaLocal`, `Jump`, `JumpIfFalse`, `JumpIfTrue`, `Dup`, 比較/論理演算
- [x] Compiler 拡張: VariableDeclaration, Identifier, AssignmentExpression, IfStatement (パッチバック), WhileStatement, ForStatement, BlockStatement, LogicalExpression (短絡評価)
- [x] VM 拡張: グローバル変数テーブル, ローカル変数スロット, ジャンプ命令
- [x] テスト: 変数、if/else、while、for が VM で動く

```
ゴール: 変数、if/else、while、for が VM で動く
```

---

### Step 4-3 [P1] 関数

- [x] Opcode 追加: `Call`, `Return` (既存), `CallMethod`, `GetProperty`
- [x] Compiler 拡張: FunctionDeclaration (別 BytecodeFunction にコンパイル), CallExpression, ReturnStatement, MemberExpression
- [x] VM 拡張: CallFrame push/pop, ネイティブ関数対応
- [x] テスト: 関数宣言/呼び出し, 再帰 (factorial), グローバル参照

```
ゴール: Phase 1 相当の全テストが VM で通る
```

---

### Step 4-4 [P1] `--print-bytecode` + エントリポイント統合

- [x] バイトコードの逆アセンブラ (disassembler)
  - 定数値、変数名、ジャンプ先、argc をコメント表示
  - ネスト関数も再帰的にダンプ
- [x] `src/index.ts` 修正: `--vm`, `--print-bytecode` フラグ対応
- [x] テスト

```bash
$ npm start -- --print-bytecode 'function add(a, b) { return a + b; }'

== add ==
  0000: LdaLocal 0       ; a
  0002: LdaLocal 1       ; b
  0004: Add
  0005: Return

$ npm start -- --vm 'console.log(1 + 2);'
3
```

```
ゴール: browser-book の node --print-bytecode と同じ体験ができる
```

---

### Step 4-5 [P2] 文字列 + console.log の VM 対応

- [x] `StringLiteral` → `LdaConst` (Literal 共通で対応済み)
- [x] 文字列連結: `Add` で typeof チェック
- [x] `console.log` → `CallMethod` + ネイティブ関数
- [x] `vmEvaluate` に `ConsoleOptions` 対応
- [x] テスト (6件)

```
ゴール: console.log("hello " + "world") が VM で動く
```

---

### Step 4-6 [P2] Phase 2 構文の VM 対応

- [x] オブジェクトリテラル: `CreateObject` + `SetProperty` (Dup でチェーン)
- [x] プロパティアクセス: `GetProperty`, `GetPropertyComputed`
- [x] プロパティ代入: `SetPropertyAssign`
- [x] 配列リテラル: `CreateArray <count>`
- [x] `typeof`: `TypeOf` 命令
- [x] `throw` / `try` / `catch`: `Throw` 命令 + 例外ハンドラテーブル (`BytecodeFunction.handlers`)
- [x] `let` / `const` (ブロックスコープ) — コンパイラの scopeStack でスロットをシャドウイング
- [x] `new` / `this` — Construct 命令 + CallFrame.thisValue + LoadThis

---

### Step 4-7 [P3] Phase 3 構文の VM 対応

- [x] アロー関数 → BytecodeFunction として compile
- [x] テンプレートリテラル → LdaConst + Add チェーン
- [x] `for...of` → カウンタベースのループに desugar
- [x] `++` / `--` (prefix/postfix) → Increment/Decrement 命令
- [x] 複合代入 (`+=` 等) → load + op + store
- [x] `break` / `continue` → Jump に変換 (コンパイラのループスタックでパッチバック)
- [x] プロトタイプチェーン — Construct で __proto__ 設定、GetProperty でチェーン探索
- [x] クラス — ClassDeclaration をコンパイル (constructor + prototype メソッド)
- [x] 分割代入 — compileBindingTarget で ObjectPattern/ArrayPattern を展開
- [x] スプレッド — ArrayPush/ArraySpread 命令
- [x] `in`, `instanceof` — In/Instanceof 命令

---

### Step 4-8 [P3] 全テスト通過確認 + パフォーマンス比較

- [x] VM 固有テスト 58 件 + 既存 272 件 + 互換テスト 49 件 = 379 件 Green
- [x] 互換テスト (compat.test.ts): evaluate と vmEvaluate が 49 ケースで同一結果
- [x] Test262 を VM モードで実行: 225/816 (27.6%) — tree-walking と同一
- [x] パフォーマンス比較: `npm run bench`
  - fibonacci(25): **3.4x** (VM faster)
  - for loop (10000): **1.3x** (VM faster)
  - nested loop (100x100): **1.9x** (VM faster)

---

## 実装フロー (全体)

```
Step 4-1: 1 + 2 * 3 が動く (パイプライン貫通)
    ↓
Step 4-2: 変数 + if/else + while/for
    ↓
Step 4-3: 関数 (CallFrame)
    ↓
  ここで Phase 1 相当が VM で動く
    ↓
Step 4-4: --print-bytecode + エントリポイント
    ↓
  ここで browser-book の解像度が上がる
    ↓
Step 4-5: 文字列 + console.log
    ↓
Step 4-6: Phase 2 構文 (オブジェクト, 配列, let/const, try/catch, new, this)
    ↓
Step 4-7: Phase 3 構文 (アロー, class, 分割代入, spread, for-of 等)
    ↓
Step 4-8: 全テスト通過 + パフォーマンス比較
```

**最初のマイルストーンは Step 4-1**。`1 + 2 * 3` → `7` がバイトコード経由で動けば、
残りは構文を足す作業。Phase 1 の Step 1-1 と同じ「パイプライン貫通」の考え方。

---

## browser-book との対応

| browser-book の記述 | jsmini での体験 |
|---|---|
| バイトコードジェネレータが AST からバイトコードを生成 | `BytecodeCompiler` が AST → バイトコード列 |
| `Ldar`, `Add`, `Return` のようなバイトコード | 自分で設計した命令セット |
| インタープリタがバイトコードから機械語を生成し実行 | VM の `switch` ディスパッチループ |
| `node --print-bytecode` の出力 | `--print-bytecode` で同様の出力 |
| tree-walking → bytecode への移行の意味 | 実際に両方を実装して比較 |
| 統計情報の収集 (Phase 5 への布石) | VM 実行中に型情報を記録する仕組みを仕込める |
