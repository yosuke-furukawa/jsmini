import { evaluate } from "./interpreter/evaluator.js";
import { vmEvaluate, disassemble } from "./vm/index.js";
import type { VMResult } from "./vm/index.js";
import { compile } from "./vm/compiler.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const source = args.find((a) => !a.startsWith("--")) ?? "1 + 2 * 3;";

if (flags.has("--print-bytecode")) {
  const func = compile(source);
  console.log(disassemble(func));
} else if (flags.has("--print-feedback")) {
  const result = vmEvaluate(source, { collectFeedback: true }) as VMResult;
  console.log(result.value);
  console.log("\n" + result.feedback!.dump());
} else if (flags.has("--vm")) {
  console.log(vmEvaluate(source));
} else {
  console.log(evaluate(source));
}
