// クロスオーバーポイント: どこから VM が TW に勝つか

import { evaluate } from "./interpreter/evaluator.js";
import { vmEvaluate, flatVmEvaluate } from "./vm/index.js";

function bench(fn: () => unknown, warmup = 3, runs = 10): number {
  for (let i = 0; i < warmup; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times.reduce((a, b) => a + b, 0) / times.length;
}

console.log("=== クロスオーバーポイント: TW vs VM の分岐点 ===\n");

// 1. 単純な式 (コンパイルコストが支配的)
console.log("--- 1. 式の複雑さ ---");
const exprs = [
  ["1 + 1",        "1 + 1;"],
  ["1+2*3-4/2",    "1 + 2 * 3 - 4 / 2;"],
  ["nested expr",  "((1+2)*(3+4)-(5+6))*(7+8);"],
];

for (const [name, source] of exprs) {
  const tw = bench(() => evaluate(source));
  const vm = bench(() => vmEvaluate(source));
  const ratio = tw / vm;
  console.log(`  ${name.padEnd(20)} TW: ${tw.toFixed(3)}ms  VM: ${vm.toFixed(3)}ms  ${ratio > 1 ? "VM wins" : "TW wins"} (${ratio.toFixed(2)}x)`);
}

// 2. ループ回数による変化
console.log("\n--- 2. ループ回数 ---");
const loopCounts = [10, 100, 1000, 5000, 10000, 50000];

for (const n of loopCounts) {
  const source = `var s = 0; for (var i = 0; i < ${n}; i = i + 1) { s = s + i; } s;`;
  const tw = bench(() => evaluate(source));
  const vm = bench(() => vmEvaluate(source));
  const flat = bench(() => flatVmEvaluate(source));
  const tvRatio = tw / vm;
  const tfRatio = tw / flat;
  console.log(`  N=${String(n).padEnd(6)} TW: ${tw.toFixed(2).padStart(7)}ms  ObjVM: ${vm.toFixed(2).padStart(7)}ms  FlatVM: ${flat.toFixed(2).padStart(7)}ms  ObjVM ${tvRatio > 1 ? "wins" : "loses"} (${tvRatio.toFixed(2)}x)  FlatVM ${tfRatio > 1 ? "wins" : "loses"} (${tfRatio.toFixed(2)}x)`);
}

// 3. 関数呼び出し回数
console.log("\n--- 3. 関数呼び出し回数 ---");
const callCounts = [10, 100, 1000, 5000, 10000];

for (const n of callCounts) {
  const source = `
    function add(a, b) { return a + b; }
    var s = 0;
    for (var i = 0; i < ${n}; i = i + 1) { s = add(s, i); }
    s;
  `;
  const tw = bench(() => evaluate(source));
  const vm = bench(() => vmEvaluate(source));
  const flat = bench(() => flatVmEvaluate(source));
  const tvRatio = tw / vm;
  const tfRatio = tw / flat;
  console.log(`  N=${String(n).padEnd(6)} TW: ${tw.toFixed(2).padStart(7)}ms  ObjVM: ${vm.toFixed(2).padStart(7)}ms  FlatVM: ${flat.toFixed(2).padStart(7)}ms  ObjVM ${tvRatio > 1 ? "wins" : "loses"} (${tvRatio.toFixed(2)}x)  FlatVM ${tfRatio > 1 ? "wins" : "loses"} (${tfRatio.toFixed(2)}x)`);
}

// 4. 再帰の深さ
console.log("\n--- 4. 再帰 (fibonacci) ---");
const fibNs = [5, 10, 15, 20, 25];

for (const n of fibNs) {
  const source = `
    function fib(n) { if (n <= 1) { return n; } return fib(n-1) + fib(n-2); }
    fib(${n});
  `;
  const tw = bench(() => evaluate(source));
  const vm = bench(() => vmEvaluate(source));
  const flat = bench(() => flatVmEvaluate(source));
  const tvRatio = tw / vm;
  const tfRatio = tw / flat;
  console.log(`  fib(${String(n).padEnd(3)}) TW: ${tw.toFixed(2).padStart(8)}ms  ObjVM: ${vm.toFixed(2).padStart(8)}ms  FlatVM: ${flat.toFixed(2).padStart(8)}ms  ObjVM ${tvRatio > 1 ? "wins" : "loses"} (${tvRatio.toFixed(2)}x)  FlatVM ${tfRatio > 1 ? "wins" : "loses"} (${tfRatio.toFixed(2)}x)`);
}
