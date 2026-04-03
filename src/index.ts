import { evaluate } from "./interpreter/evaluator.js";
import { vmEvaluate, disassemble } from "./vm/index.js";
import type { VMResult } from "./vm/index.js";
import { compile } from "./vm/compiler.js";
import { buildIR } from "./ir/builder.js";
import { printIR } from "./ir/printer.js";
import { optimize } from "./ir/optimize.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const source = args.find((a) => !a.startsWith("--")) ?? "1 + 2 * 3;";

if (flags.has("--print-ir")) {
  const script = compile(source);
  for (const c of script.constants) {
    if (typeof c === "object" && c !== null && "bytecode" in (c as any)) {
      const ir = buildIR(c as any);
      console.log(printIR(ir));
      optimize(ir);
      console.log("\n--- optimized ---\n");
      console.log(printIR(ir));
    }
  }
} else if (flags.has("--print-bytecode")) {
  const func = compile(source);
  console.log(disassemble(func));
} else if (flags.has("--print-feedback")) {
  const result = vmEvaluate(source, { collectFeedback: true, jit: true, jitThreshold: 100 }) as VMResult;
  console.log(result.value);
  console.log("\n" + result.feedback!.dump());
} else if (flags.has("--trace-tier")) {
  const result = vmEvaluate(source, {
    jit: true,
    jitThreshold: 100,
    collectFeedback: true,
    traceTier: true,
  }) as VMResult;
  console.log(result.value);
  if (result.tierLog) {
    console.log("\n" + result.tierLog.join("\n"));
  }
} else if (flags.has("--jit") && flags.has("--ir")) {
  console.log(vmEvaluate(source, { jit: true, jitThreshold: 100, useIR: true }));
} else if (flags.has("--jit")) {
  console.log(vmEvaluate(source, { jit: true, jitThreshold: 100 }));
} else if (flags.has("--vm")) {
  console.log(vmEvaluate(source));
} else {
  console.log(evaluate(source));
}
