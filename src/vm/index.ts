import { compile } from "./compiler.js";
import { VM } from "./vm.js";
export { disassemble } from "./bytecode.js";

// tree-walking の evaluate() と同じインターフェース
export function vmEvaluate(source: string): unknown {
  const func = compile(source);
  const vm = new VM();
  return vm.execute(func);
}
