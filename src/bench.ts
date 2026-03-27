import { evaluate } from "./interpreter/evaluator.js";
import { vmEvaluate } from "./vm/index.js";

const benchmarks = [
  {
    name: "fibonacci(25)",
    source: `
      function fib(n) {
        if (n <= 1) { return n; }
        return fib(n - 1) + fib(n - 2);
      }
      fib(25);
    `,
    jitEligible: false, // 再帰 + 比較 + 分岐 → 現 JIT では非対応
  },
  {
    name: "for loop sum (10000)",
    source: `
      var sum = 0;
      for (var i = 0; i < 10000; i = i + 1) {
        sum = sum + i;
      }
      sum;
    `,
    jitEligible: false, // ループは VM で実行、JIT は関数単位
  },
  {
    name: "hot function add (10000 calls)",
    source: `
      function add(a, b) { return a + b; }
      var sum = 0;
      for (var i = 0; i < 10000; i = i + 1) {
        sum = sum + add(i, 1);
      }
      sum;
    `,
    jitEligible: true, // add が JIT 対象
  },
  {
    name: "hot function mul (10000 calls)",
    source: `
      function mul(a, b) { return a * b; }
      var sum = 0;
      for (var i = 0; i < 10000; i = i + 1) {
        sum = sum + mul(i, 2);
      }
      sum;
    `,
    jitEligible: true,
  },
  {
    name: "nested loop (100x100)",
    source: `
      var sum = 0;
      for (var i = 0; i < 100; i = i + 1) {
        for (var j = 0; j < 100; j = j + 1) {
          sum = sum + 1;
        }
      }
      sum;
    `,
    jitEligible: false,
  },
];

function bench(fn: () => unknown, warmup = 3, runs = 10): { result: unknown; avg: number; min: number } {
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
  return { result, avg, min: times[0] };
}

console.log("=== jsmini Benchmark: Tree-Walking vs Bytecode VM vs Wasm JIT ===\n");

for (const { name, source, jitEligible } of benchmarks) {
  const tw = bench(() => evaluate(source));
  const vm = bench(() => vmEvaluate(source));

  const twVsVm = tw.avg / vm.avg;

  console.log(`${name}${jitEligible ? " [JIT eligible]" : ""}`);
  console.log(`  tree-walking : ${tw.avg.toFixed(2)}ms (min: ${tw.min.toFixed(2)}ms) result=${tw.result}`);
  console.log(`  bytecode-vm  : ${vm.avg.toFixed(2)}ms (min: ${vm.min.toFixed(2)}ms) result=${vm.result}`);
  console.log(`  vm speedup   : ${twVsVm.toFixed(2)}x`);

  if (jitEligible) {
    const jit = bench(() => vmEvaluate(source, { jit: true, jitThreshold: 50 }));
    const twVsJit = tw.avg / jit.avg;
    const vmVsJit = vm.avg / jit.avg;
    console.log(`  wasm-jit     : ${jit.avg.toFixed(2)}ms (min: ${jit.min.toFixed(2)}ms) result=${jit.result}`);
    console.log(`  jit vs tw    : ${twVsJit.toFixed(2)}x`);
    console.log(`  jit vs vm    : ${vmVsJit.toFixed(2)}x`);
  }
  console.log();
}
