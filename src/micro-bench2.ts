// Uint8Array vs Array のインデックスアクセス速度比較
// + 実際の Flat VM が遅い原因の切り分け

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
  console.log(`  ${name.padEnd(50)} ${avg.toFixed(2)}ms  result=${result}`);
  return avg;
}

// ==== 1. 配列アクセス比較 (100万回) ====
console.log("=== 1. 配列アクセス速度比較 (100万回ランダムリード) ===\n");

const N = 1_000_000;
const uint8 = new Uint8Array(256);
const regularArr = new Array(256);
for (let i = 0; i < 256; i++) {
  uint8[i] = i;
  regularArr[i] = i;
}

bench("Uint8Array sequential read", () => {
  let sum = 0;
  for (let i = 0; i < N; i++) sum += uint8[i & 0xff];
  return sum;
});

bench("Array (number) sequential read", () => {
  let sum = 0;
  for (let i = 0; i < N; i++) sum += regularArr[i & 0xff];
  return sum;
});

// ==== 2. switch コスト比較 ====
console.log("\n=== 2. switch コスト比較 (100万回) ===\n");

bench("numeric switch (40 cases, from Uint8Array)", () => {
  let sum = 0;
  const ops = new Uint8Array([1, 2, 3, 4, 5, 0x10, 0x11, 0x12, 0x20, 0x30]);
  for (let i = 0; i < N; i++) {
    switch (ops[i % 10]) {
      case 1: sum += 1; break; case 2: sum += 2; break; case 3: sum += 3; break;
      case 4: sum += 4; break; case 5: sum += 5; break;
      case 0x10: sum += 10; break; case 0x11: sum += 11; break; case 0x12: sum += 12; break;
      case 0x20: sum += 20; break; case 0x30: sum += 30; break;
    }
  }
  return sum;
});

bench("string switch (40 cases, from Object[])", () => {
  let sum = 0;
  const ops = [
    { op: "LdaConst" }, { op: "LdaUndefined" }, { op: "LdaNull" },
    { op: "LdaTrue" }, { op: "LdaFalse" },
    { op: "Add" }, { op: "Sub" }, { op: "Mul" },
    { op: "Equal" }, { op: "LdaLocal" },
  ];
  for (let i = 0; i < N; i++) {
    const instr = ops[i % 10];
    switch (instr.op) {
      case "LdaConst": sum += 1; break; case "LdaUndefined": sum += 2; break;
      case "LdaNull": sum += 3; break; case "LdaTrue": sum += 4; break;
      case "LdaFalse": sum += 5; break; case "Add": sum += 10; break;
      case "Sub": sum += 11; break; case "Mul": sum += 12; break;
      case "Equal": sum += 20; break; case "LdaLocal": sum += 30; break;
    }
  }
  return sum;
});

// ==== 3. Map.get vs Array[index] (100万回) ====
console.log("\n=== 3. Map.get vs Array[index] 比較 (100万回) ===\n");

const testMap = new Map<string, number>();
testMap.set("sum", 42);
testMap.set("i", 99);

const testArr: number[] = [42, 99];

bench("Map.get('sum')", () => {
  let sum = 0;
  for (let i = 0; i < N; i++) sum += testMap.get("sum")!;
  return sum;
});

bench("Array[0]", () => {
  let sum = 0;
  for (let i = 0; i < N; i++) sum += testArr[0];
  return sum;
});

// ==== 4. パース + コンパイルのコスト ====
console.log("\n=== 4. パース + コンパイルのコスト分離 ===\n");

import { parse } from "./parser/parser.js";
import { compile } from "./vm/compiler.js";
import { VM } from "./vm/vm.js";
import { flatCompile } from "./vm/flat-compiler.js";
import { FlatVM } from "./vm/flat-vm.js";

const source = `
  var sum = 0;
  for (var i = 0; i < 10000; i = i + 1) {
    sum = sum + i;
  }
  sum;
`;

bench("parse only", () => parse(source));

bench("parse + compile (Object VM)", () => compile(source));

bench("parse + compile (Flat VM)", () => flatCompile(source));

// コンパイル済みで実行のみ
const precompiledObj = compile(source);
const precompiledFlat = flatCompile(source);

bench("execute only (Object VM)", () => {
  const vm = new VM();
  vm.setGlobal("undefined", undefined);
  return vm.execute(precompiledObj);
});

bench("execute only (Flat VM)", () => {
  const vm = new FlatVM();
  vm.setGlobal("undefined", undefined);
  return vm.execute(precompiledFlat);
});
