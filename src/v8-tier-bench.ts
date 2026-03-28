// V8 の各 tier で native JS と jsmini の速度を比較
// 起動時のフラグに応じて結果が変わる

import { evaluate } from "./interpreter/evaluator.js";
import { vmEvaluate, flatVmEvaluate } from "./vm/index.js";

function bench(fn: () => unknown, warmup = 5, runs = 15): { avg: number; min: number; result: unknown } {
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
  return { avg, min: times[0], result };
}

// V8 フラグの検出
const flags = process.execArgv.join(" ");
let tier = "default (全 tier)";
if (flags.includes("--jitless")) tier = "--jitless (Ignition only)";
else if (flags.includes("--noopt") && flags.includes("--no-sparkplug")) tier = "--noopt --no-sparkplug --no-maglev (Ignition only)";
else if (flags.includes("--noopt") && !flags.includes("--no-sparkplug")) tier = "--noopt --no-maglev (Sparkplug + Ignition)";

console.log(`=== V8 Tier Benchmark: ${tier} ===\n`);

// --- Native JS (V8 が直接実行) ---
function nativeFib(n: number): number {
  if (n <= 1) return n;
  return nativeFib(n - 1) + nativeFib(n - 2);
}

function nativeLoopSum(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s = s + i;
  return s;
}

function nativeHotAdd(n: number): number {
  function add(a: number, b: number) { return a + b; }
  let s = 0;
  for (let i = 0; i < n; i++) s = add(s, i);
  return s;
}

// --- jsmini ソース ---
const fibSource = `
  function fib(n) { if (n <= 1) { return n; } return fib(n-1) + fib(n-2); }
  fib(25);
`;
const loopSource = `
  var s = 0; for (var i = 0; i < 10000; i = i + 1) { s = s + i; } s;
`;
const hotAddSource = `
  function add(a, b) { return a + b; }
  var s = 0; for (var i = 0; i < 10000; i = i + 1) { s = add(s, i); } s;
`;

type BenchCase = {
  name: string;
  native: () => unknown;
  source: string;
};

const cases: BenchCase[] = [
  { name: "fibonacci(25)", native: () => nativeFib(25), source: fibSource },
  { name: "for loop sum(10000)", native: () => nativeLoopSum(10000), source: loopSource },
  { name: "hot add(10000)", native: () => nativeHotAdd(10000), source: hotAddSource },
];

for (const { name, native, source } of cases) {
  const nativeResult = bench(native);
  const twResult = bench(() => evaluate(source));
  const vmResult = bench(() => vmEvaluate(source));
  const flatResult = bench(() => flatVmEvaluate(source));

  console.log(`${name}`);
  console.log(`  native JS    : ${nativeResult.avg.toFixed(3)}ms  (V8 が直接実行)`);
  console.log(`  jsmini TW    : ${twResult.avg.toFixed(2)}ms`);
  console.log(`  jsmini ObjVM : ${vmResult.avg.toFixed(2)}ms`);
  console.log(`  jsmini FlatVM: ${flatResult.avg.toFixed(2)}ms`);
  console.log(`  native vs TW : ${(twResult.avg / nativeResult.avg).toFixed(0)}x slower`);
  console.log(`  native vs VM : ${(vmResult.avg / nativeResult.avg).toFixed(0)}x slower`);
  console.log();
}
