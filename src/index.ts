import { evaluate } from "./interpreter/evaluator.js";
import { vmEvaluate, disassemble } from "./vm/index.js";
import { compile } from "./vm/compiler.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const source = args.find((a) => !a.startsWith("--")) ?? "1 + 2 * 3;";

if (flags.has("--print-bytecode")) {
  const func = compile(source);
  console.log(disassemble(func));
} else if (flags.has("--vm")) {
  console.log(vmEvaluate(source));
} else {
  console.log(evaluate(source));
}
