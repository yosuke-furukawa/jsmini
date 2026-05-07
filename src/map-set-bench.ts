// Phase 27-6: Map/Set hot loop bench (TW vs VM)
// SunSpider 1.0.2 には Map/Set を使うテストが無いので自前で。
// node --noopt --no-sparkplug --no-maglev --import tsx src/map-set-bench.ts

import { evaluate } from "./interpreter/evaluator.js";
import { vmEvaluate } from "./vm/index.js";

type Mode = "TW" | "VM";
function bench(name: string, source: string, runs = 3) {
  console.log(name);
  for (const mode of ["TW", "VM"] as Mode[]) {
    const fn = mode === "TW" ? () => evaluate(source) : () => vmEvaluate(source);
    fn(); // warmup
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      fn();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b) / times.length;
    console.log(`  ${mode.padEnd(3)} : ${avg.toFixed(2)}ms (min ${times[0].toFixed(2)}ms)`);
  }
  console.log();
}

console.log("=== Phase 27-6: Map/Set micro bench ===\n");

bench("Map insert 10K (number key)", `
  const m = new Map();
  for (let i = 0; i < 10000; i++) m.set(i, i * 2);
  m.size;
`);

bench("Map get 10K (number key)", `
  const m = new Map();
  for (let i = 0; i < 10000; i++) m.set(i, i * 2);
  let s = 0;
  for (let i = 0; i < 10000; i++) s += m.get(i);
  s;
`);

bench("Map iterate 10K (for-of)", `
  const m = new Map();
  for (let i = 0; i < 10000; i++) m.set(i, i);
  let s = 0;
  for (const [k, v] of m) s += k + v;
  s;
`);

bench("Set add 10K", `
  const s = new Set();
  for (let i = 0; i < 10000; i++) s.add(i);
  s.size;
`);

bench("Set has 10K", `
  const s = new Set();
  for (let i = 0; i < 10000; i++) s.add(i);
  let count = 0;
  for (let i = 0; i < 10000; i++) if (s.has(i)) count++;
  count;
`);

bench("WeakMap set/get 5K", `
  const m = new WeakMap();
  const keys = [];
  for (let i = 0; i < 5000; i++) { const k = {}; keys.push(k); m.set(k, i); }
  let s = 0;
  for (let i = 0; i < 5000; i++) s += m.get(keys[i]);
  s;
`);
