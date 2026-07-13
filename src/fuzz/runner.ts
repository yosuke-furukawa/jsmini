// 1 本のソースを jsmini の各エンジンで実行し、結果を正規化して差分を判定する。

import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";
import { canonValue, canonThrow, outcomeKey, type Outcome } from "./normalize.js";

export type EngineName = "TW" | "VM" | "JIT";

export type EngineResult =
  | { engine: EngineName; ok: true; outcome: Outcome }
  | { engine: EngineName; ok: false; skip: string };

// VM/JIT の暴走を止めるステップ上限。超過は「判定不能」として扱う (TW に相当機能が無いため)。
const MAX_STEPS = 5_000_000;
const JIT_THRESHOLD = 4;

// 判定不能にすべき host 由来の事象 (jsmini のバグではなく実行モデルの構造差)。
function inconclusiveReason(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String((e as any)?.message ?? "");
  if (msg.includes("exceeded max steps")) return "steplimit";
  if (msg.includes("Maximum call stack size exceeded")) return "host-stack-overflow";
  return null;
}

function runOne(engine: EngineName, source: string): EngineResult {
  const logs: string[] = [];
  const log = (...args: unknown[]) => {
    logs.push(args.map((a) => canonValue(a)).join(" "));
  };
  try {
    let value: unknown;
    if (engine === "TW") {
      value = evaluate(source, { log });
    } else if (engine === "VM") {
      value = vmEvaluate(source, { console: { log }, maxSteps: MAX_STEPS });
    } else {
      value = vmEvaluate(source, {
        console: { log },
        jit: true,
        jitThreshold: JIT_THRESHOLD,
        maxSteps: MAX_STEPS,
      });
    }
    return { engine, ok: true, outcome: { kind: "value", repr: canonValue(value), logs } };
  } catch (e) {
    const reason = inconclusiveReason(e);
    if (reason) return { engine, ok: false, skip: reason };
    return { engine, ok: true, outcome: { kind: "throw", repr: canonThrow(e), logs } };
  }
}

export const ENGINES: EngineName[] = ["TW", "VM", "JIT"];

export function runEngines(source: string): EngineResult[] {
  return ENGINES.map((e) => runOne(e, source));
}

export type Divergence = {
  source: string;
  // engine -> 正規化キー ("SKIP:reason" を含む)
  keys: Record<string, string>;
};

// 2 つ以上の ok エンジンでキーが割れていれば差分あり。ok が 1 つ以下なら判定不能 (null)。
export function detectDivergence(source: string, results: EngineResult[]): Divergence | null {
  const okKeys: string[] = [];
  const keys: Record<string, string> = {};
  for (const r of results) {
    if (r.ok) {
      const k = outcomeKey(r.outcome);
      keys[r.engine] = k;
      okKeys.push(k);
    } else {
      keys[r.engine] = `SKIP:${r.skip}`;
    }
  }
  if (okKeys.length < 2) return null;
  const allSame = okKeys.every((k) => k === okKeys[0]);
  return allSame ? null : { source, keys };
}
