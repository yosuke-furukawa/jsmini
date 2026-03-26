import { compile } from "./compiler.js";
import { VM } from "./vm.js";
import { FeedbackCollector } from "../jit/feedback.js";
export { disassemble } from "./bytecode.js";

type ConsoleOptions = {
  log: (...args: unknown[]) => void;
};

type VMOptions = {
  console?: ConsoleOptions;
  collectFeedback?: boolean;
};

export type VMResult = {
  value: unknown;
  feedback?: FeedbackCollector;
};

export function vmEvaluate(source: string, opts?: ConsoleOptions | VMOptions): unknown {
  const options: VMOptions = opts && "log" in opts ? { console: opts as ConsoleOptions } : (opts as VMOptions) ?? {};

  const func = compile(source);
  const vm = new VM();

  vm.setGlobal("undefined", undefined);

  const consoleObj: Record<string, Function> = {
    log: options.console?.log ?? console.log,
  };
  vm.setGlobal("console", consoleObj);
  vm.setGlobal("Error", { __nativeConstructor: true, name: "Error" });

  if (options.collectFeedback) {
    vm.feedback = new FeedbackCollector();
  }

  const value = vm.execute(func);

  if (options.collectFeedback && vm.feedback) {
    return { value, feedback: vm.feedback } as VMResult;
  }
  return value;
}
