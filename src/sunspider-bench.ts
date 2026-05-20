// Phase 26-4: SunSpider math/date を jsmini で動かしてベンチを取る
// node --noopt --no-sparkplug --no-maglev --import tsx src/sunspider-bench.ts

import fs from "node:fs";
import path from "node:path";
import { evaluate } from "./interpreter/evaluator.js";
import { vmEvaluate } from "./vm/index.js";
import { isJSString, jsStringToString } from "./vm/js-string.js";
import { ThrowSignal } from "./interpreter/values.js";

function extractError(e: unknown): string {
  const val = e instanceof ThrowSignal ? e.value
    : (typeof e === "object" && e !== null && "__thrown" in e) ? (e as any).value
    : null;
  if (val !== null) {
    if (isJSString(val)) return jsStringToString(val);
    if (typeof val === "string") return val;
    if (val && typeof val === "object" && "message" in val) {
      const m = (val as any).message;
      return isJSString(m) ? jsStringToString(m) : String(m);
    }
    try { return JSON.stringify(val); } catch { return String(val); }
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

const SUNSPIDER_DIR = path.resolve(import.meta.dirname, "../bench/sunspider");

const tests = [
  "math-cordic.js",
  "math-spectral-norm.js",
  "math-partial-sums.js",
  "date-format-tofte.js",
  "date-format-xparb.js",
  "regexp-dna.js",
  "string-tagcloud.js",
  "string-validate-input.js",
];

function loadSource(name: string): string {
  return fs.readFileSync(path.join(SUNSPIDER_DIR, name), "utf-8");
}

type Mode = "TW" | "VM" | "JIT";

function timeRun(mode: Mode, source: string, runs = 3): { avg: number; min: number; error?: string } {
  const fn = mode === "TW"
    ? () => evaluate(source)
    : mode === "VM"
      ? () => vmEvaluate(source)
      : () => vmEvaluate(source, { jit: true, jitThreshold: 5, useIR: true });
  // warmup
  try { fn(); } catch (e: any) { return { avg: 0, min: 0, error: extractError(e) }; }
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    try { fn(); } catch (e: any) { return { avg: 0, min: 0, error: extractError(e) }; }
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { avg: times.reduce((a, b) => a + b, 0) / times.length, min: times[0] };
}

console.log("=== Phase 26-4: SunSpider math/date on jsmini ===\n");

for (const name of tests) {
  const source = loadSource(name);
  console.log(name);
  for (const mode of ["TW", "VM", "JIT"] as Mode[]) {
    const r = timeRun(mode, source);
    if (r.error) {
      console.log(`  ${mode.padEnd(3)} : ERROR — ${r.error.slice(0, 80)}`);
    } else {
      console.log(`  ${mode.padEnd(3)} : ${r.avg.toFixed(2)}ms (min ${r.min.toFixed(2)}ms)`);
    }
  }
  console.log();
}
