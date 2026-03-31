import { compile } from "./compiler.js";
import { VM } from "./vm.js";
import { FeedbackCollector } from "../jit/feedback.js";
import { JitManager } from "../jit/jit.js";
import { isJSString, jsStringToString, internString } from "./js-string.js";
import { isJSObject, getProperty as jsObjGet } from "./js-object.js";
export { disassemble } from "./bytecode.js";

type ConsoleOptions = {
  log: (...args: unknown[]) => void;
};

type VMOptions = {
  console?: ConsoleOptions;
  collectFeedback?: boolean;
  collectDeopt?: boolean;
  traceTier?: boolean;
  traceGC?: boolean;
  jit?: boolean;
  jitThreshold?: number;
  maxSteps?: number;
  onStep?: () => void;
};

export type VMResult = {
  value: unknown;
  feedback?: FeedbackCollector;
  deoptLog?: string[];
  tierLog?: string[];
  gcLog?: string[];
  gcStats?: { totalAllocated: number; totalSwept: number; gcCount: number; peakSize: number; currentSize: number };
};

export function vmEvaluate(source: string, opts?: ConsoleOptions | VMOptions): unknown {
  const options: VMOptions = opts && "log" in opts ? { console: opts as ConsoleOptions } : (opts as VMOptions) ?? {};

  const func = compile(source);
  const vm = new VM();

  // Object.prototype: 全オブジェクトの __proto__ チェーンの終端
  vm.objectPrototype = {
    toString: (..._args: unknown[]) => internString("[object Object]"),
    valueOf: function(this: unknown) { return this; },
    hasOwnProperty: function(this: unknown, name: unknown) {
      const key = isJSString(name) ? jsStringToString(name) : String(name);
      if (isJSObject(this)) {
        return jsObjGet(this, key) !== undefined &&
          key !== "__proto__" && key !== "__hc__" && key !== "__slots__";
      }
      return Object.prototype.hasOwnProperty.call(this, key);
    },
  };

  // Array.prototype: コールバック系メソッド
  vm.arrayPrototype = {
    map: function(this: unknown[], fn: unknown) {
      const result: unknown[] = [];
      for (let i = 0; i < this.length; i++) {
        result[i] = vm.callFunction(fn, undefined, [this[i], i, this]);
      }
      return result;
    },
    filter: function(this: unknown[], fn: unknown) {
      const result: unknown[] = [];
      for (let i = 0; i < this.length; i++) {
        if (vm.callFunction(fn, undefined, [this[i], i, this])) result.push(this[i]);
      }
      return result;
    },
    forEach: function(this: unknown[], fn: unknown) {
      for (let i = 0; i < this.length; i++) {
        vm.callFunction(fn, undefined, [this[i], i, this]);
      }
    },
    reduce: function(this: unknown[], fn: unknown, init: unknown) {
      let acc = init;
      let start = 0;
      if (acc === undefined) { acc = this[0]; start = 1; }
      for (let i = start; i < this.length; i++) {
        acc = vm.callFunction(fn, undefined, [acc, this[i], i, this]);
      }
      return acc;
    },
    find: function(this: unknown[], fn: unknown) {
      for (let i = 0; i < this.length; i++) {
        if (vm.callFunction(fn, undefined, [this[i], i, this])) return this[i];
      }
      return undefined;
    },
    some: function(this: unknown[], fn: unknown) {
      for (let i = 0; i < this.length; i++) {
        if (vm.callFunction(fn, undefined, [this[i], i, this])) return true;
      }
      return false;
    },
    every: function(this: unknown[], fn: unknown) {
      for (let i = 0; i < this.length; i++) {
        if (!vm.callFunction(fn, undefined, [this[i], i, this])) return false;
      }
      return true;
    },
  };

  vm.setGlobal("undefined", undefined);
  vm.setGlobal("NaN", NaN);
  vm.setGlobal("Infinity", Infinity);
  vm.setGlobal("ReferenceError", ReferenceError);
  vm.setGlobal("TypeError", TypeError);
  vm.setGlobal("SyntaxError", SyntaxError);
  vm.setGlobal("RangeError", RangeError);

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

  // GC トレース
  if (options.traceGC) vm.heap.traceGC = true;

  // ステップ数上限
  if (options.maxSteps) vm.maxSteps = options.maxSteps;

  const rawValue = vm.execute(func);
  // JSString → JS string に変換して返す
  const value = isJSString(rawValue) ? jsStringToString(rawValue) : rawValue;

  if (options.collectFeedback || options.collectDeopt || options.traceTier || options.traceGC) {
    const result: VMResult = { value };
    if (vm.feedback) result.feedback = vm.feedback;
    if (vm.jit && options.collectDeopt) result.deoptLog = vm.jit.deoptLog;
    if (vm.jit && options.traceTier) result.tierLog = vm.jit.tierLog;
    if (options.traceGC) {
      result.gcLog = vm.heap.getGCLog();
      result.gcStats = vm.heap.getStats();
    }
    return result;
  }
  return value;
}
