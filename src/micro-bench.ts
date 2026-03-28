// RESEARCH-WHY-BYTECODE-IS-SLOW.md の主張を検証するマイクロベンチマーク
// 条件を変えて、何がボトルネックなのかを切り分ける

// === for loop sum (10000) を手書きバイトコードで実行 ===
// var sum = 0; for (var i = 0; i < 10000; i = i + 1) { sum = sum + i; } sum;

function bench(name: string, fn: () => unknown, warmup = 5, runs = 20): number {
  for (let i = 0; i < warmup; i++) fn();
  const times: number[] = [];
  let result: unknown;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    result = fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`  ${name.padEnd(45)} ${avg.toFixed(2)}ms  result=${result}`);
  return avg;
}

console.log("=== マイクロベンチマーク: 何がボトルネックか ===\n");

// ---- 1. RESEARCH の実験再現: Float64Array のみ、手書きバイトコード ----

const OP = {
  LDA_CONST: 1,
  LDA_SLOT: 2,
  STA_SLOT: 3,
  ADD: 4,
  LESS_THAN: 5,
  JUMP_IF_FALSE: 6,
  JUMP: 7,
  HALT: 8,
  INC: 9,
};

// 手書きバイトコード: for loop sum (10000)
// slot0 = sum, slot1 = i
const flatCode = new Uint8Array([
  // 0: sum = 0
  OP.LDA_CONST, 0,     // push 0
  OP.STA_SLOT, 0,      // slot[0] = 0
  // 4: i = 0
  OP.LDA_CONST, 0,     // push 0
  OP.STA_SLOT, 1,      // slot[1] = 0
  // 8: loop test: i < 10000
  OP.LDA_SLOT, 1,      // push slot[1] (i)
  OP.LDA_CONST, 1,     // push 10000
  OP.LESS_THAN,         // i < 10000
  OP.JUMP_IF_FALSE, 0, 30, // if false, jump to 30
  // 15: sum = sum + i
  OP.LDA_SLOT, 0,      // push slot[0] (sum)
  OP.LDA_SLOT, 1,      // push slot[1] (i)
  OP.ADD,               // sum + i
  OP.STA_SLOT, 0,      // slot[0] = sum + i
  // 22: i = i + 1
  OP.LDA_SLOT, 1,      // push slot[1] (i)
  OP.INC,               // i + 1
  OP.STA_SLOT, 1,      // slot[1] = i + 1
  // 27: jump back
  OP.JUMP, 0, 8,       // jump to 8
  // 30: return sum
  OP.LDA_SLOT, 0,      // push slot[0]
  OP.HALT,
]);
const flatConsts = new Float64Array([0, 10000]);

console.log("1. Float64Array スタック + Float64Array スロット (RESEARCH の実験条件):");
bench("Float64Array stack + Float64Array slots", () => {
  const code = flatCode;
  const constants = flatConsts;
  const slots = new Float64Array(2);
  const stack = new Float64Array(64);
  let pc = 0;
  let sp = -1;

  while (true) {
    switch (code[pc++]) {
      case OP.LDA_CONST:
        stack[++sp] = constants[code[pc++]];
        break;
      case OP.LDA_SLOT:
        stack[++sp] = slots[code[pc++]];
        break;
      case OP.STA_SLOT:
        slots[code[pc++]] = stack[sp--];
        break;
      case OP.ADD: {
        const r = stack[sp--];
        stack[sp] = stack[sp] + r;
        break;
      }
      case OP.LESS_THAN: {
        const r = stack[sp--];
        const l = stack[sp--];
        stack[++sp] = l < r ? 1 : 0;
        break;
      }
      case OP.JUMP_IF_FALSE: {
        const addr = (code[pc] << 8) | code[pc + 1];
        pc += 2;
        if (stack[sp--] === 0) pc = addr;
        break;
      }
      case OP.JUMP:
        pc = (code[pc] << 8) | code[pc + 1];
        break;
      case OP.INC:
        stack[sp] = stack[sp] + 1;
        break;
      case OP.HALT:
        return stack[sp];
    }
  }
});

// ---- 2. unknown[] スタック + unknown[] スロット (Flat VM の実装条件) ----

console.log("\n2. unknown[] スタック + unknown[] スロット (現在の Flat VM の条件):");
bench("unknown[] stack + unknown[] slots", () => {
  const code = flatCode;
  const constants = [0, 10000]; // plain array
  const slots: unknown[] = [undefined, undefined];
  const stack: unknown[] = [];
  let pc = 0;
  let sp = -1;

  while (true) {
    switch (code[pc++]) {
      case OP.LDA_CONST:
        stack[++sp] = constants[code[pc++]];
        break;
      case OP.LDA_SLOT:
        stack[++sp] = slots[code[pc++]];
        break;
      case OP.STA_SLOT:
        slots[code[pc++]] = stack[sp--];
        break;
      case OP.ADD: {
        const r = stack[sp--] as number;
        stack[sp] = (stack[sp] as number) + r;
        break;
      }
      case OP.LESS_THAN: {
        const r = stack[sp--] as number;
        const l = stack[sp--] as number;
        stack[++sp] = l < r ? 1 : 0;
        break;
      }
      case OP.JUMP_IF_FALSE: {
        const addr = (code[pc] << 8) | code[pc + 1];
        pc += 2;
        if (stack[sp--] === 0) pc = addr;
        break;
      }
      case OP.JUMP:
        pc = (code[pc] << 8) | code[pc + 1];
        break;
      case OP.INC:
        stack[sp] = (stack[sp] as number) + 1;
        break;
      case OP.HALT:
        return stack[sp];
    }
  }
});

// ---- 3. Map グローバル (Object VM / 現 Flat VM のトップレベル変数) ----

console.log("\n3. unknown[] スタック + Map グローバル (Object VM と同じ):");
bench("unknown[] stack + Map globals", () => {
  const code = flatCode;
  const constants = ["sum", "i", 0, 10000]; // index 0,1 = names, 2,3 = values
  const globals = new Map<string, unknown>();
  const stack: unknown[] = [];
  let pc = 0;
  let sp = -1;

  // Rewritten opcodes for Map-based globals
  // sum = 0
  globals.set("sum", 0);
  globals.set("i", 0);

  // Simulating the hot loop with Map access
  let sum = 0;
  let i = 0;
  while (i < 10000) {
    sum = sum + i;
    i = i + 1;
  }
  // 上は直接計算だから不公平。Map 経由でやる:
  globals.set("sum", 0);
  globals.set("i", 0);
  while ((globals.get("i") as number) < 10000) {
    globals.set("sum", (globals.get("sum") as number) + (globals.get("i") as number));
    globals.set("i", (globals.get("i") as number) + 1);
  }
  return globals.get("sum");
});

// ---- 4. Object VM 命令形式 (string switch + object property) ----

type ObjInstr = { op: string; operand?: number };
const objBytecode: ObjInstr[] = [
  { op: "LdaConst", operand: 0 },   // 0
  { op: "StaGlobal", operand: 1 },  // sum = 0
  { op: "Pop" },
  { op: "LdaConst", operand: 0 },   // 0
  { op: "StaGlobal", operand: 2 },  // i = 0
  { op: "Pop" },
  // 6: loop test
  { op: "LdaGlobal", operand: 2 },  // i
  { op: "LdaConst", operand: 3 },   // 10000
  { op: "LessThan" },
  { op: "JumpIfFalse", operand: 20 },
  // 10: sum = sum + i
  { op: "LdaGlobal", operand: 1 },  // sum
  { op: "LdaGlobal", operand: 2 },  // i
  { op: "Add" },
  { op: "StaGlobal", operand: 1 },  // sum = ...
  { op: "Pop" },
  // 15: i = i + 1
  { op: "LdaGlobal", operand: 2 },  // i
  { op: "LdaConst", operand: 4 },   // 1
  { op: "Add" },
  { op: "StaGlobal", operand: 2 },  // i = ...
  // 19: jump back
  { op: "Jump", operand: 6 },
  // 20: return sum
  { op: "LdaGlobal", operand: 1 },
];
const objConstants: unknown[] = [0, "sum", "i", 10000, 1];

console.log("\n4. Object VM 形式 (string switch + object property + Map globals):");
bench("Object[] + string switch + Map globals", () => {
  const bytecode = objBytecode;
  const constants = objConstants;
  const globals = new Map<string, unknown>();
  const stack: unknown[] = [];
  let pc = 0;
  let sp = -1;

  while (pc < bytecode.length) {
    const instr = bytecode[pc++];
    switch (instr.op) {
      case "LdaConst":
        stack[++sp] = constants[instr.operand!];
        break;
      case "LdaGlobal": {
        const name = constants[instr.operand!] as string;
        stack[++sp] = globals.get(name);
        break;
      }
      case "StaGlobal": {
        const name = constants[instr.operand!] as string;
        globals.set(name, stack[sp]);
        break;
      }
      case "LessThan": {
        const r = stack[sp--] as number;
        const l = stack[sp--] as number;
        stack[++sp] = l < r;
        break;
      }
      case "JumpIfFalse":
        if (!stack[sp--]) pc = instr.operand!;
        break;
      case "Add": {
        const r = stack[sp--] as number;
        const l = stack[sp--] as number;
        stack[++sp] = l + r;
        break;
      }
      case "Jump":
        pc = instr.operand!;
        break;
      case "Pop":
        sp--;
        break;
    }
  }
  return stack[sp];
});

// ---- 5. 比較: flatVmEvaluate + vmEvaluate ----

import { evaluate } from "./interpreter/evaluator.js";
import { vmEvaluate, flatVmEvaluate } from "./vm/index.js";

const loopSource = `
  var sum = 0;
  for (var i = 0; i < 10000; i = i + 1) {
    sum = sum + i;
  }
  sum;
`;

console.log("\n5. 実際の実装 (パース + コンパイル + 実行):");
bench("tree-walking (evaluate)", () => evaluate(loopSource));
bench("object-vm (vmEvaluate)", () => vmEvaluate(loopSource));
bench("flat-vm (flatVmEvaluate)", () => flatVmEvaluate(loopSource));

console.log("\n=== 結論 ===");
console.log("RESEARCH の実験は Float64Array 限定の条件。");
console.log("unknown[] + Map を使う限り、Flat VM は Object VM と大差ない。");
console.log("真の改善には: (1) Map 排除 (スロット化) (2) コンパイル時変数解決 が必要。");
