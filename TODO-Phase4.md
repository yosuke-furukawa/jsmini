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

- [ ] `src/vm/bytecode.ts` — Opcode 定義 (数値 enum ではなく string literal union)
- [ ] 命令のオペランド形式を決定
- [ ] 定数テーブルの設計

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

- [ ] `src/vm/compiler.ts` — BytecodeCompiler クラス
- [ ] リテラル → `LdaConst`
- [ ] 二項演算 → 左辺コンパイル、右辺コンパイル、`Add`/`Sub`/...
- [ ] 変数宣言 → ローカルスロット割り当て + `StaLocal`
- [ ] 変数参照 → `LdaLocal` / `LdaGlobal`
- [ ] if/else → `JumpIfFalse` + `Jump`（パッチバック）
- [ ] while/for → `Jump` + `JumpIfFalse`（ループ）
- [ ] 関数宣言 → 内部関数を別途コンパイル、定数テーブルに格納
- [ ] 関数呼び出し → 引数 push、関数 push、`Call`
- [ ] return → `Return`
- [ ] `--print-bytecode` デバッグ出力

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

- [ ] `src/vm/vm.ts` — VM クラス
- [ ] メインループ: `while (pc < bytecode.length) { switch (opcode) { ... } }`
- [ ] 定数ロード (`LdaConst`, `LdaUndefined`, ...)
- [ ] 算術演算 (`Add`, `Sub`, ...)
- [ ] 比較演算
- [ ] 変数ロード/ストア (`LdaLocal`, `StaLocal`, `LdaGlobal`, `StaGlobal`)
- [ ] ジャンプ (`Jump`, `JumpIfFalse`)
- [ ] 関数呼び出し (`Call`, `Return`) — CallFrame の push/pop
- [ ] テスト: tree-walking と同じ結果になることを検証

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

- [ ] `src/index.ts` を修正: `--vm` フラグで tree-walking / bytecode VM を切り替え
- [ ] `--print-bytecode` フラグで生成されたバイトコードをダンプ
- [ ] package.json に `"vm"` スクリプトを追加

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

- [ ] 全ユニットテスト (272件) を VM モードでも実行
  - `evaluate()` と `vmEvaluate()` の両方で同じ結果になることを検証
  - テストヘルパー: `function run(source) { assert.equal(evaluate(source), vmEvaluate(source)); }`
- [ ] VM 固有のテスト
  - バイトコード生成の正確性
  - スタックの状態
  - CallFrame の管理

---

## 実装順序

```
Step 4-1: 命令セット設計 + bytecode.ts
    ↓
Step 4-2a: コンパイラ基本 (リテラル + 算術)
    ↓
Step 4-2b: コンパイラ (変数 + 制御フロー)
    ↓
Step 4-2c: コンパイラ (関数)
    ↓
Step 4-3a: VM 基本 (算術 + 変数)
    ↓
Step 4-3b: VM (制御フロー + 関数)
    ↓
Step 4-4: エントリポイント統合 + --print-bytecode
    ↓
Step 4-5: 全テスト通過確認
    ↓
Step 4-6: Phase 2-3 構文の VM 対応
```

方針: **最初は Phase 1 相当 (数値演算 + 変数 + if + for + 関数) だけを VM で動かす。**
Phase 2-3 の構文 (オブジェクト、クラス、分割代入等) は後から段階的に追加。

---

## browser-book との対応

| browser-book の記述 | jsmini での体験 |
|---|---|
| バイトコードジェネレータが AST からバイトコードを生成 | `BytecodeCompiler` が AST → バイトコード列 |
| `Ldar`, `Add`, `Return` のようなバイトコード | 自分で設計した命令セット |
| インタープリタがバイトコードを機械語に翻訳 | VM の `switch` ディスパッチループ |
| `node --print-bytecode` の出力 | `--print-bytecode` で同様の出力 |
