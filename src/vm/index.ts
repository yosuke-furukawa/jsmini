import { compile } from "./compiler.js";
import { VM } from "./vm.js";
import { FeedbackCollector } from "../jit/feedback.js";
import { JitManager } from "../jit/jit.js";
import { isJSString, jsStringToString, internString, createSeqString } from "./js-string.js";
import { createJSObject, isJSObject, getProperty as jsObjGet, setProperty as jsObjSet, getHiddenClass } from "./js-object.js";
import { createSymbol, isJSSymbol, SYMBOL_ITERATOR, SYMBOL_TO_PRIMITIVE, SYMBOL_HAS_INSTANCE, SYMBOL_TO_STRING_TAG } from "./js-symbol.js";
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
    push: function(this: unknown[], ...items: unknown[]) {
      for (const item of items) this[this.length] = item;
      return this.length;
    },
    pop: function(this: unknown[]) {
      if (this.length === 0) return undefined;
      const val = this[this.length - 1];
      this.length = this.length - 1;
      return val;
    },
    shift: function(this: unknown[]) {
      if (this.length === 0) return undefined;
      const val = this[0];
      for (let i = 1; i < this.length; i++) this[i - 1] = this[i];
      this.length = this.length - 1;
      return val;
    },
    unshift: function(this: unknown[], ...items: unknown[]) {
      for (let i = this.length - 1; i >= 0; i--) this[i + items.length] = this[i];
      for (let i = 0; i < items.length; i++) this[i] = items[i];
      return this.length;
    },
    slice: function(this: unknown[], start?: number, end?: number) {
      const len = this.length;
      let s = start ?? 0;
      let e = end ?? len;
      if (s < 0) s = Math.max(len + s, 0);
      if (e < 0) e = Math.max(len + e, 0);
      if (s > len) s = len;
      if (e > len) e = len;
      const result: unknown[] = [];
      for (let i = s; i < e; i++) result[result.length] = this[i];
      return result;
    },
    splice: function(this: unknown[], start: number, deleteCount?: number, ...items: unknown[]) {
      const len = this.length;
      let s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
      const dc = deleteCount === undefined ? len - s : Math.min(Math.max(deleteCount, 0), len - s);
      const removed: unknown[] = [];
      for (let i = 0; i < dc; i++) removed[i] = this[s + i];
      const diff = items.length - dc;
      if (diff > 0) {
        for (let i = len - 1; i >= s + dc; i--) this[i + diff] = this[i];
      } else if (diff < 0) {
        for (let i = s + dc; i < len; i++) this[i + diff] = this[i];
        this.length = len + diff;
      }
      for (let i = 0; i < items.length; i++) this[s + i] = items[i];
      return removed;
    },
    indexOf: function(this: unknown[], item: unknown, from?: number) {
      const start = from ?? 0;
      for (let i = start; i < this.length; i++) {
        if (this[i] === item) return i;
      }
      return -1;
    },
    includes: function(this: unknown[], item: unknown, from?: number) {
      const start = from ?? 0;
      for (let i = start; i < this.length; i++) {
        if (this[i] === item) return true;
      }
      return false;
    },
    join: function(this: unknown[], sep?: unknown) {
      const s = sep !== undefined ? (isJSString(sep) ? jsStringToString(sep) : String(sep)) : ",";
      const parts: string[] = [];
      for (let i = 0; i < this.length; i++) {
        const v = this[i];
        parts.push(v === null || v === undefined ? "" : (isJSString(v) ? jsStringToString(v) : String(v)));
      }
      return internString(parts.join(s));
    },
    concat: function(this: unknown[], ...args: unknown[]) {
      const result = this.slice();
      for (const a of args) {
        if (Array.isArray(a)) { for (const item of a) (result as unknown[]).push(item); }
        else (result as unknown[]).push(a);
      }
      return result;
    },
    reverse: function(this: unknown[]) {
      for (let i = 0, j = this.length - 1; i < j; i++, j--) {
        const tmp = this[i]; this[i] = this[j]; this[j] = tmp;
      }
      return this;
    },
    sort: function(this: unknown[], fn?: unknown) {
      const cmp = fn ? (a: unknown, b: unknown) => vm.callFunction(fn, undefined, [a, b]) as number
                      : (a: unknown, b: unknown) => {
                          const sa = isJSString(a) ? jsStringToString(a) : String(a);
                          const sb = isJSString(b) ? jsStringToString(b) : String(b);
                          return sa < sb ? -1 : sa > sb ? 1 : 0;
                        };
      // simple insertion sort
      for (let i = 1; i < this.length; i++) {
        const key = this[i];
        let j = i - 1;
        while (j >= 0 && cmp(this[j], key) > 0) { this[j + 1] = this[j]; j--; }
        this[j + 1] = key;
      }
      return this;
    },
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
    findIndex: function(this: unknown[], fn: unknown) {
      for (let i = 0; i < this.length; i++) {
        if (vm.callFunction(fn, undefined, [this[i], i, this])) return i;
      }
      return -1;
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
    flat: function(this: unknown[], depth?: number) {
      const d = depth ?? 1;
      const result: unknown[] = [];
      const flatten = (arr: unknown[], level: number) => {
        for (const item of arr) {
          if (Array.isArray(item) && level > 0) flatten(item, level - 1);
          else result.push(item);
        }
      };
      flatten(this, d);
      return result;
    },
    fill: function(this: unknown[], value: unknown, start?: number, end?: number) {
      const s = start ?? 0;
      const e = end ?? this.length;
      for (let i = s; i < e; i++) this[i] = value;
      return this;
    },
    toString: function(this: unknown[]) {
      return (this as any).join();
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

  // 自前ビルトインコンストラクタ
  const ArrayCtor: any = function(...args: unknown[]) {
    if (args.length === 1 && typeof args[0] === "number") {
      return new Array(args[0]);
    }
    return [...args];
  };
  ArrayCtor.isArray = (v: unknown) => Array.isArray(v);
  ArrayCtor.from = (iterable: unknown) => {
    if (Array.isArray(iterable)) return [...iterable];
    if (typeof iterable === "object" && iterable !== null && "length" in (iterable as any)) {
      const len = (iterable as any).length;
      const result: unknown[] = [];
      for (let i = 0; i < len; i++) result[i] = (iterable as any)[i];
      return result;
    }
    return [];
  };
  ArrayCtor.of = (...items: unknown[]) => [...items];
  vm.setGlobal("Array", ArrayCtor);

  const BooleanCtor: any = (v: unknown) => !!v;
  BooleanCtor.prototype = {};
  vm.setGlobal("Boolean", BooleanCtor);

  const NumberCtor: any = (v: unknown) => {
    if (isJSString(v)) return Number(jsStringToString(v));
    return Number(v);
  };
  NumberCtor.isNaN = Number.isNaN;
  NumberCtor.isFinite = Number.isFinite;
  NumberCtor.isInteger = Number.isInteger;
  NumberCtor.parseInt = parseInt;
  NumberCtor.parseFloat = parseFloat;
  NumberCtor.MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
  NumberCtor.MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
  NumberCtor.prototype = {};
  vm.setGlobal("Number", NumberCtor);

  const StringCtor: any = (v: unknown) => {
    if (isJSString(v)) return v;
    return internString(String(v));
  };
  StringCtor.fromCharCode = (...codes: number[]) => internString(String.fromCharCode(...codes));
  StringCtor.prototype = {};
  vm.setGlobal("String", StringCtor);

  // Function は new Function() が実用的でないので最低限
  vm.setGlobal("Function", function() {});

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
  // Symbol: 自前実装 (wrapper オブジェクト)
  const SymbolFn: any = (desc?: unknown) => {
    const d = desc !== undefined ? (isJSString(desc) ? jsStringToString(desc) : String(desc)) : "";
    return createSymbol(d);
  };
  SymbolFn.iterator = SYMBOL_ITERATOR;
  SymbolFn.toPrimitive = SYMBOL_TO_PRIMITIVE;
  SymbolFn.hasInstance = SYMBOL_HAS_INSTANCE;
  SymbolFn.toStringTag = SYMBOL_TO_STRING_TAG;
  vm.setGlobal("Symbol", SymbolFn);

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
