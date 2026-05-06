// Phase 26-3 mini-bench: Math.X の hot loop で TW vs VM vs JIT を比較
// V8 JIT 無効: node --noopt --no-sparkplug --no-maglev --import tsx src/math-bench.ts

import { evaluate } from "./interpreter/evaluator.js";
import { vmEvaluate } from "./vm/index.js";

const cases = [
  {
    name: "Math.sin (host import) — 50K iter",
    source: `
      function bench(n) {
        var s = 0;
        for (var i = 0; i < n; i = i + 1) s = s + Math.sin(i);
        return s;
      }
      bench(50000);
    `,
  },
  {
    name: "Math.sqrt (Wasm native f64.sqrt) — 100K iter",
    source: `
      function bench(n) {
        var s = 0;
        for (var i = 1; i <= n; i = i + 1) s = s + Math.sqrt(i);
        return s;
      }
      bench(100000);
    `,
  },
  {
    name: "Math.atan2 (host import, 2 引数) — 30K iter",
    source: `
      function bench(n) {
        var s = 0;
        for (var i = 1; i <= n; i = i + 1) s = s + Math.atan2(i, n);
        return s;
      }
      bench(30000);
    `,
  },
  {
    name: "sin+cos+sqrt 混合 — 30K iter",
    source: `
      function bench(n) {
        var s = 0;
        for (var i = 1; i <= n; i = i + 1) {
          s = s + Math.sqrt(Math.sin(i) * Math.sin(i) + Math.cos(i) * Math.cos(i));
        }
        return s;
      }
      bench(30000);
    `,
  },
];

function bench(fn: () => unknown, warmup = 2, runs = 5): { result: unknown; avg: number; min: number } {
  for (let i = 0; i < warmup; i++) fn();
  const times: number[] = [];
  let result: unknown;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    result = fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { result, avg: times.reduce((a, b) => a + b, 0) / times.length, min: times[0] };
}

console.log("=== Phase 26-3: Math.X hot loop bench (V8-JITless) ===\n");

for (const { name, source } of cases) {
  const tw = bench(() => evaluate(source));
  const vm = bench(() => vmEvaluate(source));
  const jit = bench(() => vmEvaluate(source, { jit: true, jitThreshold: 5, useIR: true }));

  console.log(name);
  console.log(`  TW  : ${tw.avg.toFixed(2)}ms  (min ${tw.min.toFixed(2)}ms)`);
  console.log(`  VM  : ${vm.avg.toFixed(2)}ms  (min ${vm.min.toFixed(2)}ms)  ${(tw.avg / vm.avg).toFixed(2)}x vs TW`);
  console.log(`  JIT : ${jit.avg.toFixed(2)}ms  (min ${jit.min.toFixed(2)}ms)  ${(vm.avg / jit.avg).toFixed(2)}x vs VM, ${(tw.avg / jit.avg).toFixed(2)}x vs TW`);
  console.log(`  result: ${jit.result}`);
  console.log();
}
