// 木の深さ/幅と TW vs VM の関係を検証

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

console.log("=== AST の深さ/幅と TW vs VM の関係 ===\n");

// --- 1. 式の深さ (ネストした二項演算) ---
// 1+1 → 深さ2, ((1+1)+1)+1 → 深さ4, ...
console.log("--- 1. 式のネスト深さ (1回実行、10000回繰り返しのループ内) ---");

function makeDeepExpr(depth: number): string {
  let expr = "1";
  for (let i = 0; i < depth; i++) {
    expr = `(${expr} + 1)`;
  }
  return expr;
}

for (const depth of [1, 5, 10, 20, 50, 100]) {
  const expr = makeDeepExpr(depth);
  const source = `var s = 0; for (var i = 0; i < 1000; i = i + 1) { s = ${expr}; } s;`;
  const tw = bench(() => evaluate(source));
  const vm = bench(() => vmEvaluate(source));
  const ratio = tw / vm;
  console.log(`  depth=${String(depth).padStart(3)}  TW: ${tw.toFixed(2).padStart(8)}ms  VM: ${vm.toFixed(2).padStart(8)}ms  ${ratio > 1 ? "VM wins" : "TW wins"} (${ratio.toFixed(2)}x)`);
}

// --- 2. 関数呼び出しの深さ (ネストしたコール) ---
console.log("\n--- 2. 関数呼び出しのネスト深さ ---");

function makeNestedCalls(depth: number): string {
  let funcs = "";
  for (let i = 0; i < depth; i++) {
    if (i === 0) {
      funcs += `function f0(x) { return x + 1; }\n`;
    } else {
      funcs += `function f${i}(x) { return f${i - 1}(x) + 1; }\n`;
    }
  }
  return `${funcs}
    var s = 0;
    for (var i = 0; i < 1000; i = i + 1) { s = s + f${depth - 1}(i); }
    s;
  `;
}

for (const depth of [1, 3, 5, 10, 20]) {
  const source = makeNestedCalls(depth);
  const tw = bench(() => evaluate(source));
  const vm = bench(() => vmEvaluate(source));
  const ratio = tw / vm;
  console.log(`  depth=${String(depth).padStart(3)}  TW: ${tw.toFixed(2).padStart(8)}ms  VM: ${vm.toFixed(2).padStart(8)}ms  ${ratio > 1 ? "VM wins" : "TW wins"} (${ratio.toFixed(2)}x)`);
}

// --- 3. 幅: 1文あたりの式の数 (広い AST) ---
console.log("\n--- 3. 文の数 (幅の広い AST、ループ内) ---");

function makeWideBody(width: number): string {
  let body = "";
  for (let i = 0; i < width; i++) {
    body += `s = s + 1; `;
  }
  return `var s = 0; for (var i = 0; i < 1000; i = i + 1) { ${body} } s;`;
}

for (const width of [1, 5, 10, 20, 50]) {
  const source = makeWideBody(width);
  const tw = bench(() => evaluate(source));
  const vm = bench(() => vmEvaluate(source));
  const ratio = tw / vm;
  console.log(`  width=${String(width).padStart(3)}  TW: ${tw.toFixed(2).padStart(8)}ms  VM: ${vm.toFixed(2).padStart(8)}ms  ${ratio > 1 ? "VM wins" : "TW wins"} (${ratio.toFixed(2)}x)`);
}

// --- 4. if-else チェーン (分岐の深さ) ---
console.log("\n--- 4. if-else チェーンの深さ ---");

function makeIfElseChain(depth: number): string {
  let code = `function check(x) {\n`;
  for (let i = 0; i < depth; i++) {
    code += `  if (x === ${i}) { return ${i}; } else `;
  }
  code += `{ return -1; }\n}\n`;
  code += `var s = 0; for (var i = 0; i < 1000; i = i + 1) { s = s + check(i % ${depth + 1}); } s;`;
  return code;
}

for (const depth of [2, 5, 10, 20, 50]) {
  const source = makeIfElseChain(depth);
  const tw = bench(() => evaluate(source));
  const vm = bench(() => vmEvaluate(source));
  const ratio = tw / vm;
  console.log(`  depth=${String(depth).padStart(3)}  TW: ${tw.toFixed(2).padStart(8)}ms  VM: ${vm.toFixed(2).padStart(8)}ms  ${ratio > 1 ? "VM wins" : "TW wins"} (${ratio.toFixed(2)}x)`);
}
