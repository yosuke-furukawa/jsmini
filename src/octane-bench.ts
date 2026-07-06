// Phase 30: Octane (richards / deltablue / splay / navier-stokes) を
// TW / VM / JIT で計測する。ベンチ内蔵の検証 (checksum / expected 値) が
// 失敗すると throw されるので、完走 = 正しさの確認を兼ねる。
// npx tsx src/octane-bench.ts [--timeout=ms]

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

const OCTANE_DIR = path.resolve(import.meta.dirname, "../bench/octane");

const tests = [
  "richards.js",
  "deltablue.js",
  "splay.js",
  "navier-stokes.js",
];

type Mode = "TW" | "VM" | "JIT";

// 無限ループ対策: maxSteps (VM) / onStep (TW) で上限を切る
const STEP_LIMIT = 100_000_000;

function timeRun(mode: Mode, source: string, runs = 3): { avg: number; min: number; error?: string } {
  let steps = 0;
  const opts = mode === "TW"
    ? { onStep: () => { if (++steps > STEP_LIMIT) throw new Error("step limit exceeded (infinite loop?)"); } }
    : { maxSteps: STEP_LIMIT };
  const fn = mode === "TW"
    ? () => evaluate(source, opts as any)
    : mode === "VM"
      ? () => vmEvaluate(source, opts as any)
      : () => vmEvaluate(source, { ...opts, jit: true, jitThreshold: 5, useIR: true } as any);
  // warmup (完走確認を兼ねる)
  try { steps = 0; fn(); } catch (e: any) { return { avg: 0, min: 0, error: extractError(e) }; }
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    steps = 0;
    const start = performance.now();
    try { fn(); } catch (e: any) { return { avg: 0, min: 0, error: extractError(e) }; }
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { avg: times.reduce((a, b) => a + b, 0) / times.length, min: times[0] };
}

console.log("=== Phase 30: Octane on jsmini ===\n");

for (const name of tests) {
  const source = fs.readFileSync(path.join(OCTANE_DIR, name), "utf-8");
  console.log(name);
  for (const mode of ["TW", "VM", "JIT"] as Mode[]) {
    const r = timeRun(mode, source);
    if (r.error) {
      console.log(`  ${mode.padEnd(3)} : ERROR — ${r.error.slice(0, 90)}`);
    } else {
      console.log(`  ${mode.padEnd(3)} : ${r.avg.toFixed(2)}ms (min ${r.min.toFixed(2)}ms)`);
    }
  }
  console.log();
}
