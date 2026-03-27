# PLAN: Flat VM への移行

## 概要

jsmini の Bytecode VM を「オブジェクト配列」ベースから「Uint8Array フラットバイト列」ベースに移行する。
V8-JIT に依存せず、構造的に Tree-Walking より速い VM を実現する。

## 現状の問題

```
V8-JIT なし:
  Tree-Walking:  21ms
  Object VM:     33ms (1.5x 遅い)
  Flat VM (実験): 9.6ms (2.2x 速い)
```

## 変更対象

### 1. bytecode.ts — 命令フォーマットの変更

現在:
```typescript
type Instruction = { op: string; operand?: number };
type BytecodeFunction = {
  bytecode: Instruction[];
  constants: unknown[];
};
```

変更後:
```typescript
// Opcode は数値 (1バイト)
const enum Op {
  LdaConst      = 0x01,  // LdaConst <u8 index>
  LdaUndefined  = 0x02,
  LdaNull       = 0x03,
  LdaTrue       = 0x04,
  LdaFalse      = 0x05,
  Add           = 0x10,
  Sub           = 0x11,
  Mul           = 0x12,
  Div           = 0x13,
  Mod           = 0x14,
  Negate        = 0x15,
  Equal         = 0x20,
  StrictEqual   = 0x21,
  LessThan      = 0x22,
  // ...
  LdaLocal      = 0x30,  // LdaLocal <u8 slot>
  StaLocal      = 0x31,  // StaLocal <u8 slot>
  LdaGlobal     = 0x32,  // LdaGlobal <u8 name_index>
  StaGlobal     = 0x33,  // StaGlobal <u8 name_index>
  Jump          = 0x40,  // Jump <u16 addr>
  JumpIfFalse   = 0x41,  // JumpIfFalse <u16 addr>
  JumpIfTrue    = 0x42,
  Call          = 0x50,  // Call <u8 argc>
  Return        = 0x51,
  Pop           = 0x60,
  Dup           = 0x61,
  // Phase 2-3 ops...
  CreateObject  = 0x70,
  SetProperty   = 0x71,  // SetProperty <u8 name_index>
  GetProperty   = 0x72,
  CreateArray   = 0x73,  // CreateArray <u8 count>
  Throw         = 0x80,
  TypeOf        = 0x81,
  // ...
}

type BytecodeFunction = {
  name: string;
  paramCount: number;
  localCount: number;
  code: Uint8Array;          // フラットバイト列
  constants: unknown[];       // 定数テーブル (文字列、関数等の非数値)
  handlers: ExceptionHandler[];
};
```

### 2. compiler.ts — バイト列の emit

現在:
```typescript
emit(op: Opcode, operand?: number) {
  this.bytecode.push({ op, operand });
}
```

変更後:
```typescript
// バイトバッファに直接書き込み
private buf: number[] = [];

emitByte(byte: number) {
  this.buf.push(byte);
}

emitOp(op: number) {
  this.buf.push(op);
}

emitOpU8(op: number, operand: number) {
  this.buf.push(op, operand);
}

emitOpU16(op: number, addr: number) {
  this.buf.push(op, (addr >> 8) & 0xff, addr & 0xff);
}

// パッチバック: 2バイトアドレスを後から書き換え
patchU16(offset: number, addr: number) {
  this.buf[offset + 1] = (addr >> 8) & 0xff;
  this.buf[offset + 2] = addr & 0xff;
}

finish(): Uint8Array {
  return new Uint8Array(this.buf);
}
```

### 3. vm.ts — ディスパッチループ

現在:
```typescript
while (pc < bytecode.length) {
  const instr = bytecode[pc++];
  switch (instr.op) {
    case "Add": ...
  }
}
```

変更後:
```typescript
const code = func.code;

while (true) {
  switch (code[pc++]) {
    case Op.LdaConst:
      stack[++sp] = constants[code[pc++]];
      break;
    case Op.LdaLocal:
      stack[++sp] = locals[code[pc++]];
      break;
    case Op.Add: {
      const r = stack[sp--];
      const l = stack[sp--];
      // 型チェック: 文字列連結対応
      if (typeof l === "string" || typeof r === "string") {
        stack[++sp] = String(l) + String(r);
      } else {
        stack[++sp] = (l as number) + (r as number);
      }
      break;
    }
    case Op.Jump:
      pc = (code[pc] << 8) | code[pc + 1];
      break;
    case Op.Return:
      // ...
  }
}
```

### 4. disassembler — バイト列のデコード

バイト列を読んで人間可読な形式に変換。命令のバイト長を opcode ごとに定義。

```typescript
const OP_SIZE: Record<number, number> = {
  [Op.LdaConst]: 2,    // op + u8
  [Op.Add]: 1,          // op only
  [Op.Jump]: 3,         // op + u16
  [Op.Call]: 2,         // op + u8
  // ...
};
```

## 移行戦略

### Phase A: Flat VM を並行実装

- 既存の Object VM (`vm.ts`) はそのまま残す
- 新しい Flat VM (`vm-flat.ts`) を並行実装
- `--flat-vm` フラグで切り替え
- 全テストが両方で通ることを確認

### Phase B: テスト通過

Step ごとに段階的に移行:

1. **A-1**: リテラル + 算術 (LdaConst, Add, Sub, Mul, Div)
2. **A-2**: 変数 + 制御フロー (LdaLocal, StaLocal, LdaGlobal, StaGlobal, Jump, JumpIfFalse)
3. **A-3**: 関数 (Call, Return, CallFrame)
4. **A-4**: 文字列 + console.log (GetProperty, CallMethod)
5. **A-5**: Phase 2 構文 (CreateObject, SetProperty, CreateArray, Throw, TypeOf)
6. **A-6**: Phase 3 構文 (残り全部)
7. **A-7**: 全テスト通過 + ベンチマーク

### Phase C: 旧 VM 削除

- Object VM を削除
- Flat VM をデフォルトに
- JIT コンパイラも Flat VM に対応

## スタックの型

### 問題: unknown[] vs TypedArray

実験では `Float64Array` を使ったが、jsmini は文字列・オブジェクト・boolean も扱う。
`Float64Array` では number しか格納できない。

### 選択肢

**A. unknown[] のまま (型混在スタック)**
```typescript
const stack: unknown[] = [];
```
- メリット: 全 JS 値を格納できる
- デメリット: TypedArray の連続メモリの恩恵がない

**B. Tagged Value (NaN-boxing)**
```typescript
// 64bit float の NaN 空間に他の型をエンコード
// V8 や SpiderMonkey が使う手法
// TypeScript では実装困難 (BigInt or ArrayBuffer が必要)
```

**C. ハイブリッド: 数値は Float64Array、他は別配列**
```typescript
const numStack = new Float64Array(256);
const objStack: unknown[] = [];
// opcode で使い分け
```

### 推奨: A (unknown[] のまま)

理由:
- 実装が簡単
- Flat VM の速度改善の主因は **オブジェクトプロパティアクセスの排除** と **数値 opcode の switch** であり、スタックの TypedArray 化は副次的
- 実験では `unknown[]` でも Object VM より十分速いはず

## 期待される結果

```
V8-JIT なし:
  Tree-Walking:  21ms
  Object VM:     33ms
  Flat VM:       ~10ms  ← 予測

V8-JIT あり:
  Tree-Walking:  2.2ms
  Object VM:     1.6ms
  Flat VM:       ~0.8ms ← 予測
```

Flat VM は V8-JIT なしでも Tree-Walking の 2 倍速く、
V8-JIT ありでは TurboFan がフラットなバイト列の数値 switch をさらに最適化して
Object VM より速くなる。

## 影響範囲

| ファイル | 変更内容 |
|----------|----------|
| `vm/bytecode.ts` | Instruction 型 → Op enum + バイト列フォーマット |
| `vm/compiler.ts` | emit メソッドをバイト列書き込みに変更 |
| `vm/vm.ts` | ディスパッチループを `code[pc++]` ベースに |
| `vm/vm-flat.ts` | 新規作成（並行期間） |
| `vm/index.ts` | `--flat-vm` フラグ対応 |
| `jit/wasm-compiler.ts` | Flat bytecode からの Wasm 変換 |
| `jit/feedback.ts` | 変更なし (VM 非依存) |
| `jit/jit.ts` | BytecodeFunction の型変更に追従 |
| `src/bench.ts` | Flat VM のベンチマーク追加 |
