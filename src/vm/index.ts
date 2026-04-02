import { compile } from "./compiler.js";
import { VM } from "./vm.js";
import { FeedbackCollector } from "../jit/feedback.js";
import { JitManager } from "../jit/jit.js";
import { isJSString, jsStringToString, internString, createSeqString } from "./js-string.js";
import { createJSObject, isJSObject, getProperty as jsObjGet, setProperty as jsObjSet, getHiddenClass } from "./js-object.js";
import { Heap } from "./heap.js";
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

  // String.prototype: JSString のメソッド (ネイティブ文字列に変換して委譲)
  const strArg = (v: unknown) => isJSString(v) ? jsStringToString(v) : String(v);
  const strRet = (v: string) => internString(v);
  vm.stringPrototype = {
    charAt:      function(this: unknown, i: number) { return strRet(strArg(this).charAt(i)); },
    charCodeAt:  function(this: unknown, i: number) { return strArg(this).charCodeAt(i); },
    indexOf:     function(this: unknown, s: unknown, from?: number) { return strArg(this).indexOf(strArg(s), from); },
    lastIndexOf: function(this: unknown, s: unknown, from?: number) { return strArg(this).lastIndexOf(strArg(s), from); },
    includes:    function(this: unknown, s: unknown, from?: number) { return strArg(this).includes(strArg(s), from); },
    startsWith:  function(this: unknown, s: unknown) { return strArg(this).startsWith(strArg(s)); },
    endsWith:    function(this: unknown, s: unknown) { return strArg(this).endsWith(strArg(s)); },
    slice:       function(this: unknown, s: number, e?: number) { return strRet(strArg(this).slice(s, e)); },
    substring:   function(this: unknown, s: number, e?: number) { return strRet(strArg(this).substring(s, e)); },
    toUpperCase: function(this: unknown) { return strRet(strArg(this).toUpperCase()); },
    toLowerCase: function(this: unknown) { return strRet(strArg(this).toLowerCase()); },
    trim:        function(this: unknown) { return strRet(strArg(this).trim()); },
    trimStart:   function(this: unknown) { return strRet(strArg(this).trimStart()); },
    trimEnd:     function(this: unknown) { return strRet(strArg(this).trimEnd()); },
    repeat:      function(this: unknown, n: number) { return strRet(strArg(this).repeat(n)); },
    padStart:    function(this: unknown, len: number, fill?: unknown) { return strRet(strArg(this).padStart(len, fill !== undefined ? strArg(fill) : undefined)); },
    padEnd:      function(this: unknown, len: number, fill?: unknown) { return strRet(strArg(this).padEnd(len, fill !== undefined ? strArg(fill) : undefined)); },
    replace:     function(this: unknown, s: unknown, r: unknown) { return strRet(strArg(this).replace(strArg(s), strArg(r))); },
    split:       function(this: unknown, sep: unknown, limit?: number) {
      return strArg(this).split(strArg(sep), limit).map(s => internString(s));
    },
    toString:    function(this: unknown) { return this; },
    valueOf:     function(this: unknown) { return this; },
  };

  vm.setGlobal("undefined", undefined);
  vm.setGlobal("NaN", NaN);
  vm.setGlobal("Infinity", Infinity);
  vm.setGlobal("ReferenceError", ReferenceError);
  vm.setGlobal("TypeError", TypeError);
  vm.setGlobal("SyntaxError", SyntaxError);
  vm.setGlobal("RangeError", RangeError);
  vm.setGlobal("Boolean", Boolean);
  vm.setGlobal("Number", Number);
  vm.setGlobal("String", String);
  vm.setGlobal("Array", Array);
  vm.setGlobal("Function", Function);

  // グローバル関数
  vm.setGlobal("isNaN", (v: unknown) => Number.isNaN(Number(v)));
  vm.setGlobal("isFinite", (v: unknown) => Number.isFinite(Number(v)));
  vm.setGlobal("parseInt", (s: unknown, radix?: number) => parseInt(isJSString(s) ? jsStringToString(s) : String(s), radix));
  vm.setGlobal("parseFloat", (s: unknown) => parseFloat(isJSString(s) ? jsStringToString(s) : String(s)));

  // JSObject のキーを取得するヘルパー (内部プロパティを除外)
  const jsObjKeys = (obj: unknown): string[] => {
    if (isJSObject(obj)) {
      const props = getHiddenClass(obj).properties;
      return [...props.keys()].filter(k => k !== "__proto__");
    }
    return Object.keys(obj as Record<string, unknown>);
  };

  // Object: ネイティブ Object をラップ (new Object() + 静的メソッド)
  const ObjectWrapper: any = function(...args: unknown[]) { return new Object(...args); };
  ObjectWrapper.keys = (obj: unknown) => jsObjKeys(obj).map(k => internString(k));
  ObjectWrapper.values = (obj: unknown) => jsObjKeys(obj).map(k => jsObjGet(obj as any, k));
  ObjectWrapper.entries = (obj: unknown) => jsObjKeys(obj).map(k => [internString(k), jsObjGet(obj as any, k)]);
  ObjectWrapper.assign = Object.assign;
  ObjectWrapper.create = (proto: unknown) => {
    const obj = vm.heap.allocate(createJSObject());
    if (proto !== null) jsObjSet(obj, "__proto__", proto);
    return obj;
  };
  ObjectWrapper.freeze = (obj: unknown) => obj;
  ObjectWrapper.prototype = vm.objectPrototype;
  vm.setGlobal("Object", ObjectWrapper);

  // Math
  vm.setGlobal("Math", {
    floor: Math.floor, ceil: Math.ceil, round: Math.round,
    abs: Math.abs, min: Math.min, max: Math.max,
    sqrt: Math.sqrt, pow: Math.pow, log: Math.log,
    random: Math.random, PI: Math.PI, E: Math.E,
    sign: Math.sign, trunc: Math.trunc,
  });

  // JSON (JSString ↔ ネイティブ文字列の変換が必要)
  vm.setGlobal("JSON", {
    stringify: (val: unknown) => {
      // JSObject/JSString を再帰的にネイティブに変換
      const toNative = (v: unknown): unknown => {
        if (isJSString(v)) return jsStringToString(v);
        if (isJSObject(v)) {
          const result: Record<string, unknown> = {};
          for (const k of jsObjKeys(v)) result[k] = toNative(jsObjGet(v, k));
          return result;
        }
        if (Array.isArray(v)) return v.map(toNative);
        return v;
      };
      return internString(JSON.stringify(toNative(val)));
    },
    parse: (s: unknown) => {
      const str = isJSString(s) ? jsStringToString(s) : String(s);
      return JSON.parse(str);
    },
  });

  // console.log: JSString → JS string に変換してから出力
  const userLog = options.console?.log ?? console.log;
  const consoleObj: Record<string, Function> = {
    log: (...args: unknown[]) => userLog(...args.map(a => isJSString(a) ? jsStringToString(a) : a)),
  };
  vm.setGlobal("console", consoleObj);
  vm.setGlobal("Error", { __nativeConstructor: true, name: "Error" });
  vm.setGlobal("Symbol", Symbol);

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
