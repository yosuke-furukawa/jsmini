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

console.log("=== jsmini Benchmark: Tree-Walking vs Bytecode VM ===\n");

for (const { name, source } of benchmarks) {
  const tw = bench(() => evaluate(source));
  const vm = bench(() => vmEvaluate(source));
  const speedup = tw.avg / vm.avg;

  console.log(`${name}`);
  console.log(`  tree-walking : ${tw.avg.toFixed(2)}ms (min: ${tw.min.toFixed(2)}ms) result=${tw.result}`);
  console.log(`  bytecode-vm  : ${vm.avg.toFixed(2)}ms (min: ${vm.min.toFixed(2)}ms) result=${vm.result}`);
  console.log(`  speedup      : ${speedup.toFixed(2)}x ${speedup > 1 ? "(VM faster)" : "(tree-walking faster)"}`);
  console.log();
}
