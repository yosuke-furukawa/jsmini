import { compile } from "./compiler.js";
import { VM } from "./vm.js";
import { FeedbackCollector } from "../jit/feedback.js";
import { JitManager } from "../jit/jit.js";
import { isJSString, jsStringToString } from "./js-string.js";
export { disassemble } from "./bytecode.js";

type ConsoleOptions = {
  log: (...args: unknown[]) => void;
};

type VMOptions = {
  console?: ConsoleOptions;
  collectFeedback?: boolean;
  collectDeopt?: boolean;
  traceTier?: boolean;
  jit?: boolean;
  jitThreshold?: number;
};

export type VMResult = {
  value: unknown;
  feedback?: FeedbackCollector;
  deoptLog?: string[];
  tierLog?: string[];
};

export function vmEvaluate(source: string, opts?: ConsoleOptions | VMOptions): unknown {
  const options: VMOptions = opts && "log" in opts ? { console: opts as ConsoleOptions } : (opts as VMOptions) ?? {};

  const func = compile(source);
  const vm = new VM();

  vm.setGlobal("undefined", undefined);

  // console.log: JSString → JS string に変換してから出力
  const userLog = options.console?.log ?? console.log;
  const consoleObj: Record<string, Function> = {
    log: (...args: unknown[]) => userLog(...args.map(a => isJSString(a) ? jsStringToString(a) : a)),
  };
  vm.setGlobal("console", consoleObj);
  vm.setGlobal("Error", { __nativeConstructor: true, name: "Error" });

  // フィードバック収集 (JIT 有効時は自動で有効)
  if (options.collectFeedback || options.jit) {
    vm.feedback = new FeedbackCollector();
  }

  // JIT マネージャ
  if (options.jit && vm.feedback) {
    vm.jit = new JitManager(vm.feedback, {
      threshold: options.jitThreshold ?? 100,
    });
    if (options.traceTier) vm.jit.traceTier = true;
  }

  const rawValue = vm.execute(func);
  // JSString → JS string に変換して返す
  const value = isJSString(rawValue) ? jsStringToString(rawValue) : rawValue;

  if (options.collectFeedback || options.collectDeopt || options.traceTier) {
    const result: VMResult = { value };
    if (vm.feedback) result.feedback = vm.feedback;
    if (vm.jit && options.collectDeopt) result.deoptLog = vm.jit.deoptLog;
    if (vm.jit && options.traceTier) result.tierLog = vm.jit.tierLog;
    return result;
  }
  return value;
}
