import { compile } from "./compiler.js";
import { VM } from "./vm.js";
export { disassemble } from "./bytecode.js";

type ConsoleOptions = {
  log: (...args: unknown[]) => void;
};

export function vmEvaluate(source: string, consoleOpts?: ConsoleOptions): unknown {
  const func = compile(source);
  const vm = new VM();

  vm.setGlobal("undefined", undefined);

  const consoleObj: Record<string, Function> = {
    log: consoleOpts?.log ?? console.log,
  };
  vm.setGlobal("console", consoleObj);

  return vm.execute(func);
}
