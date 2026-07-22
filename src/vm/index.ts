import { compile } from "./compiler.js";
import { VM } from "./vm.js";
import { FeedbackCollector } from "../jit/feedback.js";
import { JitManager } from "../jit/jit.js";
import { isJSString, jsStringToString, internString, createSeqString, arrayToPrimitiveString, joinElementToString, jsStringEquals } from "./js-string.js";
import { createJSObject, isJSObject, getProperty as jsObjGet, setProperty as jsObjSet, getHiddenClass } from "./js-object.js";
import { createSymbol, isJSSymbol, SYMBOL_ITERATOR, SYMBOL_TO_PRIMITIVE, SYMBOL_HAS_INSTANCE, SYMBOL_TO_STRING_TAG } from "./js-symbol.js";
import { Heap } from "./heap.js";
import { evaluate } from "../interpreter/evaluator.js";
import { JSPromise, drainMicrotasks, isJSPromise, setHandlerCaller } from "../runtime/promise.js";
import "../runtime/host-patches.js";
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
  useIR?: boolean;
  globals?: Record<string, unknown>;
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
    // 要素比較: JSString 同士は内容比較 (concat 由来の非 intern 文字列も見つける)
    indexOf: function(this: unknown[], item: unknown, from?: number) {
      const start = from ?? 0;
      for (let i = start; i < this.length; i++) {
        const el = this[i];
        if (el === item || (isJSString(el) && isJSString(item) && jsStringEquals(el, item))) return i;
      }
      return -1;
    },
    lastIndexOf: function(this: unknown[], item: unknown, from?: number) {
      const start = from ?? this.length - 1;
      for (let i = Math.min(start, this.length - 1); i >= 0; i--) {
        const el = this[i];
        if (el === item || (isJSString(el) && isJSString(item) && jsStringEquals(el, item))) return i;
      }
      return -1;
    },
    includes: function(this: unknown[], item: unknown, from?: number) {
      const start = from ?? 0;
      for (let i = start; i < this.length; i++) {
        const el = this[i];
        if (el === item || (isJSString(el) && isJSString(item) && jsStringEquals(el, item))) return true;
      }
      return false;
    },
    join: function(this: unknown[], sep?: unknown) {
      // 要素は joinElementToString で安全に文字列化 (jsmini オブジェクト要素は
      // host prototype が null で host String() が throw する)
      const s = sep === undefined ? "," : joinElementToString(sep);
      const parts: string[] = [];
      for (let i = 0; i < this.length; i++) parts.push(joinElementToString(this[i]));
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
                          // 既定比較は ToString の辞書順。joinElementToString で
                          // オブジェクト要素の null-proto throw を避ける
                          const sa = joinElementToString(a);
                          const sb = joinElementToString(b);
                          return sa < sb ? -1 : sa > sb ? 1 : 0;
                        };
      // top-down merge sort: O(N log N)、stable (ES2019+ で要求)。
      // 補助領域 O(N) を取る。VM の独自実装として持っておく
      const merge = (left: unknown[], right: unknown[]): unknown[] => {
        const out: unknown[] = [];
        let i = 0, j = 0;
        while (i < left.length && j < right.length) {
          // `<= 0` で左を優先 → 同値要素の順序が保たれる (stable)
          if (cmp(left[i], right[j]) <= 0) out.push(left[i++]);
          else out.push(right[j++]);
        }
        while (i < left.length) out.push(left[i++]);
        while (j < right.length) out.push(right[j++]);
        return out;
      };
      const mergeSort = (arr: unknown[]): unknown[] => {
        if (arr.length <= 1) return arr;
        const mid = arr.length >> 1;
        return merge(mergeSort(arr.slice(0, mid)), mergeSort(arr.slice(mid)));
      };
      const sorted = mergeSort(this.slice());
      for (let i = 0; i < sorted.length; i++) this[i] = sorted[i];
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
      // (this as any).join() だと host の Array.prototype.join に飛んで
      // JSString 要素が "[object Object]" になる → 安全 join を直接使う
      return internString(arrayToPrimitiveString(this));
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
    concat:      function(this: unknown, ...args: unknown[]) { return strRet(strArg(this) + args.map(strArg).join("")); },
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
  // ユーザコードの `Array.prototype.foo = ...` 拡張を有効にする (Phase 28-6)。
  // ArrayCtor.prototype と host Array.prototype を結合 → 配列の method dispatch
  // (vm.arrayPrototype の next に host Array.prototype を見にいく) で拡張が見える
  ArrayCtor.prototype = Array.prototype;
  vm.setGlobal("Array", ArrayCtor);

  // Boolean/Number/String: new で呼ばれたらラッパーオブジェクト、関数呼びならプリミティブ変換
  function BooleanCtor(this: any, v: unknown) {
    if (new.target) { this.valueOf = () => !!v; return; }
    return !!v;
  }
  (BooleanCtor as any).prototype = {};
  vm.setGlobal("Boolean", BooleanCtor);

  // host の数値ビルトイン (Number/isNaN/Math.*) に jsmini 値を渡す前の前処理。
  // JSString はラップを解いて数値化 (host に任せると "[object Object]" 経由で NaN)。
  // jsmini のプレーンオブジェクトは host prototype が null なので host の ToNumber が
  // "Cannot convert object to primitive value" を投げてしまう。JS 仕様ではプレーン
  // オブジェクトの ToPrimitive は "[object Object]" → NaN なので、ここで NaN に潰す。
  // (配列は host Array.prototype 経由で正しく数値化できるので host に委ねる)
  // jsmini オブジェクトのユーザー定義 valueOf/toString を呼んでプリミティブ化を
  // 試みる。ユーザー定義 (bytecode 関数) が無ければ NO_USER_PRIM (呼び出し元の既定へ。
  // ユーザー関数が undefined を返すケースと区別する)。
  // ユーザー定義があるのに全部オブジェクトを返したら TypeError (仕様 / TW と同じ)
  const NO_USER_PRIM = Symbol("no-user-prim");
  const tryUserToPrimitive = (v: unknown, hint: "number" | "string"): unknown => {
    const order = hint === "number" ? ["valueOf", "toString"] : ["toString", "valueOf"];
    let found = false;
    for (const name of order) {
      const m = isJSObject(v) ? jsObjGet(v, name) : (v as Record<string, unknown>)[name];
      const isUserFn = m !== null && typeof m === "object" && ("bytecode" in (m as any) || "__closure" in (m as any));
      if (isUserFn) {
        found = true;
        const r = vm.callFunction(m, v, []);
        if (r === null || r === undefined || typeof r !== "object" || isJSString(r)) return r;
      }
    }
    if (found) throw new TypeError("Cannot convert object to primitive value");
    return NO_USER_PRIM;
  };

  const numArg = (v: unknown): unknown => {
    if (isJSString(v)) return Number(jsStringToString(v));
    // 配列は安全 join 経由で数値化 (host に渡すと jsmini オブジェクト要素の
    // null proto で join が throw する)
    if (Array.isArray(v)) return Number(arrayToPrimitiveString(v));
    if (v !== null && typeof v === "object") {
      const p = tryUserToPrimitive(v, "number");
      if (p !== NO_USER_PRIM) return isJSString(p) ? Number(jsStringToString(p)) : p;
      return NaN;
    }
    return v;
  };
  // host の文字列ビルトイン (String/parseInt/parseFloat) 用の前処理。
  // プレーンオブジェクトは host prototype が null で host String() が throw するので
  // "[object Object]" に潰す。配列も要素に jsmini オブジェクトを含むと host の
  // join が同じ理由で throw するため安全 join を使う
  // (strArg は string メソッド用の既存ヘルパで別物)
  const strConv = (v: unknown): string => {
    if (isJSString(v)) return jsStringToString(v);
    if (Array.isArray(v)) return arrayToPrimitiveString(v);
    if (v !== null && typeof v === "object") {
      const p = tryUserToPrimitive(v, "string");
      if (p !== NO_USER_PRIM) return isJSString(p) ? jsStringToString(p) : String(p);
      return "[object Object]";
    }
    return String(v);
  };

  function NumberCtor(this: any, v?: unknown) {
    const n = arguments.length === 0 ? 0 : Number(numArg(v));
    if (new.target) { this.valueOf = () => n; return; }
    return n;
  }
  (NumberCtor as any).isNaN = Number.isNaN;
  (NumberCtor as any).isFinite = Number.isFinite;
  (NumberCtor as any).isInteger = Number.isInteger;
  (NumberCtor as any).parseInt = parseInt;
  (NumberCtor as any).parseFloat = parseFloat;
  (NumberCtor as any).MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
  (NumberCtor as any).MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
  (NumberCtor as any).prototype = {};
  vm.setGlobal("Number", NumberCtor);

  function StringCtor(this: any, v?: unknown) {
    // String() 無引数は "" だが String(undefined) は "undefined" (arguments.length で判別)
    const s = isJSString(v) ? v : internString(arguments.length === 0 ? "" : strConv(v));
    if (new.target) { this.valueOf = () => s; this.toString = () => s; return; }
    return s;
  }
  (StringCtor as any).fromCharCode = (...codes: number[]) => internString(String.fromCharCode(...codes));
  // ユーザの `String.prototype.foo = ...` 拡張を host String.prototype に当てて、
  // VM 側の dispatch (vm.stringPrototype に無ければ host にフォールバック) で見えるように
  (StringCtor as any).prototype = String.prototype;
  vm.setGlobal("String", StringCtor);

  // Function は new Function() が実用的でないので最低限
  vm.setGlobal("Function", function() {});

  // グローバル関数
  vm.setGlobal("isNaN", (v: unknown) => Number.isNaN(Number(numArg(v))));
  vm.setGlobal("isFinite", (v: unknown) => Number.isFinite(Number(numArg(v))));
  vm.setGlobal("parseInt", (s: unknown, radix?: number) => parseInt(strConv(s), radix));
  vm.setGlobal("parseFloat", (s: unknown) => parseFloat(strConv(s)));

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

  const descField = (desc: unknown, name: string): unknown => {
    if (isJSObject(desc)) return jsObjGet(desc, name);
    if (desc && typeof desc === "object") return (desc as Record<string, unknown>)[name];
    return undefined;
  };
  const descHas = (desc: unknown, name: string): boolean => {
    if (isJSObject(desc)) return getHiddenClass(desc).properties.has(name);
    if (desc && typeof desc === "object") return name in (desc as object);
    return false;
  };
  const toKey = (key: unknown): string => {
    if (isJSSymbol(key)) return key.key;
    return isJSString(key) ? jsStringToString(key) : String(key);
  };
  ObjectWrapper.defineProperty = (obj: unknown, key: unknown, desc: unknown) => {
    const k = toKey(key);
    if (descHas(desc, "get") || descHas(desc, "set")) {
      throw new TypeError("accessor descriptors not yet supported");
    }
    if (descHas(desc, "value")) {
      if (isJSObject(obj)) {
        jsObjSet(obj as any, k, descField(desc, "value"));
      } else if (obj !== null && (typeof obj === "object" || typeof obj === "function")) {
        // host オブジェクト (Object.prototype / BytecodeFunction 等)。
        // jsObjSet だと getHiddenClass で内部エラーになるので host の
        // defineProperty を使う。enumerable は JS デフォルト (false) のまま
        // にして for-in を汚染しない。configurable/writable は restore や
        // 再定義を許すため true (jsmini は属性を強制しない方針)
        Object.defineProperty(obj, k, { value: descField(desc, "value"), writable: true, configurable: true });
      } else {
        throw new TypeError("Object.defineProperty called on non-object");
      }
    }
    return obj;
  };
  ObjectWrapper.defineProperties = (obj: unknown, descs: unknown) => {
    const keys = isJSObject(descs) ? [...getHiddenClass(descs).properties.keys()].filter(k => k !== "__proto__") :
                 (descs && typeof descs === "object" ? Object.keys(descs as object) : []);
    for (const k of keys) {
      const d = descField(descs, k);
      ObjectWrapper.defineProperty(obj, k, d);
    }
    return obj;
  };
  ObjectWrapper.getOwnPropertyDescriptor = (obj: unknown, key: unknown): unknown => {
    const k = toKey(key);
    if (isJSObject(obj)) {
      const props = getHiddenClass(obj).properties;
      if (!props.has(k)) return undefined;
      const d = vm.heap.allocate(createJSObject());
      jsObjSet(d, "value", jsObjGet(obj, k));
      jsObjSet(d, "writable", true);
      jsObjSet(d, "enumerable", true);
      jsObjSet(d, "configurable", true);
      return d;
    }
    if (obj && typeof obj === "object") {
      return Object.getOwnPropertyDescriptor(obj, k);
    }
    return undefined;
  };
  ObjectWrapper.getPrototypeOf = (obj: unknown): unknown => {
    if (isJSObject(obj)) {
      const props = getHiddenClass(obj).properties;
      if (!props.has("__proto__")) return vm.objectPrototype;
      return jsObjGet(obj, "__proto__");
    }
    if (obj && typeof obj === "object") return Object.getPrototypeOf(obj);
    return null;
  };
  ObjectWrapper.setPrototypeOf = (obj: unknown, proto: unknown) => {
    if (isJSObject(obj)) jsObjSet(obj, "__proto__", proto);
    else if (obj && typeof obj === "object") Object.setPrototypeOf(obj, proto as object | null);
    return obj;
  };
  ObjectWrapper.getOwnPropertyNames = (obj: unknown) => {
    const keys = jsObjKeys(obj);
    return keys.filter(k => !k.startsWith("@@")).map(k => internString(k));
  };
  ObjectWrapper.getOwnPropertySymbols = (_obj: unknown) => {
    // Note: JSSymbol の登録が無いので現状は空配列を返す (最小実装)
    return [];
  };

  // ユーザコードの `Object.prototype` 参照を host Object.prototype に繋ぐ
  // (deltablue の defineProperty(Object.prototype, ...) パターン。
  //  Array/String/Map 等と同じ host prototype 直結方針)
  ObjectWrapper.prototype = Object.prototype;
  vm.setGlobal("Object", ObjectWrapper);

  // Math — 数値メソッドは引数を numArg で前処理してから host に渡す
  // (プレーンオブジェクト被演算子が host の ToNumber で throw するのを防ぐ)
  const wrapNum = (fn: (...a: number[]) => number) =>
    (...args: unknown[]) => fn(...(args.map(numArg) as number[]));
  const rawMath: Record<string, unknown> = {
    floor: Math.floor, ceil: Math.ceil, round: Math.round,
    abs: Math.abs, min: Math.min, max: Math.max,
    sqrt: Math.sqrt, pow: Math.pow, log: Math.log,
    random: Math.random, sign: Math.sign, trunc: Math.trunc,
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
    exp: Math.exp, log2: Math.log2, log10: Math.log10,
    log1p: Math.log1p, expm1: Math.expm1,
    hypot: Math.hypot, cbrt: Math.cbrt,
    fround: Math.fround, clz32: Math.clz32, imul: Math.imul,
    PI: Math.PI, E: Math.E,
    LN2: Math.LN2, LN10: Math.LN10,
    LOG2E: Math.LOG2E, LOG10E: Math.LOG10E,
    SQRT2: Math.SQRT2, SQRT1_2: Math.SQRT1_2,
  };
  const mathObj: Record<string, unknown> = {};
  for (const k of Object.keys(rawMath)) {
    const v = rawMath[k];
    mathObj[k] = typeof v === "function" ? wrapNum(v as (...a: number[]) => number) : v;
  }
  vm.setGlobal("Math", mathObj);

  // Date: ネイティブ Date を公開。string 引数は JSString → string 変換。
  const unwrapStr = (v: unknown) => isJSString(v) ? jsStringToString(v) : v;
  const DateCtor: any = function(this: unknown, ...args: unknown[]) {
    const a = args.map(unwrapStr);
    if (new.target) {
      // new Date(...)
      if (a.length === 0) return new Date();
      if (a.length === 1) return new Date(a[0] as any);
      return new (Date as any)(...a);
    }
    // Date() — 文字列を返す (jsmini に渡すなら intern が安全)
    return internString(Date());
  };
  DateCtor.now = () => Date.now();
  DateCtor.parse = (s: unknown) => Date.parse(String(unwrapStr(s)));
  DateCtor.UTC = (...args: unknown[]) => (Date.UTC as any)(...args.map(unwrapStr));
  DateCtor.prototype = Date.prototype;
  vm.setGlobal("Date", DateCtor);

  // Map / Set / WeakMap / WeakSet
  // host Map/Set を薄くラップし、prototype をそのまま使う。iterable 引数は
  // jsmini の @@iterator か host Symbol.iterator のどちらでも吸収する。
  function* toHostIterable(v: unknown): Generator<unknown> {
    if (v === null || v === undefined) return;
    // host iterable (host Array, host Map, ...)
    if (typeof (v as any)[Symbol.iterator] === "function") {
      for (const x of (v as Iterable<unknown>)) yield x;
      return;
    }
    // jsmini の iterable (@@iterator を持つ JSObject)
    const iterFn = isJSObject(v) ? jsObjGet(v, "@@iterator") : (v as any)?.["@@iterator"];
    if (typeof iterFn !== "function") throw new TypeError("argument is not iterable");
    const iter = (iterFn as Function).call(v);
    while (true) {
      const nextFn = isJSObject(iter) ? jsObjGet(iter, "next") : (iter as any)?.next;
      const r = (nextFn as Function).call(iter);
      const done = isJSObject(r) ? jsObjGet(r, "done") : (r as any)?.done;
      if (done) return;
      const val = isJSObject(r) ? jsObjGet(r, "value") : (r as any)?.value;
      yield val;
    }
  }
  // [k, v] の取り出し: host Array は [0]/[1]、jsmini Array も同じ、JSObject は length/get
  function unwrapEntry(entry: unknown): [unknown, unknown] {
    if (Array.isArray(entry)) return [entry[0], entry[1]];
    if (isJSObject(entry)) return [jsObjGet(entry, "0"), jsObjGet(entry, "1")];
    throw new TypeError("Map iterable entry must be an array");
  }
  // forEach 等のコールバックを VM で実行できるようラップ
  const wrapVMCallback = (cb: unknown): ((...a: unknown[]) => unknown) => {
    if (typeof cb === "function") return cb as any;
    return (...args: unknown[]) => vm.callFunction(cb, undefined, args);
  };

  const MapCtor: any = function MapCtorFn(this: unknown, iterable?: unknown) {
    if (!new.target) throw new TypeError("Map must be called with new");
    const m = new Map<unknown, unknown>();
    if (iterable !== undefined && iterable !== null) {
      for (const entry of toHostIterable(iterable)) {
        const [k, v] = unwrapEntry(entry);
        m.set(k, v);
      }
    }
    return m;
  };
  MapCtor.prototype = Map.prototype;
  vm.setGlobal("Map", MapCtor);

  const SetCtor: any = function SetCtorFn(this: unknown, iterable?: unknown) {
    if (!new.target) throw new TypeError("Set must be called with new");
    const s = new Set<unknown>();
    if (iterable !== undefined && iterable !== null) {
      for (const v of toHostIterable(iterable)) s.add(v);
    }
    return s;
  };
  SetCtor.prototype = Set.prototype;
  vm.setGlobal("Set", SetCtor);

  const WeakMapCtor: any = function WeakMapCtorFn(this: unknown, iterable?: unknown) {
    if (!new.target) throw new TypeError("WeakMap must be called with new");
    const m = new WeakMap<object, unknown>();
    if (iterable !== undefined && iterable !== null) {
      for (const entry of toHostIterable(iterable)) {
        const [k, v] = unwrapEntry(entry);
        if (k === null || (typeof k !== "object" && typeof k !== "function")) {
          throw new TypeError("Invalid value used as weak map key");
        }
        m.set(k as object, v);
      }
    }
    return m;
  };
  WeakMapCtor.prototype = WeakMap.prototype;
  vm.setGlobal("WeakMap", WeakMapCtor);

  const WeakSetCtor: any = function WeakSetCtorFn(this: unknown, iterable?: unknown) {
    if (!new.target) throw new TypeError("WeakSet must be called with new");
    const s = new WeakSet<object>();
    if (iterable !== undefined && iterable !== null) {
      for (const v of toHostIterable(iterable)) {
        if (v === null || (typeof v !== "object" && typeof v !== "function")) {
          throw new TypeError("Invalid value used in weak set");
        }
        s.add(v as object);
      }
    }
    return s;
  };
  WeakSetCtor.prototype = WeakSet.prototype;
  vm.setGlobal("WeakSet", WeakSetCtor);

  // RegExp: host RegExp に丸投げ。pattern/flags が JSString のとき unwrap
  const RegExpCtor: any = function(this: unknown, pattern?: unknown, flags?: unknown) {
    const p = isJSString(pattern) ? jsStringToString(pattern) : pattern;
    const f = isJSString(flags) ? jsStringToString(flags) : flags;
    if (new.target) {
      return f !== undefined ? new RegExp(p as any, f as any) : new RegExp(p as any);
    }
    return f !== undefined ? new RegExp(p as any, f as any) : new RegExp(p as any);
  };
  RegExpCtor.prototype = RegExp.prototype;
  vm.setGlobal("RegExp", RegExpCtor);

  // String.prototype の RegExp 引数版を vm.stringPrototype に注入
  // (上で生成した stringPrototype を後付けで上書き)
  const origReplace = vm.stringPrototype.replace;
  vm.stringPrototype.match = function(this: unknown, re: unknown) {
    const s = isJSString(this) ? jsStringToString(this) : String(this);
    const r = re instanceof RegExp ? re : new RegExp(isJSString(re) ? jsStringToString(re) : String(re));
    const m = s.match(r);
    if (!m) return null;
    for (let i = 0; i < m.length; i++) if (typeof m[i] === "string") m[i] = internString(m[i]) as any;
    return m;
  };
  vm.stringPrototype.search = function(this: unknown, re: unknown) {
    const s = isJSString(this) ? jsStringToString(this) : String(this);
    const r = re instanceof RegExp ? re : new RegExp(isJSString(re) ? jsStringToString(re) : String(re));
    return s.search(r);
  };
  vm.stringPrototype.matchAll = function(this: unknown, re: unknown) {
    const s = isJSString(this) ? jsStringToString(this) : String(this);
    const r = re instanceof RegExp ? re : new RegExp(isJSString(re) ? jsStringToString(re) : String(re), "g");
    const arr: unknown[][] = [];
    for (const m of s.matchAll(r)) {
      const row: unknown[] = [];
      for (let i = 0; i < m.length; i++) row.push(typeof m[i] === "string" ? internString(m[i]) : m[i]);
      arr.push(row);
    }
    return arr; // host Array of arrays (iterator のかわりに配列で代替)
  };
  vm.stringPrototype.replace = function(this: unknown, search: unknown, replacement: unknown) {
    const s = isJSString(this) ? jsStringToString(this) : String(this);
    // search が RegExp なら host に丸投げ、replacement が関数なら wrap
    if (search instanceof RegExp) {
      if (typeof replacement === "function") {
        return internString(s.replace(search, (...args: unknown[]) => {
          const r = (replacement as Function).apply(undefined, args.map(a => typeof a === "string" ? internString(a) : a));
          return isJSString(r) ? jsStringToString(r) : String(r);
        }));
      } else if (typeof replacement === "object" && replacement !== null && "bytecode" in (replacement as any)) {
        // BytecodeFunction
        return internString(s.replace(search, (...args: unknown[]) => {
          const r = vm.callFunction(replacement, undefined, args.map(a => typeof a === "string" ? internString(a) : a));
          return isJSString(r) ? jsStringToString(r) : String(r);
        }));
      } else if (typeof replacement === "object" && replacement !== null && "__closure" in (replacement as any)) {
        return internString(s.replace(search, (...args: unknown[]) => {
          const r = vm.callFunction(replacement, undefined, args.map(a => typeof a === "string" ? internString(a) : a));
          return isJSString(r) ? jsStringToString(r) : String(r);
        }));
      }
      const rep = isJSString(replacement) ? jsStringToString(replacement) : String(replacement);
      return internString(s.replace(search, rep));
    }
    // 既存の文字列引数版にフォールバック
    return origReplace.call(this, search, replacement);
  };
  const origSplit = vm.stringPrototype.split;
  vm.stringPrototype.split = function(this: unknown, sep: unknown, limit?: number) {
    if (sep instanceof RegExp) {
      const s = isJSString(this) ? jsStringToString(this) : String(this);
      return s.split(sep, limit).map(x => internString(x));
    }
    return origSplit.call(this, sep, limit);
  };

  // forEach のコールバックは BytecodeFunction の場合があるので、
  // Map.prototype.forEach / Set.prototype.forEach を wrap する代わりに
  // VM 側で見つけたら wrapVMCallback で包む。
  // 実装は "プロトタイプ method 呼び出し" 経路で透過的に動かしたいので、
  // host の Map/Set prototype はそのまま、ただし MapCtor/SetCtor.prototype を
  // 見たときに wrap layer を挟むのが綺麗。今回は簡易対応として、global hook を
  // 置かず、テストで `for-of` 経由を主軸にする。forEach はラップ済み版を別名で
  // 提供 (wrapVMCallback)。
  // これは host Map.prototype.forEach をそのまま使うパスでは BytecodeFunction
  // が直接呼ばれて壊れるため、jsmini ユーザコードからは for-of を推奨。
  // テストの forEach は wrapVMCallback を通すヘルパで対応する。
  // ここでは Map.prototype.forEach 等を「callback を wrap する版」で上書きする。
  // ※ host のグローバル Map に影響するが、jsmini ランタイム内は問題無し。
  const origMapForEach = Map.prototype.forEach;
  if (!(Map.prototype as any).__jsminiPatched) {
    (Map.prototype as any).__jsminiPatched = true;
    Map.prototype.forEach = function(this: Map<unknown, unknown>, cb: unknown, thisArg?: unknown) {
      const wrapped = wrapVMCallback(cb);
      origMapForEach.call(this, function(this: unknown, v: unknown, k: unknown, m: Map<unknown, unknown>) {
        wrapped.call(thisArg, v, k, m);
      } as any, thisArg);
    } as any;
    const origSetForEach = Set.prototype.forEach;
    Set.prototype.forEach = function(this: Set<unknown>, cb: unknown, thisArg?: unknown) {
      const wrapped = wrapVMCallback(cb);
      origSetForEach.call(this, function(this: unknown, v: unknown, _v2: unknown, s: Set<unknown>) {
        wrapped.call(thisArg, v, v, s);
      } as any, thisArg);
    } as any;
  }

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

  // Promise 組み込み
  // handler を vm.callFunction でラップ: BytecodeFunction/クロージャを VM で実行
  const wrapVMHandler = (h: unknown) => {
    if (h === undefined || h === null) return undefined;
    if (typeof h === "function") return h as (v: unknown) => unknown;
    // BytecodeFunction or クロージャ → vm.callFunction でラップ
    return (v: unknown) => vm.callFunction(h, undefined, [v]);
  };
  const PromiseConstructor: any = function PromiseCtor(executor: unknown) {
    return new JSPromise((resolve, reject) => {
      try {
        if (typeof executor === "function") {
          executor(resolve, reject);
        } else {
          // BytecodeFunction / クロージャ
          vm.callFunction(executor, undefined, [resolve, reject]);
        }
      } catch (e: any) {
        const reason = e?.__thrown ? e.value : e;
        reject(reason);
      }
    });
  };
  PromiseConstructor.resolve = (value: unknown) => JSPromise.resolve(value);
  PromiseConstructor.reject = (reason: unknown) => JSPromise.reject(reason);
  PromiseConstructor.all = (promises: unknown[]) => JSPromise.all(promises);
  PromiseConstructor.race = (promises: unknown[]) => JSPromise.race(promises);
  PromiseConstructor.allSettled = (promises: unknown[]) => JSPromise.allSettled(promises);
  PromiseConstructor.any = (promises: unknown[]) => JSPromise.any(promises);
  PromiseConstructor.withResolvers = function(this: unknown) {
    if (this !== PromiseConstructor) {
      throw new TypeError("Promise.withResolvers called on non-Promise");
    }
    let resolve!: (v: unknown) => void;
    let reject!: (r: unknown) => void;
    const promise = new JSPromise((res, rej) => { resolve = res; reject = rej; });
    const result = vm.heap.allocate(createJSObject());
    jsObjSet(result, "promise", promise);
    jsObjSet(result, "resolve", resolve);
    jsObjSet(result, "reject", reject);
    return result;
  };
  vm.setGlobal("Promise", PromiseConstructor);

  // Promise handler を VM の callFunction で実行するフック
  setHandlerCaller((handler, value) => {
    if (typeof handler === "function") return handler(value);
    // BytecodeFunction / クロージャ → vm.callFunction
    return vm.callFunction(handler as any, undefined, [value]);
  });

  // eval: TW にフォールバック (VM のグローバル変数を TW env に注入)
  vm.setGlobal("eval", (code: unknown) => {
    if (typeof code !== "string" && !isJSString(code)) return code;
    const s = isJSString(code) ? jsStringToString(code) : code as string;
    // TW の evaluate を呼ぶが、VM のグローバルを globals オプションで渡す
    const globals: Record<string, unknown> = {};
    for (const [k, v] of vm.globals) {
      globals[k] = v;
    }
    return evaluate(s, { globals });
  });

  // フィードバック収集 (JIT 有効時は自動で有効)
  if (options.collectFeedback || options.jit) {
    vm.feedback = new FeedbackCollector();
  }

  // JIT マネージャ
  if (options.jit && vm.feedback) {
    vm.jit = new JitManager(vm.feedback, {
      threshold: options.jitThreshold ?? 100,
      useIR: options.useIR,
    });
    if (options.traceTier) vm.jit.traceTier = true;
    // 読み取り専用グローバルのパラメータ渡し用に VM の globals を注入
    vm.jit.globalsMap = (vm as any).globals;
  }

  // GC トレース
  if (options.traceGC) vm.heap.traceGC = true;

  // ステップ数上限
  if (options.maxSteps) vm.maxSteps = options.maxSteps;

  const rawValue = vm.execute(func);
  // スクリプト実行完了後に microtask を drain
  drainMicrotasks();
  // handler caller をリセット (次の vmEvaluate 呼び出しで再設定される)
  setHandlerCaller(null);
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
