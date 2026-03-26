import { evaluate } from "./interpreter/evaluator.js";

const source = process.argv[2] ?? "1 + 2 * 3;";
console.log(evaluate(source));
