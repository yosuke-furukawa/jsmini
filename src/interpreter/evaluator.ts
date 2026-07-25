import { parse } from "../parser/parser.js";
import type { Program, Statement, Expression, Identifier, BlockStatement, MemberExpression } from "../parser/ast.js";
import { Environment } from "./environment.js";
import {
  ReturnSignal, ThrowSignal, BreakSignal, ContinueSignal,
  JS_FUNCTION_BRAND, PROTO_KEY,
  type JSObject, type JSFunction,
  isJSFunction, createJSFunction, getProperty,
  collectBoundNames, bindPattern, assignPattern,
} from "./values.js";
import { isJSString, createSeqString, jsStringConcat, jsStringEquals, jsStringToString, internString, arrayToPrimitiveString, joinElementToString, toNumericOperand, type JSString } from "../vm/js-string.js";
import { createSymbol, isJSSymbol, SYMBOL_ITERATOR, SYMBOL_TO_PRIMITIVE, SYMBOL_HAS_INSTANCE, SYMBOL_TO_STRING_TAG } from "../vm/js-symbol.js";
import { JSPromise, drainMicrotasks, isJSPromise } from "../runtime/promise.js";
import "../runtime/host-patches.js";

// JSFunction を同期的に呼び出すヘルパー (Promise executor / then callback 用)
function callJSFunctionSync(fn: JSFunction, thisValue: unknown, args: unknown[]): unknown {
  const callEnv = new Environment(fn.closure, true);
  if (!fn.isArrow) callEnv.setThis(thisValue);
  const params: any[] = fn.params;
  for (let i = 0; i < params.length; i++) {
    if (params[i].type === "Identifier") {
      callEnv.define(params[i].name, args[i]);
    } else {
      bindPattern(params[i], args[i], callEnv);
    }
  }
  if (fn.name) callEnv.define(fn.name, fn);
  hoistVarDeclarations(fn.body.body, callEnv);
  hoistFunctionDeclarations(fn.body.body, callEnv);

  // async 関数: Promise を返して generator + microtask で駆動
  if ((fn as any).isAsync) {
    hoistVarDeclarations(fn.body.body, callEnv);
    hoistFunctionDeclarations(fn.body.body, callEnv);
    const bodyGen = evalBlock(fn.body.body, callEnv);
    return new JSPromise((resolve, reject) => {
      function step(inputValue?: unknown): void {
        try {
          const r = bodyGen.next(inputValue);
          if (r.done) { resolve!(r.value); return; }
          const yielded = r.value;
          if (yielded && typeof yielded === "object" && (yielded as any).__await__) {
            JSPromise.resolve((yielded as any).value).then(
              (v: unknown) => step(v),
              (e: unknown) => {
                try { const rr = bodyGen.throw(new ThrowSignal(e)); if (rr.done) resolve!(rr.value); else step(undefined); }
                catch (err) { if (err instanceof ReturnSignal) { resolve!(err.value); } else { reject!(err instanceof ThrowSignal ? err.value : err); } }
              },
            );
          } else { step(yielded); }
        } catch (e) {
          if (e instanceof ReturnSignal) { resolve!(e.value); return; }
          reject!(e instanceof ThrowSignal ? (isJSString(e.value) ? jsStringToString(e.value) : e.value) : e);
        }
      }
      step();
    });
  }

  return evalBlockSync(fn.body.body, callEnv);
}

// JSString 対応の truthiness 判定 (空文字列は falsy)
function isTruthy(value: unknown): boolean {
  if (isJSString(value)) return value.length > 0;
  return !!value;
}

// `==` で「オブジェクト」として扱う値 (JSString は primitive 扱い)。
// 両辺がこれなら参照比較で、ToPrimitive しない (JS 仕様 7.2.14)
function isEqObjectTW(v: unknown): boolean {
  return (typeof v === "object" && v !== null && !isJSString(v)) || typeof v === "function";
}

// Generator を同期的に最後まで実行するヘルパー
function exhaustGen(gen: Generator): unknown {
  let r = gen.next();
  while (!r.done) r = gen.next(undefined);
  return r.value;
}

// ToPrimitive: オブジェクトの valueOf/toString を呼んでプリミティブに変換
function toPrimitive(value: unknown, hint: "number" | "string" = "number"): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (isJSString(value)) return value;
  // 配列は join(",") 相当の文字列に (VM の toPrimitive と同じ規則)。
  // 数値文脈は toNumericOperand が文字列から変換する
  if (Array.isArray(value)) return internString(arrayToPrimitiveString(value));

  const obj = value as Record<string, unknown>;
  const methods = hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
  for (const name of methods) {
    const method = getProperty(obj, name);
    if (typeof method === "function") {
      const result = (method as Function).call(obj);
      if (result === null || result === undefined || typeof result !== "object" || isJSString(result)) {
        return result;
      }
    }
    if (isJSFunction(method)) {
      const jsFn = method;
      const fnEnv = new Environment(jsFn.closure, true);
      fnEnv.setThis(obj);
      hoistVarDeclarations(jsFn.body.body, fnEnv);
      try {
        for (const s of jsFn.body.body) exhaustGen(evalStatement(s, fnEnv));
      } catch (e) {
        if (e instanceof ReturnSignal) {
          const r = e.value;
          if (r === null || r === undefined || typeof r !== "object" || isJSString(r)) return r;
          continue;
        }
        throw e;
      }
    }
  }
  throw new TypeError("Cannot convert object to primitive value");
}

// MemberExpression のキーを解決する共通ヘルパー
function* resolveMemberKey(expr: MemberExpression, env: Environment): Generator<unknown, string, unknown> {
  if (expr.computed) {
    const key = yield* evalExpression(expr.property, env);
    return isJSSymbol(key) ? key.key : isJSString(key) ? jsStringToString(key) : String(key);
  }
  return (expr.property as Identifier).name;
}

// Step コールバック (evaluate 実行中のみ有効)
let _currentOnStep: ((info: StepInfo) => void) | null = null;

type ConsoleOptions = {
  log: (...args: unknown[]) => void;
};

export type StepInfo = {
  type: string;
  env: { scope: string; variables: Record<string, unknown> }[];
};

type EvalOptions = {
  console?: ConsoleOptions;
  onStep?: (info: StepInfo) => void;
  globals?: Record<string, unknown>;
};

export function evaluate(source: string, opts?: ConsoleOptions | EvalOptions): unknown {
  // 後方互換: ConsoleOptions を直接渡された場合
  const options: EvalOptions = opts && "log" in opts ? { console: opts as ConsoleOptions } : (opts as EvalOptions) ?? {};

  const ast = parse(source);
  const env = new Environment(null, true); // グローバルは関数スコープ扱い
  env.defineReadOnly("undefined", undefined);
  env.defineReadOnly("NaN", NaN);
  env.defineReadOnly("Infinity", Infinity);
  env.defineReadOnly("ReferenceError", ReferenceError);
  env.defineReadOnly("TypeError", TypeError);
  env.defineReadOnly("SyntaxError", SyntaxError);
  env.defineReadOnly("RangeError", RangeError);
  env.defineReadOnly("Boolean", Boolean);
  // host の数値ビルトインに渡す前の前処理 (VM 側 index.ts の numArg と同じ規則)。
  // JSString はラップを解いて数値化、プレーンオブジェクトは NaN に潰す
  // (host の ToNumber に任せると JSString が "[object Object]" 経由で NaN になる)
  const twNumArg = (v: unknown): unknown => {
    if (isJSString(v)) return Number(jsStringToString(v));
    // 配列は安全 join 経由で数値化 (JSString 要素を host join に掛けると
    // "[object Object]" になる)
    if (Array.isArray(v)) return Number(arrayToPrimitiveString(v));
    if (v !== null && typeof v === "object") {
      // ユーザー定義 valueOf/toString を呼ぶ (VM 側 tryUserToPrimitive と同じ規則)
      const p = toPrimitive(v, "number");
      if (isJSString(p)) return Number(jsStringToString(p));
      return typeof p === "object" && p !== null ? NaN : p;
    }
    return v;
  };
  // 文字列ビルトイン (String/parseInt/parseFloat) 用の前処理 (VM 側 strConv と同一規則)
  const twStrConv = (v: unknown): string => {
    if (isJSString(v)) return jsStringToString(v);
    if (Array.isArray(v)) return arrayToPrimitiveString(v);
    // JSFunction の host ラッパー (native 呼び出し時に自動ラップされたもの):
    // ラッパー自身のソーステキストではなく、プロパティキー正規化
    // (classKeyName/resolveMemberKey) と同じ "[object Object]" に揃える。
    // これが揃わないと class computed key `[fn]` を `String(fn)` で引けない
    if (typeof v === "function" && (v as any).__wrappedJSFunction) return "[object Object]";
    if (v !== null && typeof v === "object") {
      const p = toPrimitive(v, "string");
      if (isJSString(p)) return jsStringToString(p);
      return typeof p === "object" && p !== null ? "[object Object]" : String(p);
    }
    return String(v);
  };
  // Number: JSString を受け取れるカスタムコンストラクタ (host Number の statics は引き継ぐ)
  const NumberCtor = function(this: any, v?: unknown) {
    const n = arguments.length === 0 ? 0 : Number(twNumArg(v));
    if (new.target) return new Number(n);
    return n;
  } as unknown as NumberConstructor;
  (NumberCtor as any).isNaN = Number.isNaN;
  (NumberCtor as any).isFinite = Number.isFinite;
  (NumberCtor as any).isInteger = Number.isInteger;
  (NumberCtor as any).parseInt = parseInt;
  (NumberCtor as any).parseFloat = parseFloat;
  (NumberCtor as any).MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
  (NumberCtor as any).MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
  (NumberCtor as any).prototype = Number.prototype;
  env.defineReadOnly("Number", NumberCtor);
  // String: JSString を受け取れるカスタムコンストラクタ。
  // String() 無引数は "" だが String(undefined) は "undefined" (arguments.length で判別)
  const StringCtor = function(this: any, v?: unknown) {
    const s = arguments.length === 0 ? "" : twStrConv(v);
    if (new.target) return new String(s);
    return internString(s);
  } as unknown as StringConstructor;
  StringCtor.fromCharCode = (...codes: number[]) => internString(String.fromCharCode(...codes));
  (StringCtor as any).prototype = String.prototype;
  env.defineReadOnly("String", StringCtor);
  env.defineReadOnly("Array", Array);
  env.defineReadOnly("Function", Function);

  // グローバル関数
  env.defineReadOnly("isNaN", (v: unknown) => Number.isNaN(Number(twNumArg(v))));
  env.defineReadOnly("isFinite", (v: unknown) => Number.isFinite(Number(twNumArg(v))));
  env.defineReadOnly("parseInt", (s: unknown, radix?: number) => parseInt(twStrConv(s), radix));
  env.defineReadOnly("parseFloat", (s: unknown) => parseFloat(twStrConv(s)));

  // Math — 数値メソッドは引数を twNumArg で前処理してから host に渡す
  // (JSString の "5" が NaN になる・プレーンオブジェクトの挙動が VM とズレるのを防ぐ)
  const twWrapNum = (fn: (...a: number[]) => number) =>
    (...args: unknown[]) => fn(...(args.map(twNumArg) as number[]));
  const twRawMath: Record<string, unknown> = {
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
  const twMathObj: Record<string, unknown> = {};
  for (const k of Object.keys(twRawMath)) {
    const v = twRawMath[k];
    twMathObj[k] = typeof v === "function" ? twWrapNum(v as (...a: number[]) => number) : v;
  }
  env.defineReadOnly("Math", twMathObj);

  // Date: host Date を公開。string 引数は JSString → string 変換。
  const twUnwrapStr = (v: unknown) => isJSString(v) ? jsStringToString(v) : v;
  const twDateCtor: any = function(this: unknown, ...args: unknown[]) {
    const a = args.map(twUnwrapStr);
    if (new.target) {
      if (a.length === 0) return new Date();
      if (a.length === 1) return new Date(a[0] as any);
      return new (Date as any)(...a);
    }
    return Date();
  };
  twDateCtor.now = () => Date.now();
  twDateCtor.parse = (s: unknown) => Date.parse(String(twUnwrapStr(s)));
  twDateCtor.UTC = (...args: unknown[]) => (Date.UTC as any)(...args.map(twUnwrapStr));
  twDateCtor.prototype = Date.prototype;
  env.defineReadOnly("Date", twDateCtor);

  // Map / Set / WeakMap / WeakSet (host wrapper) — Phase 27
  function* twToHostIterable(v: unknown): Generator<unknown> {
    if (v === null || v === undefined) return;
    if (typeof (v as any)[Symbol.iterator] === "function") {
      for (const x of (v as Iterable<unknown>)) yield x;
      return;
    }
    const iterFn = (v as any)?.["@@iterator"];
    if (typeof iterFn !== "function") throw new TypeError("argument is not iterable");
    const iter = (iterFn as Function).call(v);
    while (true) {
      const r = (iter.next as Function).call(iter);
      if (r?.done) return;
      yield r?.value;
    }
  }
  function twUnwrapEntry(entry: unknown): [unknown, unknown] {
    if (Array.isArray(entry)) return [entry[0], entry[1]];
    if (entry && typeof entry === "object") return [(entry as any)[0], (entry as any)[1]];
    throw new TypeError("Map iterable entry must be an array");
  }
  const twMapCtor: any = function(this: unknown, iterable?: unknown) {
    if (!new.target) throw new TypeError("Map must be called with new");
    const m = new Map<unknown, unknown>();
    if (iterable !== undefined && iterable !== null) {
      for (const entry of twToHostIterable(iterable)) {
        const [k, v] = twUnwrapEntry(entry);
        m.set(k, v);
      }
    }
    return m;
  };
  twMapCtor.prototype = Map.prototype;
  env.defineReadOnly("Map", twMapCtor);

  const twSetCtor: any = function(this: unknown, iterable?: unknown) {
    if (!new.target) throw new TypeError("Set must be called with new");
    const s = new Set<unknown>();
    if (iterable !== undefined && iterable !== null) {
      for (const v of twToHostIterable(iterable)) s.add(v);
    }
    return s;
  };
  twSetCtor.prototype = Set.prototype;
  env.defineReadOnly("Set", twSetCtor);

  const twWeakMapCtor: any = function(this: unknown, iterable?: unknown) {
    if (!new.target) throw new TypeError("WeakMap must be called with new");
    const m = new WeakMap<object, unknown>();
    if (iterable !== undefined && iterable !== null) {
      for (const entry of twToHostIterable(iterable)) {
        const [k, v] = twUnwrapEntry(entry);
        if (k === null || (typeof k !== "object" && typeof k !== "function")) {
          throw new TypeError("Invalid value used as weak map key");
        }
        m.set(k as object, v);
      }
    }
    return m;
  };
  twWeakMapCtor.prototype = WeakMap.prototype;
  env.defineReadOnly("WeakMap", twWeakMapCtor);

  const twWeakSetCtor: any = function(this: unknown, iterable?: unknown) {
    if (!new.target) throw new TypeError("WeakSet must be called with new");
    const s = new WeakSet<object>();
    if (iterable !== undefined && iterable !== null) {
      for (const v of twToHostIterable(iterable)) {
        if (v === null || (typeof v !== "object" && typeof v !== "function")) {
          throw new TypeError("Invalid value used in weak set");
        }
        s.add(v as object);
      }
    }
    return s;
  };
  twWeakSetCtor.prototype = WeakSet.prototype;
  env.defineReadOnly("WeakSet", twWeakSetCtor);

  // RegExp (host wrapper) — Phase 28
  const twRegExpCtor: any = function(this: unknown, pattern?: unknown, flags?: unknown) {
    const p = isJSString(pattern) ? jsStringToString(pattern) : pattern;
    const f = isJSString(flags) ? jsStringToString(flags) : flags;
    if (new.target) {
      return f !== undefined ? new RegExp(p as any, f as any) : new RegExp(p as any);
    }
    return f !== undefined ? new RegExp(p as any, f as any) : new RegExp(p as any);
  };
  twRegExpCtor.prototype = RegExp.prototype;
  env.defineReadOnly("RegExp", twRegExpCtor);

  // Object
  const strArg = (v: unknown) => isJSString(v) ? jsStringToString(v) : String(v);
  const twObjectWrapper: any = function(...args: unknown[]) { return new Object(...args); };
  twObjectWrapper.keys = (obj: unknown) => {
    if (typeof obj === "object" && obj !== null) {
      return Object.keys(obj).filter(k => k !== "__proto__" && k !== "__hc__" && k !== "__slots__" && !k.startsWith("Symbol("));
    }
    return [];
  };
  twObjectWrapper.values = (obj: unknown) => {
    if (typeof obj === "object" && obj !== null) {
      return Object.keys(obj).filter(k => k !== "__proto__" && k !== "__hc__" && k !== "__slots__" && !k.startsWith("Symbol(")).map(k => (obj as any)[k]);
    }
    return [];
  };
  twObjectWrapper.entries = (obj: unknown) => {
    if (typeof obj === "object" && obj !== null) {
      return Object.keys(obj).filter(k => k !== "__proto__" && k !== "__hc__" && k !== "__slots__" && !k.startsWith("Symbol(")).map(k => [k, (obj as any)[k]]);
    }
    return [];
  };
  twObjectWrapper.assign = Object.assign;
  twObjectWrapper.create = Object.create;
  twObjectWrapper.freeze = (obj: unknown) => {
    // TW のオブジェクトは host object なので host freeze で属性が実効する
    // (evaluator の代入は strict モードの TS コードなので違反は TypeError)。
    // JSString (intern 共有) は凍結せず no-op — プリミティブ扱い (ES2015+)
    if (obj && typeof obj === "object" && !isJSString(obj)) Object.freeze(obj);
    return obj;
  };
  twObjectWrapper.seal = (obj: unknown) => {
    if (obj && typeof obj === "object" && !isJSString(obj)) Object.seal(obj);
    return obj;
  };
  twObjectWrapper.preventExtensions = (obj: unknown) => {
    if (obj && typeof obj === "object" && !isJSString(obj)) Object.preventExtensions(obj);
    return obj;
  };
  twObjectWrapper.isFrozen = (obj: unknown) => (obj && typeof obj === "object") ? Object.isFrozen(obj) : true;
  twObjectWrapper.isSealed = (obj: unknown) => (obj && typeof obj === "object") ? Object.isSealed(obj) : true;
  twObjectWrapper.isExtensible = (obj: unknown) => (obj && typeof obj === "object") ? Object.isExtensible(obj) : false;
  const twToKey = (key: unknown): string | symbol => {
    if (isJSString(key)) return jsStringToString(key);
    return typeof key === "symbol" ? key : String(key);
  };
  twObjectWrapper.defineProperty = (obj: unknown, key: unknown, desc: any) => {
    // JSString は intern 共有オブジェクトなので定義を許すと全プログラムに汚染が
    // 漏れる。spec 通りプリミティブは TypeError (VM 側と同方針)
    if (obj === null || isJSString(obj) || (typeof obj !== "object" && typeof obj !== "function")) {
      throw new TypeError("Object.defineProperty called on non-object");
    }
    const k = twToKey(key);
    if (!desc || typeof desc !== "object") throw new TypeError("Property description must be an object");
    // host defineProperty に「指定されたフィールドだけ」を渡す — デフォルト
    // (新規は false×3) と再定義検証 (configurable:false 等) は host が spec 通り
    // 実施する。get/set が JSFunction なら host callable に包む
    const hostDesc: PropertyDescriptor = {};
    if ("value" in desc) hostDesc.value = desc.value;
    if ("writable" in desc) hostDesc.writable = !!desc.writable;
    if ("enumerable" in desc) hostDesc.enumerable = !!desc.enumerable;
    if ("configurable" in desc) hostDesc.configurable = !!desc.configurable;
    // 共有ビルトイン prototype への定義は省略時 writable/configurable を true に
    // (jsmini は host prototype を全 evaluate 間で共有するため。VM 側と同方針)
    const twSharedProtos: unknown[] = [Object.prototype, Array.prototype, String.prototype, Number.prototype, Boolean.prototype, Function.prototype, RegExp.prototype];
    if (twSharedProtos.includes(obj)) {
      if (!("configurable" in desc)) hostDesc.configurable = true;
      if (!("writable" in desc) && !("get" in desc) && !("set" in desc)) hostDesc.writable = true;
    }
    if ("get" in desc) {
      const g = desc.get;
      if (g === undefined || typeof g === "function") hostDesc.get = g;
      else {
        const w = function(this: unknown) { return callJSFunctionSync(g, this, []); };
        (w as any).__wrappedJSFunction = g; // gOPD で元の JSFunction を返すためのタグ
        hostDesc.get = w;
      }
    }
    if ("set" in desc) {
      const st = desc.set;
      if (st === undefined || typeof st === "function") hostDesc.set = st;
      else {
        const w = function(this: unknown, v: unknown) { callJSFunctionSync(st, this, [v]); };
        (w as any).__wrappedJSFunction = st;
        hostDesc.set = w;
      }
    }
    Object.defineProperty(obj, k, hostDesc);
    return obj;
  };
  twObjectWrapper.defineProperties = (obj: unknown, descs: any) => {
    if (descs && typeof descs === "object") {
      for (const k of Object.keys(descs)) {
        twObjectWrapper.defineProperty(obj, k, descs[k]);
      }
    }
    return obj;
  };
  twObjectWrapper.getOwnPropertyDescriptor = (obj: unknown, key: unknown) => {
    // native 呼び出し時に JSFunction は host ラッパーに包まれて届く → 元へ復元
    if (typeof obj === "function" && (obj as any).__wrappedJSFunction) {
      obj = (obj as any).__wrappedJSFunction;
    }
    // host 関数 (ビルトイン) の name/length も spec 属性 + intern 文字列で合成
    if (typeof obj === "function") {
      const k0 = twToKey(key);
      if (k0 === "name" || k0 === "length") {
        return {
          value: k0 === "name" ? internString((obj as Function).name ?? "") : (obj as Function).length,
          writable: false, enumerable: false, configurable: true,
        };
      }
      return Object.getOwnPropertyDescriptor(obj, k0);
    }
    if (obj === null || typeof obj !== "object") return undefined;
    const k = twToKey(key);
    // JSFunction の name/length は spec 属性で合成 (writable:false,
    // enumerable:false, configurable:true)。fn.name への後書き (名前推論) が
    // あるためオブジェクト自体は変更しない
    if (isJSFunction(obj) && (k === "name" || k === "length")) {
      let fnLen = 0;
      for (const prm of ((obj as any).params ?? []) as any[]) {
        if (prm.type === "AssignmentPattern" || prm.type === "RestElement") break;
        fnLen++;
      }
      return {
        value: k === "name" ? internString((obj as any).name ?? "") : fnLen,
        writable: false, enumerable: false, configurable: true,
      };
    }
    // host の descriptor をそのまま返す (属性は host が正しく追跡している)。
    // accessor の get/set がラップ済み JSFunction なら元へ復元 (identity 維持)
    const hd = Object.getOwnPropertyDescriptor(obj, k);
    if (hd) {
      if (hd.get && (hd.get as any).__wrappedJSFunction) (hd as any).get = (hd.get as any).__wrappedJSFunction;
      if (hd.set && (hd.set as any).__wrappedJSFunction) (hd as any).set = (hd.set as any).__wrappedJSFunction;
    }
    return hd;
  };
  twObjectWrapper.getPrototypeOf = (obj: unknown) => {
    if (obj === null || typeof obj !== "object") return null;
    return Object.getPrototypeOf(obj);
  };
  twObjectWrapper.setPrototypeOf = (obj: unknown, proto: unknown) => {
    if (obj && typeof obj === "object") Object.setPrototypeOf(obj, proto as object | null);
    return obj;
  };
  twObjectWrapper.getOwnPropertyNames = (obj: unknown) => {
    if (obj === null || typeof obj !== "object") return [];
    return Object.getOwnPropertyNames(obj).filter(
      k => k !== "__proto__" && k !== "__hc__" && k !== "__slots__" && !k.startsWith("Symbol(") && !k.startsWith("@@"),
    );
  };
  twObjectWrapper.getOwnPropertySymbols = (obj: unknown) => {
    if (obj === null || typeof obj !== "object") return [];
    return Object.getOwnPropertySymbols(obj);
  };
  // `Object.prototype` 参照を host Object.prototype に直結 (VM と同方針)
  twObjectWrapper.prototype = Object.prototype;
  env.defineReadOnly("Object", twObjectWrapper);

  // JSON
  env.defineReadOnly("JSON", {
    stringify: (val: unknown) => {
      const toNative = (v: unknown): unknown => {
        if (isJSString(v)) return jsStringToString(v);
        if (Array.isArray(v)) return v.map(toNative);
        if (v && typeof v === "object") {
          const result: Record<string, unknown> = {};
          for (const k of Object.keys(v).filter(k => k !== "__proto__" && k !== "__hc__" && k !== "__slots__" && !k.startsWith("Symbol("))) {
            result[k] = toNative((v as any)[k]);
          }
          return result;
        }
        return v;
      };
      return internString(JSON.stringify(toNative(val)));
    },
    parse: (s: unknown) => JSON.parse(isJSString(s) ? jsStringToString(s) : String(s)),
  });

  // console オブジェクトを組み込み (JSString → JS string 変換付き)
  const userLog = options.console?.log ?? console.log;
  const consoleObj: Record<string, (...args: unknown[]) => void> = {
    log: (...args: unknown[]) => userLog(...args.map(a => isJSString(a) ? jsStringToString(a) : a)),
  };
  env.defineReadOnly("console", consoleObj);
  const onStep = options.onStep ?? null;

  // 組み込みコンストラクタ
  env.defineReadOnly("Error", { __nativeConstructor: true, name: "Error" });
  // Symbol: 自前実装 (wrapper オブジェクト)
  const SymbolFn: any = (desc?: unknown) => {
    const d = desc !== undefined ? (isJSString(desc) ? jsStringToString(desc) : String(desc)) : "";
    return createSymbol(d);
  };
  SymbolFn.iterator = SYMBOL_ITERATOR;
  SymbolFn.toPrimitive = SYMBOL_TO_PRIMITIVE;
  SymbolFn.hasInstance = SYMBOL_HAS_INSTANCE;
  SymbolFn.toStringTag = SYMBOL_TO_STRING_TAG;
  env.defineReadOnly("Symbol", SymbolFn);

  // Promise 組み込み
  const PromiseConstructor: any = function PromiseCtor(executor: unknown) {
    if (typeof executor !== "function" && !isJSFunction(executor)) throw new TypeError("Promise resolver is not a function");
    return new JSPromise((resolve, reject) => {
      try {
        if (isJSFunction(executor)) {
          callJSFunctionSync(executor, undefined, [resolve, reject]);
        } else {
          (executor as Function)(resolve, reject);
        }
      } catch (e) {
        // ThrowSignal を unwrap して reject
        const unwrapped = e instanceof ThrowSignal ? e.value : e;
        reject(isJSString(unwrapped) ? jsStringToString(unwrapped) : unwrapped);
      }
    });
  };
  PromiseConstructor.__nativeConstructor = true;
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
    return { promise, resolve, reject };
  };
  env.defineReadOnly("Promise", PromiseConstructor);

  // 外部から渡されたグローバル変数を注入 (VM eval フォールバック用)
  if (options.globals) {
    for (const [k, v] of Object.entries(options.globals)) {
      if (!env.hasOwn(k)) env.define(k, v);
    }
  }

  // eval: indirect eval (グローバルスコープで実行)
  env.defineReadOnly("eval", (code: unknown) => {
    const s = isJSString(code) ? jsStringToString(code) : String(code);
    return evaluate(s, options);
  });

  _currentOnStep = onStep;
  try {
    const gen = evalProgram(ast, env);
    let result: unknown;
    while (true) {
      const r = gen.next();
      if (r.done) { result = r.value; break; }
    }
    // スクリプト実行完了後に microtask を drain
    drainMicrotasks();
    return isJSString(result) ? jsStringToString(result) : result;
  } finally {
    _currentOnStep = null;
  }
}

function* evalProgram(program: Program, env: Environment): Generator<unknown, unknown, unknown> {
  hoistVarDeclarations(program.body, env);
  hoistFunctionDeclarations(program.body, env);
  let result: unknown = undefined;
  for (const stmt of program.body) {
    result = yield* evalStatement(stmt, env);
  }
  return result;
}

// var 宣言を事前に undefined で登録する（ホイスティング）
function hoistVarDeclarations(stmts: Statement[], env: Environment): void {
  for (const stmt of stmts) {
    if (stmt.type === "VariableDeclaration" && stmt.kind === "var") {
      const varEnv = env.findVarScope();
      for (const decl of stmt.declarations) {
        for (const name of collectBoundNames(decl.id)) {
          if (!varEnv.hasOwn(name)) {
            varEnv.define(name, undefined);
          }
        }
      }
    } else if (stmt.type === "BlockStatement") {
      hoistVarDeclarations(stmt.body, env);
    } else if (stmt.type === "IfStatement") {
      hoistVarDeclarations([stmt.consequent], env);
      if (stmt.alternate) {
        hoistVarDeclarations([stmt.alternate], env);
      }
    } else if (stmt.type === "WhileStatement") {
      hoistVarDeclarations([stmt.body], env);
    } else if (stmt.type === "ForStatement") {
      if (stmt.init && stmt.init.type === "VariableDeclaration" && stmt.init.kind === "var") {
        const varEnv = env.findVarScope();
        for (const decl of stmt.init.declarations) {
          for (const name of collectBoundNames(decl.id)) {
            if (!varEnv.hasOwn(name)) {
              varEnv.define(name, undefined);
            }
          }
        }
      }
      hoistVarDeclarations([stmt.body], env);
    } else if (stmt.type === "ForOfStatement" || stmt.type === "ForInStatement") {
      const left = (stmt as any).left;
      if (left?.kind === "var") {
        const varEnv = env.findVarScope();
        for (const decl of left.declarations) {
          for (const name of collectBoundNames(decl.id)) {
            if (!varEnv.hasOwn(name)) {
              varEnv.define(name, undefined);
            }
          }
        }
      }
      hoistVarDeclarations([(stmt as any).body], env);
    } else if (stmt.type === "DoWhileStatement") {
      hoistVarDeclarations([(stmt as any).body], env);
    } else if (stmt.type === "TryStatement") {
      const s = stmt as any;
      if (s.block) hoistVarDeclarations(s.block.body, env);
      if (s.handler?.body) hoistVarDeclarations(s.handler.body.body, env);
      if (s.finalizer) hoistVarDeclarations(s.finalizer.body, env);
    } else if (stmt.type === "SwitchStatement") {
      for (const c of (stmt as any).cases ?? []) hoistVarDeclarations(c.consequent ?? [], env);
    } else if ((stmt as any).type === "LabeledStatement") {
      hoistVarDeclarations([(stmt as any).body], env);
    }
  }
}

// 関数宣言を事前に登録する（関数ホイスティング）
function hoistFunctionDeclarations(stmts: Statement[], env: Environment): void {
  for (const stmt of stmts) {
    if (stmt.type === "FunctionDeclaration") {
      const fn: JSFunction = {
        [JS_FUNCTION_BRAND]: true,
        name: stmt.id.name,
        params: stmt.params,
        body: stmt.body,
        closure: env,
        prototype: {},
      };
      if ((stmt as any).generator) (fn as any).isGenerator = true;
      if ((stmt as any).async) (fn as any).isAsync = true;
      env.define(stmt.id.name, fn);
    }
  }
}

// getter/setter の本体を実行するヘルパー (generator版)
function* evalBlock(body: Statement[], env: Environment): Generator<unknown, unknown, unknown> {
  let result: unknown = undefined;
  for (const s of body) result = yield* evalStatement(s, env);
  return result;
}

// evalBlock を同期的に実行するヘルパー (getter/setter 用)
function evalBlockSync(body: Statement[], env: Environment): unknown {
  try {
    const gen = evalBlock(body, env);
    let r = gen.next();
    while (!r.done) r = gen.next(undefined);
    return r.value;
  } catch (e) {
    if (e instanceof ReturnSignal) return e.value;
    throw e;
  }
}

function classKeyName(key: any, computed?: boolean, env?: Environment): string {
  if (computed && env) {
    const val = exhaustGen(evalExpression(key, env));
    if (isJSSymbol(val)) return val.key;
    return isJSString(val) ? jsStringToString(val) : String(val);
  }
  if (key.type === "Literal") return String(key.value);
  return key.name;
}

function* evalClassDeclaration(stmt: Statement & { type: "ClassDeclaration" }, env: Environment): Generator<unknown, unknown, unknown> {
  const superClass = stmt.superClass ? (yield* evalExpression(stmt.superClass, env)) as JSFunction | null : null;

  // constructor メソッドを探す
  const ctorMethod = stmt.body.body.find((m: any) => m.type === "MethodDefinition" && m.kind === "constructor");

  // インスタンスフィールド定義を収集
  const instanceFields = stmt.body.body.filter((m: any) => m.type === "PropertyDefinition" && !m.static);

  // コンストラクタ関数を作成
  let ctorFn: JSFunction;
  const className = stmt.id.name;
  if (ctorMethod) {
    ctorFn = {
      [JS_FUNCTION_BRAND]: true,
      name: className,
      params: ctorMethod.value.params,
      body: ctorMethod.value.body,
      closure: env,
      isClass: true,
      prototype: {},
    };
  } else if (superClass && (superClass as any).params) {
    ctorFn = {
      [JS_FUNCTION_BRAND]: true,
      name: className,
      params: superClass.params,
      body: superClass.body,
      closure: superClass.closure,
      isClass: true,
      prototype: {},
    };
  } else if (superClass) {
    // host コンストラクタ (Error 等) の派生デフォルト ctor。
    // 本体は空にし、NewExpression 側で host インスタンスの own props をコピーする
    ctorFn = {
      [JS_FUNCTION_BRAND]: true,
      name: className,
      params: [],
      body: { type: "BlockStatement", body: [] } as any,
      closure: env,
      isClass: true,
      prototype: {},
    };
    (ctorFn as any).__hostSuperDefault = superClass;
  } else {
    ctorFn = {
      [JS_FUNCTION_BRAND]: true,
      name: className,
      params: [],
      body: { type: "BlockStatement", body: [] },
      closure: env,
      isClass: true,
      prototype: {},
    };
  }

  // インスタンスフィールドを __instanceFields に保存 (new 時に初期化)。
  // 派生クラスのデフォルト ctor (親の params/body を再利用) は super() を
  // 実行しないため、親のフィールドをマージして new 時にまとめて初期化する
  const parentFields = (!ctorMethod && superClass && (superClass as any).__instanceFields)
    ? (superClass as any).__instanceFields as any[] : [];
  if (instanceFields.length > 0 || parentFields.length > 0) {
    (ctorFn as any).__instanceFields = [...parentFields, ...instanceFields];
  }

  // メソッド/getter/setter を prototype (or class 自体 for static) に登録
  for (const member of stmt.body.body) {
    if (member.type === "PropertyDefinition") continue; // フィールドは後で処理
    const target = member.static ? ctorFn : ctorFn.prototype;
    const name = classKeyName(member.key, member.computed, env);

    if (member.kind === "method" || member.kind === "constructor") {
      if (member.kind === "constructor") continue; // constructor は ctorFn 自体
      const fn: JSFunction = {
        [JS_FUNCTION_BRAND]: true,
        name,
        params: member.value.params,
        body: member.value.body,
        closure: env,
        prototype: {},
      };
      if ((member.value as any).generator) (fn as any).isGenerator = true;
      if ((member.value as any).async) (fn as any).isAsync = true;
      // class メソッドは spec 準拠で non-enumerable
      Object.defineProperty(target as object, name, { value: fn, writable: true, enumerable: false, configurable: true });
    } else if (member.kind === "get" || member.kind === "set") {
      const fn: JSFunction = {
        [JS_FUNCTION_BRAND]: true,
        name: `${member.kind} ${name}`,
        params: member.value.params,
        body: member.value.body,
        closure: env,
        prototype: {},
      };
      const descriptor: PropertyDescriptor = Object.getOwnPropertyDescriptor(target, name) ?? {};
      if (member.kind === "get") {
        const getterFn = fn;
        descriptor.get = function() {
          const callEnv = new Environment(getterFn.closure, true);
          callEnv.setThis(this);
          hoistVarDeclarations(getterFn.body.body, callEnv);
          return evalBlockSync(getterFn.body.body, callEnv);
        };
      }
      if (member.kind === "set") {
        const setterFn = fn;
        descriptor.set = function(v: unknown) {
          const callEnv = new Environment(setterFn.closure, true);
          callEnv.setThis(this);
          callEnv.define(setterFn.params[0].name, v);
          hoistVarDeclarations(setterFn.body.body, callEnv);
          evalBlockSync(setterFn.body.body, callEnv);
        };
      }
      descriptor.configurable = true;
      descriptor.enumerable = false;
      Object.defineProperty(target, name, descriptor);
    }
  }

  // static フィールドを初期化
  for (const member of stmt.body.body) {
    if (member.type === "PropertyDefinition" && member.static) {
      const name = classKeyName(member.key, member.computed, env);
      const value = member.value ? yield* evalExpression(member.value, env) : undefined;
      (ctorFn as any)[name] = value;
    }
  }

  // extends: プロトタイプチェーンを接続
  if (superClass) {
    if ((superClass as any).prototype) {
      ctorFn.prototype[PROTO_KEY] = (superClass as any).prototype;
    }
    // 静的側: B.staticMethod() が親の static を見つけられるように
    // (getProperty は PROTO_KEY チェーンを辿る)
    (ctorFn as any)[PROTO_KEY] = superClass;
    const classEnv = new Environment(env);
    classEnv.define("__super__", superClass);
    ctorFn.closure = classEnv;
    // メソッドの closure も更新
    for (const member of stmt.body.body) {
      if (member.type === "MethodDefinition" && member.kind === "method") {
        const target = member.static ? ctorFn : ctorFn.prototype;
        const name = classKeyName(member.key, member.computed, env);
        if ((target as any)[name] && isJSFunction((target as any)[name])) {
          ((target as any)[name] as JSFunction).closure = classEnv;
        }
      }
    }
  }

  env.define(stmt.id.name, ctorFn);
  return undefined;
}

// collectBoundNames, bindPattern, assignPattern は values.ts に移動済み

// 引数リストを評価（SpreadElement を展開）
function* evalArguments(argNodes: any[], env: Environment): Generator<unknown, unknown[], unknown> {
  const result: unknown[] = [];
  for (const arg of argNodes) {
    if (arg.type === "SpreadElement") {
      const arr = (yield* evalExpression(arg.argument, env)) as unknown[];
      result.push(...arr);
    } else {
      result.push(yield* evalExpression(arg, env));
    }
  }
  return result;
}

function* evalStatement(stmt: Statement, env: Environment): Generator<unknown, unknown, unknown> {
  if (_currentOnStep && stmt.type !== "BlockStatement") {
    _currentOnStep({ type: stmt.type, env: env.dump() });
  }
  switch (stmt.type) {
    case "ExpressionStatement":
      return yield* evalExpression(stmt.expression, env);
    case "VariableDeclaration": {
      for (const decl of stmt.declarations) {
        const value = decl.init ? yield* evalExpression(decl.init, env) : undefined;
        // 変数名から関数の name を推論: var f = function() {} → f.name === "f"
        if (decl.id.type === "Identifier" && isJSFunction(value) && !value.name) {
          value.name = decl.id.name;
        }
        if (decl.id.type === "Identifier" && stmt.kind === "var" && !decl.init) {
          // var 再宣言（初期化なし）の no-op 処理
          const varEnv = env.findVarScope();
          if (!varEnv.hasOwn(decl.id.name)) {
            varEnv.define(decl.id.name, undefined);
          }
        } else {
          bindPattern(decl.id, value, env, stmt.kind, (expr: any) => exhaustGen(evalExpression(expr, env)));
        }
      }
      return undefined;
    }
    case "FunctionDeclaration": {
      // 既にホイスティングで登録済みなので何もしない
      return undefined;
    }
    case "ClassDeclaration": {
      return yield* evalClassDeclaration(stmt, env);
    }
    case "ReturnStatement": {
      const value = stmt.argument ? yield* evalExpression(stmt.argument, env) : undefined;
      throw new ReturnSignal(value);
    }
    case "BreakStatement":
      throw new BreakSignal(stmt.label);
    case "ContinueStatement":
      throw new ContinueSignal(stmt.label);
    case "ThrowStatement": {
      const value = yield* evalExpression(stmt.argument, env);
      throw new ThrowSignal(value);
    }
    case "TryStatement": {
      let result: unknown = undefined;
      let thrown: { error: unknown } | null = null;

      try {
        result = yield* evalStatement(stmt.block, env);
      } catch (e) {
        if (e instanceof ReturnSignal) {
          // return は try/catch を突き抜ける（finally は実行する）
          if (stmt.finalizer) yield* evalStatement(stmt.finalizer, env);
          throw e;
        }

        // ThrowSignal または JS ランタイムエラー (ReferenceError 等)
        const errorValue = e instanceof ThrowSignal ? e.value : e;

        if (stmt.handler) {
          const catchEnv = new Environment(env);
          catchEnv.define(stmt.handler.param.name, errorValue);
          try {
            result = yield* evalStatement(stmt.handler.body, catchEnv);
          } catch (catchError) {
            // catch ブロック内の例外も finally の後に再 throw
            if (stmt.finalizer) yield* evalStatement(stmt.finalizer, env);
            throw catchError;
          }
        } else {
          // catch がない場合、finally の後に再 throw
          thrown = { error: e };
        }
      }

      if (stmt.finalizer) {
        yield* evalStatement(stmt.finalizer, env);
      }

      // catch がなく throw された場合は再 throw
      if (thrown) {
        throw thrown.error;
      }

      return result;
    }
    case "IfStatement": {
      const test = yield* evalExpression(stmt.test, env);
      if (isTruthy(test)) {
        return yield* evalStatement(stmt.consequent, env);
      } else if (stmt.alternate) {
        return yield* evalStatement(stmt.alternate, env);
      }
      return undefined;
    }
    case "SwitchStatement": {
      const disc = yield* evalExpression(stmt.discriminant, env);
      // switch 全体が 1 つのブロックスコープ (strict)。case 内の function 宣言は
      // switch ブロック先頭に巻き上げ (前方の case や test からも呼べ、外には漏れない)
      const switchEnv = new Environment(env);
      hoistFunctionDeclarations(stmt.cases.flatMap((c: any) => c.consequent ?? []), switchEnv);
      let matched = false;
      let result: unknown = undefined;
      for (const c of stmt.cases) {
        if (!matched && c.test !== null) {
          const testVal = yield* evalExpression(c.test, switchEnv);
          // JSString 対応の === 比較
          if (isJSString(disc) && isJSString(testVal)) {
            matched = jsStringEquals(disc, testVal);
          } else {
            matched = disc === testVal;
          }
        }
        if (!matched && c.test === null) matched = true; // default
        if (matched) {
          for (const s of c.consequent) {
            try {
              result = yield* evalStatement(s, switchEnv);
            } catch (e) {
              if (e instanceof BreakSignal && !e.label) return result;
              throw e;
            }
          }
        }
      }
      return result;
    }
    case "ForInStatement": {
      const lbl = (stmt as any).__label__ as string | undefined;
      const obj = yield* evalExpression(stmt.right, env);
      if (obj === null || obj === undefined) return undefined;
      const keys = typeof obj === "object" ? Object.keys(obj).filter(k => k !== "__proto__" && k !== "__hc__" && k !== "__slots__" && !k.startsWith("Symbol(")) : [];
      for (const key of keys) {
        const varName = stmt.left.declarations[0].id.name;
        if (stmt.left.kind === "var") {
          try { env.set(varName, internString(key)); } catch { env.define(varName, internString(key)); }
        } else {
          env.define(varName, internString(key));
        }
        try {
          yield* evalStatement(stmt.body, env);
        } catch (e) {
          if (e instanceof BreakSignal && (!e.label || e.label === lbl)) break;
          if (e instanceof ContinueSignal && (!e.label || e.label === lbl)) continue;
          throw e;
        }
      }
      return undefined;
    }
    case "DoWhileStatement": {
      const lbl = (stmt as any).__label__ as string | undefined;
      outer_dowhile: do {
        try {
          yield* evalStatement(stmt.body, env);
        } catch (e) {
          if (e instanceof BreakSignal && (!e.label || e.label === lbl)) break outer_dowhile;
          if (e instanceof ContinueSignal && (!e.label || e.label === lbl)) continue outer_dowhile;
          throw e;
        }
      } while (isTruthy(yield* evalExpression(stmt.test, env)));
      return undefined;
    }
    case "WhileStatement": {
      const lbl = (stmt as any).__label__ as string | undefined;
      outer_while: while (isTruthy(yield* evalExpression(stmt.test, env))) {
        try {
          yield* evalStatement(stmt.body, env);
        } catch (e) {
          if (e instanceof BreakSignal && (!e.label || e.label === lbl)) break outer_while;
          if (e instanceof ContinueSignal && (!e.label || e.label === lbl)) continue outer_while;
          throw e;
        }
      }
      return undefined;
    }
    case "ForStatement": {
      const lbl = (stmt as any).__label__ as string | undefined;
      const isBlockScoped = stmt.init?.type === "VariableDeclaration" && stmt.init.kind !== "var";
      const forEnv = isBlockScoped ? new Environment(env) : env;

      if (stmt.init) {
        if (stmt.init.type === "VariableDeclaration") {
          yield* evalStatement(stmt.init, forEnv);
        } else {
          yield* evalExpression(stmt.init, forEnv);
        }
      }
      outer_for: while (!stmt.test || isTruthy(yield* evalExpression(stmt.test, forEnv))) {
        try {
          yield* evalStatement(stmt.body, forEnv);
        } catch (e) {
          if (e instanceof BreakSignal && (!e.label || e.label === lbl)) break outer_for;
          if (e instanceof ContinueSignal && (!e.label || e.label === lbl)) { if (stmt.update) yield* evalExpression(stmt.update, forEnv); continue outer_for; }
          throw e;
        }
        if (stmt.update) yield* evalExpression(stmt.update, forEnv);
      }
      return undefined;
    }
    case "ForOfStatement": {
      const lbl = (stmt as any).__label__ as string | undefined;
      const rawIterable = yield* evalExpression(stmt.right, env);
      // iterator プロトコル: "@@iterator" or Symbol.iterator キーがあれば使う、なければ配列として扱う
      let iterable: unknown[];
      const iterKey = "@@iterator";
      let iterFn = typeof rawIterable === "object" && rawIterable !== null
        ? getProperty(rawIterable as JSObject, iterKey) ?? (rawIterable as any)[iterKey]
        : undefined;
      // ネイティブ Symbol.iterator もチェック (new Range() 等)
      if (!iterFn && typeof rawIterable === "object" && rawIterable !== null && typeof (rawIterable as any)[Symbol.iterator] === "function") {
        iterFn = (rawIterable as any)[Symbol.iterator].bind(rawIterable);
      }
      if (iterFn && (isJSFunction(iterFn) || typeof iterFn === "function")) {
        const iterator = isJSFunction(iterFn)
          ? yield* evalCallWithJSFunction(iterFn, [], env, rawIterable)
          : (iterFn as Function).call(rawIterable);
        iterable = [];
        for (let step = 0; step < 10000; step++) {
          const nextFn = getProperty(iterator as JSObject, "next") ?? (iterator as any)?.next;
          const result = isJSFunction(nextFn)
            ? yield* evalCallWithJSFunction(nextFn, [], env)
            : typeof nextFn === "function" ? nextFn.call(iterator) : undefined;
          if (!result || (result as any).done) break;
          iterable.push((result as any).value);
        }
      } else {
        iterable = rawIterable as unknown[];
      }
      const kind = stmt.left.kind;
      const isBlockScoped = kind !== "var";
      const pattern = stmt.left.declarations[0].id;

      for (const item of iterable) {
        const iterEnv = isBlockScoped ? new Environment(env) : env;
        bindPattern(pattern, item, iterEnv, kind, (expr: any) => exhaustGen(evalExpression(expr, iterEnv)));
        try {
          yield* evalStatement(stmt.body, iterEnv);
        } catch (e) {
          if (e instanceof BreakSignal && (!e.label || e.label === lbl)) break;
          if (e instanceof ContinueSignal && (!e.label || e.label === lbl)) continue;
          throw e;
        }
      }
      return undefined;
    }
    case "LabeledStatement": {
      // ラベルをループの body に伝播
      (stmt.body as any).__label__ = stmt.label;
      try {
        return yield* evalStatement(stmt.body, env);
      } catch (e) {
        // ラベル付き break がループ以外の文に使われた場合
        if (e instanceof BreakSignal && e.label === stmt.label) return undefined;
        throw e;
      }
    }
    case "BlockStatement": {
      // ブロックスコープ: let/const が閉じるように子環境を作る
      const blockEnv = new Environment(env);
      // ブロック内の let/const を TDZ で事前登録 + 重複チェック
      for (const s of stmt.body) {
        if (s.type === "VariableDeclaration" && s.kind !== "var") {
          for (const decl of s.declarations) {
            for (const name of collectBoundNames(decl.id)) {
              if (blockEnv.hasOwn(name)) {
                throw new SyntaxError(`Identifier '${name}' has already been declared`);
              }
              blockEnv.declareTDZ(name);
            }
          }
        }
      }
      // ブロック内 function 宣言をブロック先頭に巻き上げ (strict: block-scoped)。
      // ブロック内では宣言前から呼べ、ブロックの外には漏れない
      hoistFunctionDeclarations(stmt.body, blockEnv);
      let result: unknown = undefined;
      for (const s of stmt.body) {
        result = yield* evalStatement(s, blockEnv);
      }
      return result;
    }
  }
}

function* evalExpression(expr: Expression, env: Environment): Generator<unknown, unknown, unknown> {
  switch (expr.type) {
    case "Literal":
      return typeof expr.value === "string" ? internString(expr.value) : expr.value;
    case "RegExpLiteral":
      return new RegExp(expr.pattern, expr.flags);
    case "Identifier":
      return env.get(expr.name);
    case "ThisExpression":
      return env.getThis();
    case "FunctionExpression": {
      const fn: JSFunction = {
        [JS_FUNCTION_BRAND]: true,
        name: expr.id?.name ?? "",
        params: expr.params,
        body: expr.body,
        closure: env,
        prototype: {},
      };
      if ((expr as any).generator) (fn as any).isGenerator = true;
      if ((expr as any).async) (fn as any).isAsync = true;
      // 名前付き関数式の場合、自身のスコープで自分を参照可能にする
      if (expr.id) {
        const fnEnv = new Environment(env);
        fnEnv.define(expr.id.name, fn);
        fn.closure = fnEnv;
      }
      return fn;
    }
    case "ClassExpression": {
      // ClassExpression は ClassDeclaration と同じロジックだが env.define しない
      const fakeStmt = { ...expr, type: "ClassDeclaration", id: expr.id ?? { type: "Identifier", name: "__anonymous__" } } as any;
      // evalClassDeclaration は env.define するので、一時 env を使う
      const tempEnv = new Environment(env);
      yield* evalClassDeclaration(fakeStmt, tempEnv);
      return tempEnv.get(fakeStmt.id.name);
    }
    case "ArrowFunctionExpression": {
      const fn: JSFunction = {
        [JS_FUNCTION_BRAND]: true,
        name: "",
        params: expr.params,
        body: expr.expression
          ? { type: "BlockStatement", body: [{ type: "ReturnStatement", argument: expr.body as Expression }] }
          : expr.body as { type: "BlockStatement"; body: Statement[] },
        closure: env,
        isArrow: true,
        prototype: undefined as any, // アロー関数は prototype を持たない
      };
      if ((expr as any).async) (fn as any).isAsync = true;
      return fn;
    }
    case "TemplateLiteral": {
      let result: JSString = internString("");
      for (let i = 0; i < expr.quasis.length; i++) {
        result = jsStringConcat(result, internString(expr.quasis[i].value.cooked));
        if (i < expr.expressions.length) {
          const val = yield* evalExpression(expr.expressions[i], env);
          const prim = toPrimitive(val, "string");
          const s = isJSString(prim) ? prim : createSeqString(String(prim));
          result = jsStringConcat(result, s);
        }
      }
      return result;
    }
    case "TaggedTemplateExpression": {
      const tag = yield* evalExpression((expr as any).tag, env);
      const quasi = (expr as any).quasi;
      // strings 配列 (cooked) + raw プロパティ
      const strings = quasi.quasis.map((q: any) => q.value.cooked);
      (strings as any).raw = quasi.quasis.map((q: any) => q.value.raw);
      // 式の値を評価
      const values: unknown[] = [];
      for (const e of quasi.expressions) {
        values.push(yield* evalExpression(e, env));
      }
      // tag(strings, ...values) を呼び出す
      if (typeof tag === "function") {
        return (tag as Function)(strings, ...values);
      }
      if (isJSFunction(tag)) {
        return yield* evalCallWithJSFunction(tag, [strings, ...values], env);
      }
      throw new TypeError("tag is not a function");
    }
    case "SequenceExpression": {
      let result: unknown = undefined;
      for (const e of expr.expressions) {
        result = yield* evalExpression(e, env);
      }
      return result;
    }
    case "UpdateExpression": {
      // ++x, x++, --x, x--
      const arg = expr.argument;
      let oldValue: number;
      if (arg.type === "Identifier") {
        oldValue = toNumericOperand(toPrimitive(env.get(arg.name)));
      } else {
        // MemberExpression
        const obj = (yield* evalExpression(arg.object, env)) as JSObject;
        const key = yield* resolveMemberKey(arg, env);
        oldValue = toNumericOperand(toPrimitive(getProperty(obj, key)));
      }
      const newValue = expr.operator === "++" ? oldValue + 1 : oldValue - 1;
      if (arg.type === "Identifier") {
        env.set(arg.name, newValue);
      } else {
        const obj = (yield* evalExpression(arg.object, env)) as JSObject;
        const key = yield* resolveMemberKey(arg, env);
        obj[key] = newValue;
      }
      return expr.prefix ? newValue : oldValue;
    }
    case "NewExpression":
      return yield* evalNewExpression(expr, env);
    case "ObjectExpression": {
      const obj: Record<string, unknown> = {};
      for (const prop of expr.properties) {
        if (prop.type === "SpreadElement") {
          const source = (yield* evalExpression(prop.argument, env)) as Record<string, unknown>;
          if (isJSString(source)) {
            // {..."ab"} = {0:"a", 1:"b"}。JSString は Object.assign だと内部
            // フィールドが漏れるので 1 文字ずつインデックスキーで展開する
            const s = jsStringToString(source);
            for (let i = 0; i < s.length; i++) (obj as Record<string, unknown>)[String(i)] = createSeqString(s[i]);
          } else if (source) {
            Object.assign(obj, source);
          }
        } else {
          const rawKey = prop.computed ? yield* evalExpression(prop.key, env) : undefined;
          const key = prop.computed ? (isJSSymbol(rawKey) ? rawKey.key : isJSString(rawKey) ? jsStringToString(rawKey) : String(rawKey)) : (prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value));

          if (prop.kind === "get" || prop.kind === "set") {
            const fnValue = yield* evalExpression(prop.value, env);
            const descriptor: PropertyDescriptor = {};
            const existing = Object.getOwnPropertyDescriptor(obj, key);
            if (existing) {
              descriptor.get = existing.get;
              descriptor.set = existing.set;
            }
            if (prop.kind === "get") {
              if (isJSFunction(fnValue)) {
                const fn = fnValue;
                descriptor.get = function() {
                  const callEnv = new Environment(fn.closure, true);
                  callEnv.setThis(this);
                  return evalBlockSync(fn.body.body, callEnv);
                };
              } else {
                descriptor.get = fnValue as () => unknown;
              }
            }
            if (prop.kind === "set") {
              if (isJSFunction(fnValue)) {
                const fn = fnValue;
                descriptor.set = function(v: unknown) {
                  const callEnv = new Environment(fn.closure, true);
                  callEnv.setThis(this);
                  callEnv.define(fn.params[0].name, v);
                  evalBlockSync(fn.body.body, callEnv);
                };
              } else {
                descriptor.set = fnValue as (v: unknown) => void;
              }
            }
            descriptor.configurable = true;
            descriptor.enumerable = true;
            Object.defineProperty(obj, key, descriptor);
          } else {
            const val = yield* evalExpression(prop.value, env);
            // メソッド省略記法: 関数の name を設定
            if (isJSFunction(val) && !val.name) val.name = key;
            obj[key] = val;
          }
        }
      }
      return obj;
    }
    case "ArrayExpression": {
      const result: unknown[] = [];
      for (const el of expr.elements) {
        if (el.type === "SpreadElement") {
          const arr = (yield* evalExpression(el.argument, env)) as unknown[];
          result.push(...arr);
        } else {
          result.push(yield* evalExpression(el, env));
        }
      }
      return result;
    }
    case "MemberExpression": {
      // super.x の読み出し — 親 prototype チェーンから解決
      if (expr.object.type === "Identifier" && (expr.object as any).name === "__super__") {
        const superFn = env.get("__super__") as any;
        const key = yield* resolveMemberKey(expr, env);
        let proto: any = superFn?.prototype;
        while (proto && typeof proto === "object") {
          if (Object.prototype.hasOwnProperty.call(proto, key)) return proto[key];
          proto = proto[PROTO_KEY];
        }
        return undefined;
      }
      const obj = yield* evalExpression(expr.object, env);
      if (obj === null || obj === undefined) {
        if ((expr as any).optional) return undefined; // ?. → undefined
        const key = yield* resolveMemberKey(expr, env);
        throw new TypeError(`Cannot read properties of ${obj} (reading '${key}')`);
      }
      const key = yield* resolveMemberKey(expr, env);
      return getProperty(obj as JSObject, key);
    }
    case "AssignmentExpression": {
      if (expr.left.type === "ObjectPattern" || expr.left.type === "ArrayPattern") {
        const value = yield* evalExpression(expr.right, env);
        assignPattern(expr.left, value, env);
        return value;
      }

      // JS 仕様の評価順:
      // - メンバー代入は object (と computed key) の評価が右辺より先。ここで
      //   1 回だけ評価して読み出しと書き戻しの両方に使う (以前は右辺が先な上に
      //   書き戻しで object を再評価していた = 2 回評価)
      // - 複合代入は「左辺の参照解決 + 現在値の読み出し → 右辺の評価」。
      //   右辺を先に評価すると、未宣言変数への複合代入で右辺内の例外が
      //   ReferenceError より先に飛んでしまう
      const isMember = expr.left.type === "MemberExpression";
      let memberObj: Record<string, unknown> | null = null;
      let memberKey = "";
      // プリミティブ (null/undefined/string/number/boolean/symbol) へのプロパティ
      // 代入は strict では TypeError (ReferenceError でも暗黙 no-op でもない)。
      // 特に文字列は intern 共有オブジェクトなので、書き込みを許すと後続プログラムに
      // 状態が漏れる。単純代入 (=) は RHS 評価後、複合代入は現在値読み出し時に throw
      const isPrimitiveTarget = (v: unknown): boolean => {
        if (v === null || v === undefined) return true;
        const t = typeof v;
        if (t === "string" || t === "number" || t === "boolean" || t === "bigint") return true;
        return isJSString(v) || isJSSymbol(v);
      };
      const primTargetError = () => {
        const what = memberObj === null ? "null" : memberObj === undefined ? "undefined"
          : `${isJSString(memberObj) ? "string" : typeof memberObj}`;
        return new TypeError(`Cannot set properties of ${what} (setting '${memberKey}')`);
      };
      if (isMember) {
        memberObj = (yield* evalExpression(expr.left.object, env)) as Record<string, unknown>;
        memberKey = yield* resolveMemberKey(expr.left, env);
      }
      let newValue: unknown;
      if (expr.operator === "=") {
        newValue = yield* evalExpression(expr.right, env);
      } else {
        // 複合代入は現在値を読む。null/undefined はプロパティ読み出し自体が
        // TypeError。string/number/boolean/symbol は読みは undefined を返し
        // (throw しない)、書き込み時に TypeError になる (RHS 評価が先)
        if (isMember && (memberObj === null || memberObj === undefined)) throw primTargetError();
        const currentValue = isMember
          ? getProperty(memberObj as JSObject, memberKey)
          : env.get(expr.left.name);
        const rightValue = yield* evalExpression(expr.right, env);
        switch (expr.operator) {
          case "+=": {
            // 二項 + と同じ規則: ToPrimitive → どちらかが文字列なら JSString 連結
            // (host + に任せると host string が生まれ、intern 前提の比較から漏れる)
            const lp = toPrimitive(currentValue);
            const rp = toPrimitive(rightValue);
            if (isJSString(lp) || isJSString(rp) || typeof lp === "string" || typeof rp === "string") {
              const l = isJSString(lp) ? lp : createSeqString(String(lp));
              const r = isJSString(rp) ? rp : createSeqString(String(rp));
              newValue = jsStringConcat(l, r);
            } else {
              newValue = (lp as number) + (rp as number);
            }
            break;
          }
          case "-=": newValue = toNumericOperand(currentValue) - toNumericOperand(rightValue); break;
          case "*=": newValue = toNumericOperand(currentValue) * toNumericOperand(rightValue); break;
          case "/=": newValue = toNumericOperand(currentValue) / toNumericOperand(rightValue); break;
          case "%=": newValue = toNumericOperand(currentValue) % toNumericOperand(rightValue); break;
          default: throw new Error(`Unknown assignment operator: ${expr.operator}`);
        }
      }

      if (isMember) {
        if (isPrimitiveTarget(memberObj)) throw primTargetError();
        memberObj![memberKey] = newValue;
      } else {
        env.set(expr.left.name, newValue);
      }
      return newValue;
    }
    case "CallExpression":
      return yield* evalCallExpression(expr, env);
    case "UnaryExpression":
      return yield* evalUnaryExpression(expr, env);
    case "LogicalExpression":
      return yield* evalLogicalExpression(expr, env);
    case "BinaryExpression":
      return yield* evalBinaryExpression(expr, env);
    case "ConditionalExpression":
      return isTruthy(yield* evalExpression(expr.test, env))
        ? yield* evalExpression(expr.consequent, env)
        : yield* evalExpression(expr.alternate, env);
    case "YieldExpression": {
      const value = expr.argument ? yield* evalExpression(expr.argument, env) : undefined;
      return yield value; // host yield — suspends generator
    }
    case "AwaitExpression": {
      const value = expr.argument ? yield* evalExpression(expr.argument, env) : undefined;
      // await は yield と同じ: host generator を suspend して、
      // async 関数の runner が Promise.resolve(value).then(resume) で再開する
      return yield { __await__: true, value };
    }
  }
}

function* evalNewExpression(
  expr: Expression & { type: "NewExpression" },
  env: Environment,
): Generator<unknown, unknown, unknown> {
  const constructor = yield* evalExpression(expr.callee, env);
  const args = yield* evalArguments(expr.arguments, env);

  // 組み込みコンストラクタ (Error 等)。own プロパティ判定にする —
  // `class E extends Error` は PROTO_KEY 経由で __nativeConstructor が
  // 見えてしまうが、E 自体は JSFunction なので通常経路で実行する
  if (typeof constructor === "object" && constructor !== null
      && Object.prototype.hasOwnProperty.call(constructor, "__nativeConstructor")) {
    const ctor = constructor as { name: string };
    if (ctor.name === "Error") {
      return { message: args[0] ?? "" };
    }
    throw new Error(`Unknown native constructor: ${ctor.name}`);
  }

  // ネイティブコンストラクタ (Object, Boolean, Number, String, Array, etc.)
  if (typeof constructor === "function") {
    return new (constructor as any)(...args);
  }

  if (!isJSFunction(constructor)) {
    throw new TypeError("Constructor is not a function");
  }

  if (constructor.isArrow) {
    throw new TypeError("Arrow function is not a constructor");
  }

  // 新しいオブジェクトを作成し、prototype チェーンを接続
  const newObj: Record<string, unknown> = {};
  newObj[PROTO_KEY] = constructor.prototype;

  // native/host コンストラクタ (Error 等) の派生デフォルト ctor:
  // 親のプロパティ (message 等) を this に与える
  if ((constructor as any).__hostSuperDefault) {
    const hostCtor = (constructor as any).__hostSuperDefault;
    if (hostCtor && typeof hostCtor === "object" && hostCtor.__nativeConstructor) {
      // jsmini の native コンストラクタ (Error)
      if (hostCtor.name === "Error") newObj.message = args[0] ?? "";
    } else if (typeof hostCtor === "function") {
      try {
        const tmp = new (hostCtor as new (...a: unknown[]) => object)(...args);
        if (tmp && typeof tmp === "object") {
          for (const k of Object.getOwnPropertyNames(tmp)) {
            newObj[k] = (tmp as Record<string, unknown>)[k];
          }
        }
      } catch { /* host ctor が失敗しても継続 */ }
    }
  }

  // 関数スコープを作成し this を新オブジェクトにバインド
  const fnEnv = new Environment(constructor.closure, true);
  fnEnv.setThis(newObj);
  for (let i = 0; i < constructor.params.length; i++) {
    const param = constructor.params[i];
    if (param.type === "RestElement") {
      fnEnv.define(param.argument.name, args.slice(i));
    } else {
      yield* bindParam(param, i < args.length ? args[i] : undefined, fnEnv, fnEnv);
    }
  }
  // インスタンスフィールドを初期化
  if ((constructor as any).__instanceFields) {
    for (const field of (constructor as any).__instanceFields) {
      const name = classKeyName(field.key, field.computed, fnEnv);
      const value = field.value ? yield* evalExpression(field.value, fnEnv) : undefined;
      newObj[name] = value;
    }
  }

  hoistVarDeclarations(constructor.body.body, fnEnv);
  hoistFunctionDeclarations(constructor.body.body, fnEnv);

  let returnValue: unknown = undefined;
  try {
    for (const stmt of constructor.body.body) {
      yield* evalStatement(stmt, fnEnv);
    }
  } catch (e) {
    if (e instanceof ReturnSignal) {
      returnValue = e.value;
    } else {
      throw e;
    }
  }

  // コンストラクタがオブジェクトを return したらそれを使う。プリミティブなら this を使う。
  if (returnValue !== undefined && typeof returnValue === "object" && returnValue !== null) {
    return returnValue;
  }
  return newObj;
}

// jsmini の JSFunction をネイティブから呼べるようにするヘルパー
// パラメータバインド: AssignmentPattern (デフォルト引数) を処理
function* bindParam(param: any, value: unknown, env: Environment, evalEnv: Environment): Generator<unknown, void, unknown> {
  if (param.type === "AssignmentPattern") {
    const val = value !== undefined ? value : yield* evalExpression(param.right, evalEnv);
    bindPattern(param.left, val, env, "let");
  } else {
    bindPattern(param, value, env, "let");
  }
}

function* evalCallWithJSFunction(fn: unknown, args: unknown[], env: Environment, overrideThis?: unknown): Generator<unknown, unknown, unknown> {
  if (!isJSFunction(fn)) return undefined;
  const jsFn = fn;

  // Generator function: return generator object instead of executing
  if ((jsFn as any).isGenerator) {
    const fnEnv = new Environment(jsFn.closure, !jsFn.isArrow);
    if (overrideThis !== undefined) fnEnv.setThis(overrideThis);
    if (!jsFn.isArrow) {
      const argsObj = Object.create(null);
      for (let i = 0; i < args.length; i++) argsObj[i] = args[i];
      argsObj.length = args.length;
      fnEnv.define("arguments", argsObj);
    }
    for (let i = 0; i < jsFn.params.length; i++) {
      const param = jsFn.params[i];
      if (param.type === "RestElement") {
        fnEnv.define(param.argument.name, args.slice(i));
      } else {
        yield* bindParam(param, i < args.length ? args[i] : undefined, fnEnv, fnEnv);
      }
    }
    hoistVarDeclarations(jsFn.body.body, fnEnv);
    hoistFunctionDeclarations(jsFn.body.body, fnEnv);

    const bodyGen = evalBlock(jsFn.body.body, fnEnv);
    const genObj: Record<string, unknown> = {
      next(value: unknown) {
        const r = bodyGen.next(value);
        return { value: r.value, done: r.done };
      },
      return(value: unknown) { return bodyGen.return(value); },
      "@@iterator"() { return genObj; },
    };
    return genObj;
  }

  // Async function: return Promise, drive body via generator + microtask
  if ((jsFn as any).isAsync) {
    const fnEnv = new Environment(jsFn.closure, !jsFn.isArrow);
    if (overrideThis !== undefined) fnEnv.setThis(overrideThis);
    if (!jsFn.isArrow) {
      const argsObj = Object.create(null);
      for (let i = 0; i < args.length; i++) argsObj[i] = args[i];
      argsObj.length = args.length;
      fnEnv.define("arguments", argsObj);
    }
    for (let i = 0; i < jsFn.params.length; i++) {
      const param = jsFn.params[i];
      if (param.type === "RestElement") {
        fnEnv.define(param.argument.name, args.slice(i));
      } else {
        yield* bindParam(param, i < args.length ? args[i] : undefined, fnEnv, fnEnv);
      }
    }
    hoistVarDeclarations(jsFn.body.body, fnEnv);
    hoistFunctionDeclarations(jsFn.body.body, fnEnv);

    const bodyGen = evalBlock(jsFn.body.body, fnEnv);

    return new JSPromise((resolve, reject) => {
      function step(inputValue?: unknown): void {
        try {
          const { done, value } = bodyGen.next(inputValue);
          if (done) {
            // return or function end
            resolve!(value instanceof ReturnSignal ? value.value : value);
            return;
          }
          // value is { __await__: true, value: awaitedExpr }
          if (value && typeof value === "object" && (value as any).__await__) {
            const awaited = (value as any).value;
            JSPromise.resolve(awaited).then(
              (v: unknown) => step(v),
              (e: unknown) => {
                try { const r = bodyGen.throw(new ThrowSignal(e)); if (r.done) resolve!(r.value instanceof ReturnSignal ? r.value.value : r.value); else step(undefined); }
                catch (err) { if (err instanceof ReturnSignal) { resolve!(err.value); } else { reject!(err instanceof ThrowSignal ? err.value : err); } }
              },
            );
          } else {
            // non-await yield (shouldn't happen in async)
            step(value);
          }
        } catch (e) {
          if (e instanceof ReturnSignal) { resolve!(e.value); return; }
          reject!(e instanceof ThrowSignal ? (isJSString(e.value) ? jsStringToString(e.value) : e.value) : e);
        }
      }
      step();
    });
  }

  const fnEnv = new Environment(jsFn.closure, !jsFn.isArrow);
  if (overrideThis !== undefined) fnEnv.setThis(overrideThis);
  // arguments オブジェクト (アロー関数以外)
  if (!jsFn.isArrow) {
    const argsObj = Object.create(null);
    for (let i = 0; i < args.length; i++) argsObj[i] = args[i];
    argsObj.length = args.length;
    fnEnv.define("arguments", argsObj);
  }
  for (let i = 0; i < jsFn.params.length; i++) {
    const param = jsFn.params[i];
    if (param.type === "RestElement") {
      fnEnv.define(param.argument.name, args.slice(i));
    } else {
      yield* bindParam(param, i < args.length ? args[i] : undefined, fnEnv, fnEnv);
    }
  }
  hoistVarDeclarations(jsFn.body.body, fnEnv);
  hoistFunctionDeclarations(jsFn.body.body, fnEnv);
  try {
    for (const s of jsFn.body.body) yield* evalStatement(s, fnEnv);
  } catch (e) {
    if (e instanceof ReturnSignal) return e.value;
    throw e;
  }
  return undefined;
}

// 配列メソッドのうち文字列化/要素比較を含むものの自前実装 (VM index.ts の
// arrayPrototype と同一規則)。TW の配列は host メソッドに委譲しているが、
// host の join/sort/indexOf は JSString 要素を "[object Object]" として扱う
// (要素比較は intern されない concat 由来文字列も内容比較で見つける)
const TW_ARRAY_OVERRIDES: Record<string, Function> = {
  join: function(this: unknown[], sep?: unknown) {
    const s = sep === undefined ? "," : joinElementToString(sep);
    const parts: string[] = [];
    for (let i = 0; i < this.length; i++) parts.push(joinElementToString(this[i]));
    return internString(parts.join(s));
  },
  toString: function(this: unknown[]) {
    return internString(arrayToPrimitiveString(this));
  },
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
  sort: function(this: unknown[], cmpFn?: unknown) {
    // comparator は evalCallExpression の汎用ラップ済み (JSFunction → host callable)。
    // 既定比較は ToString の辞書順 — joinElementToString で JSString/オブジェクト要素も安全に
    const cmp = typeof cmpFn === "function"
      ? (a: unknown, b: unknown) => (cmpFn as Function)(a, b) as number
      : (a: unknown, b: unknown) => {
          const sa = joinElementToString(a), sb = joinElementToString(b);
          return sa < sb ? -1 : sa > sb ? 1 : 0;
        };
    return this.sort(cmp);
  },
};

function* evalCallExpression(
  expr: Expression & { type: "CallExpression" },
  env: Environment,
): Generator<unknown, unknown, unknown> {
  // メソッド呼び出し (obj.method()) の場合、this をバインドする
  let thisValue: unknown = undefined;
  let fn: unknown;
  if (expr.callee.type === "MemberExpression") {
    // super.m(...) — メソッドは親 prototype チェーンから解決し、
    // this は現在の this のまま呼ぶ (従来は superClass の静的側を見る誤実装だった)
    if (expr.callee.object.type === "Identifier" && (expr.callee.object as any).name === "__super__") {
      const superFn = env.get("__super__") as any;
      const key = yield* resolveMemberKey(expr.callee, env);
      let proto: any = superFn?.prototype;
      let method: unknown = undefined;
      while (proto && typeof proto === "object") {
        if (Object.prototype.hasOwnProperty.call(proto, key)) { method = proto[key]; break; }
        proto = proto[PROTO_KEY];
      }
      const superArgs = yield* evalArguments(expr.arguments, env);
      const selfThis = env.getThis();
      if (isJSFunction(method)) {
        return yield* evalCallWithJSFunction(method, superArgs, env, selfThis);
      }
      if (typeof method === "function") {
        return (method as Function).apply(selfThis, superArgs);
      }
      throw new TypeError(`super.${String(key)} is not a function`);
    }
    thisValue = yield* evalExpression(expr.callee.object, env);
    const key = yield* resolveMemberKey(expr.callee, env);
    fn = getProperty(thisValue as JSObject, key);
    // JSPromise: getProperty が native then/catch を返すので、JSFunction handler をラップ
    if (isJSPromise(thisValue) && (key === "then" || key === "catch") && typeof fn === "function") {
      // JSPromise.then/catch with JSFunction handler wrapping
      const nativeFn = fn as Function;
      const callArgs = yield* evalArguments(expr.arguments, env);
      const wrapHandler = (h: unknown) => {
        if (isJSFunction(h)) return (v: unknown) => {
          try { return callJSFunctionSync(h, undefined, [v]); }
          catch (e) {
            const unwrapped = e instanceof ThrowSignal ? e.value : e;
            throw isJSString(unwrapped) ? jsStringToString(unwrapped) : unwrapped;
          }
        };
        if (typeof h === "function") return h as (v: unknown) => unknown;
        return undefined;
      };
      if (key === "then") {
        return (thisValue as JSPromise).then(wrapHandler(callArgs[0]), wrapHandler(callArgs[1]));
      } else {
        return (thisValue as JSPromise).catch(wrapHandler(callArgs[0]));
      }
    }
    // JSFunction の .call / .apply / .bind
    if (fn === undefined && isJSFunction(thisValue)) {
      const jsFnObj = thisValue;
      if (key === "call") {
        const callArgs = yield* evalArguments(expr.arguments, env);
        const [callThis, ...rest] = callArgs;
        return yield* evalCallWithJSFunction(jsFnObj, rest, env, callThis);
      } else if (key === "apply") {
        const applyArgs = yield* evalArguments(expr.arguments, env);
        const [applyThis, argsArray] = applyArgs;
        const rest = Array.isArray(argsArray) ? argsArray : [];
        return yield* evalCallWithJSFunction(jsFnObj, rest, env, applyThis);
      } else if (key === "bind") {
        const bindArgs = yield* evalArguments(expr.arguments, env);
        const [bindThis, ...boundArgs] = bindArgs;
        const bound: JSFunction = {
          [JS_FUNCTION_BRAND]: true,
          name: `bound ${jsFnObj.name ?? ""}`,
          params: jsFnObj.params,
          body: jsFnObj.body,
          closure: jsFnObj.closure,
          isArrow: jsFnObj.isArrow,
          prototype: jsFnObj.prototype,
          __boundThis: bindThis,
          __boundArgs: boundArgs,
        };
        return bound;
      }
    }
    // 配列の文字列感受性メソッドは自前実装で上書き (host 実装は JSString を
    // "[object Object]" にしてしまう)。map/filter 等の callback 系は host +
    // 汎用 JSFunction ラップで正しく動くので対象外
    if (Array.isArray(thisValue) && typeof key === "string" && TW_ARRAY_OVERRIDES[key]) {
      fn = TW_ARRAY_OVERRIDES[key];
    }
    // (JSPromise の then/catch は getProperty の前で処理済み)
    // JSString のメソッド: ネイティブ文字列メソッドに委譲
    if (fn === undefined && isJSString(thisValue)) {
      const str = jsStringToString(thisValue);
      const nativeFn = (str as any)[key];
      if (typeof nativeFn === "function") {
        fn = (...a: unknown[]) => {
          const nativeArgs = a.map(x => isJSString(x) ? jsStringToString(x) : x);
          const result = nativeFn.apply(str, nativeArgs);
          if (typeof result === "string") return internString(result);
          if (Array.isArray(result)) return result.map((s: string) => typeof s === "string" ? internString(s) : s);
          return result;
        };
      } else if (isJSFunction(nativeFn)) {
        // user 拡張 (`String.prototype.foo = function(...) {...}` 等) — JSFunction を call
        const jsFn = nativeFn;
        fn = (...a: unknown[]) => callJSFunctionSync(jsFn, thisValue, a);
      }
    }
  } else {
    fn = yield* evalExpression(expr.callee, env);
  }

  const args = yield* evalArguments(expr.arguments, env);

  // direct eval: eval("code") — 呼び出し元のスコープで実行 (strict mode: var は eval スコープに閉じる)
  if (expr.callee.type === "Identifier" && expr.callee.name === "eval" && typeof fn === "function") {
    const code = args[0];
    if (typeof code !== "string" && !isJSString(code)) return code; // 文字列以外はそのまま返す
    const s = isJSString(code) ? jsStringToString(code) : code as string;
    const ast = parse(s);
    // eval 専用スコープ (親 = 呼び出し元の env)。var は eval スコープに閉じる (strict mode)
    const evalEnv = new Environment(env, true); // isFunctionScope=true で var を閉じ込める
    const gen = evalProgram(ast, evalEnv);
    let result: unknown;
    while (true) {
      const r = gen.next();
      if (r.done) { result = r.value; break; }
    }
    return result;
  }

  // super() で親が native (jsmini の Error オブジェクト) / host コンストラクタ:
  // 親の与えるプロパティ (message 等) を this に反映する
  if (expr.callee.type === "Identifier" && expr.callee.name === "__super__" && !isJSFunction(fn)) {
    const self = env.getThis() as Record<string, unknown> | undefined;
    if (fn && typeof fn === "object" && (fn as any).__nativeConstructor) {
      if ((fn as any).name === "Error" && self && typeof self === "object") {
        self.message = args[0] ?? "";
      }
      return undefined;
    }
    if (typeof fn === "function") {
      try {
        const tmp = new (fn as new (...a: unknown[]) => object)(...args);
        if (tmp && typeof tmp === "object" && self && typeof self === "object") {
          for (const k of Object.getOwnPropertyNames(tmp)) {
            self[k] = (tmp as Record<string, unknown>)[k];
          }
        }
      } catch { /* host ctor 失敗は無視 */ }
      return undefined;
    }
  }

  // super() 呼び出し: 親コンストラクタを現在の this で実行
  if (expr.callee.type === "Identifier" && expr.callee.name === "__super__" && isJSFunction(fn)) {
    const superFn = fn;
    const superEnv = new Environment(superFn.closure, true);
    superEnv.setThis(env.getThis());
    // 親の instance fields を初期化 (親の ctor 本体より先)
    if ((superFn as any).__instanceFields) {
      const selfObj = env.getThis() as Record<string, unknown>;
      for (const field of (superFn as any).__instanceFields) {
        const fname = classKeyName(field.key, field.computed, superEnv);
        selfObj[fname] = field.value ? yield* evalExpression(field.value, superEnv) : undefined;
      }
    }
    for (let i = 0; i < superFn.params.length; i++) {
      const param = superFn.params[i];
      if (param.type === "RestElement") {
        superEnv.define(param.argument.name, args.slice(i));
      } else {
        yield* bindParam(param, i < args.length ? args[i] : undefined, superEnv, superEnv);
      }
    }
    hoistVarDeclarations(superFn.body.body, superEnv);
    hoistFunctionDeclarations(superFn.body.body, superEnv);
    try {
      for (const s of superFn.body.body) {
        yield* evalStatement(s, superEnv);
      }
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
    return undefined;
  }

  // ネイティブ関数 (console.log 等)
  if (typeof fn === "function") {
    // コールバック系メソッド: jsmini 関数を呼べるようにラップ。
    // ラッパーには元の JSFunction をタグ付けする — String(fn) 等の文字列化が
    // ラッパー自身のソーステキストを漏らさないように (twStrConv が参照)
    const wrappedArgs = args.some(a => isJSFunction(a))
      ? args.map(a => {
          if (!isJSFunction(a)) return a;
          const w = (...nativeArgs: unknown[]) => exhaustGen(evalCallWithJSFunction(a, nativeArgs, env));
          (w as any).__wrappedJSFunction = a;
          return w;
        })
      : args;
    if (thisValue !== undefined) {
      return (fn as Function).apply(thisValue, wrappedArgs);
    }
    return (fn as Function)(...wrappedArgs);
  }

  if (!isJSFunction(fn)) {
    throw new TypeError(`${typeof fn} is not a function`);
  }

  if (fn.isClass) {
    throw new TypeError("Class constructor cannot be invoked without 'new'");
  }

  const jsFn = fn;

  // Async function: return Promise, drive body with generator + microtask
  if ((jsFn as any).isAsync) {
    const fnEnv = new Environment(jsFn.closure, !jsFn.isArrow);
    if (!jsFn.isArrow) {
      fnEnv.setThis(thisValue);
      const argsObj = Object.create(null);
      for (let i = 0; i < args.length; i++) argsObj[i] = args[i];
      argsObj.length = args.length;
      fnEnv.define("arguments", argsObj);
    }
    for (let i = 0; i < jsFn.params.length; i++) {
      const param = jsFn.params[i];
      if (param.type === "RestElement") {
        fnEnv.define(param.argument.name, args.slice(i));
      } else {
        yield* bindParam(param, i < args.length ? args[i] : undefined, fnEnv, fnEnv);
      }
    }
    hoistVarDeclarations(jsFn.body.body, fnEnv);
    hoistFunctionDeclarations(jsFn.body.body, fnEnv);
    const bodyGen = evalBlock(jsFn.body.body, fnEnv);
    return new JSPromise((resolve, reject) => {
      function step(inputValue?: unknown): void {
        try {
          const r = bodyGen.next(inputValue);
          if (r.done) { resolve!(r.value); return; }
          const yielded = r.value;
          if (yielded && typeof yielded === "object" && (yielded as any).__await__) {
            JSPromise.resolve((yielded as any).value).then(
              (v: unknown) => step(v),
              (e: unknown) => {
                try { const rr = bodyGen.throw(new ThrowSignal(e)); if (rr.done) resolve!(rr.value); else step(undefined); }
                catch (err) { if (err instanceof ReturnSignal) { resolve!(err.value); } else { reject!(err instanceof ThrowSignal ? (isJSString(err.value) ? jsStringToString(err.value) : err.value) : err); } }
              },
            );
          } else { step(yielded); }
        } catch (e) {
          if (e instanceof ReturnSignal) { resolve!(e.value); return; }
          reject!(e instanceof ThrowSignal ? (isJSString(e.value) ? jsStringToString(e.value) : e.value) : e);
        }
      }
      step();
    });
  }

  // Generator function: return generator object instead of executing to completion
  if ((jsFn as any).isGenerator) {
    const fnEnv = new Environment(jsFn.closure, !jsFn.isArrow);
    if (!jsFn.isArrow) {
      fnEnv.setThis(thisValue);
      const argsObj = Object.create(null);
      for (let i = 0; i < args.length; i++) argsObj[i] = args[i];
      argsObj.length = args.length;
      fnEnv.define("arguments", argsObj);
    }
    for (let i = 0; i < jsFn.params.length; i++) {
      const param = jsFn.params[i];
      if (param.type === "RestElement") {
        fnEnv.define(param.argument.name, args.slice(i));
      } else {
        yield* bindParam(param, i < args.length ? args[i] : undefined, fnEnv, fnEnv);
      }
    }
    hoistVarDeclarations(jsFn.body.body, fnEnv);
    hoistFunctionDeclarations(jsFn.body.body, fnEnv);

    const bodyGen = evalBlock(jsFn.body.body, fnEnv);
    const genObj: Record<string, unknown> = {
      next(value: unknown) {
        try {
          const r = bodyGen.next(value);
          return { value: r.value, done: r.done };
        } catch (e) {
          if (e instanceof ReturnSignal) return { value: e.value, done: true };
          throw e;
        }
      },
      return(value: unknown) { return bodyGen.return(value); },
      "@@iterator"() { return genObj; },
    };
    return genObj;
  }

  // 新しいスコープを作成（親 = 関数定義時のスコープ = クロージャ）
  // アロー関数は自身の this を持たない（クロージャの this を継承）
  const fnEnv = new Environment(jsFn.closure, !jsFn.isArrow);
  if (!jsFn.isArrow) {
    fnEnv.setThis(thisValue);
    const argsObj = Object.create(null);
    for (let i = 0; i < args.length; i++) argsObj[i] = args[i];
    argsObj.length = args.length;
    fnEnv.define("arguments", argsObj);
  }

  // 仮引数に実引数をバインド（分割代入 + レスト対応）
  for (let i = 0; i < jsFn.params.length; i++) {
    const param = jsFn.params[i];
    if (param.type === "RestElement") {
      fnEnv.define(param.argument.name, args.slice(i));
    } else {
      yield* bindParam(param, i < args.length ? args[i] : undefined, fnEnv, fnEnv);
    }
  }

  // 関数本体内の var と function をホイスト
  hoistVarDeclarations(jsFn.body.body, fnEnv);
  hoistFunctionDeclarations(jsFn.body.body, fnEnv);

  try {
    for (const stmt of jsFn.body.body) {
      yield* evalStatement(stmt, fnEnv);
    }
  } catch (e) {
    if (e instanceof ReturnSignal) {
      return e.value;
    }
    throw e;
  }
  return undefined;
}

function* evalUnaryExpression(
  expr: Expression & { type: "UnaryExpression" },
  env: Environment,
): Generator<unknown, unknown, unknown> {
  if (expr.operator === "typeof") {
    let value: unknown;
    if (expr.argument.type === "Identifier") {
      try {
        value = env.get(expr.argument.name);
      } catch (e) {
        // TDZ (Cannot access before initialization) は ReferenceError のまま投げる
        if (e instanceof ReferenceError && e.message.includes("before initialization")) {
          throw e;
        }
        // 未定義変数は "undefined" を返す（ReferenceError にしない）
        return internString("undefined");
      }
    } else {
      value = yield* evalExpression(expr.argument, env);
    }
    if (isJSSymbol(value)) return internString("symbol");
    if (isJSString(value)) return internString("string");
    if (value === null) return internString("object");
    if (isJSFunction(value)) return internString("function");
    return internString(typeof value);
  }

  if (expr.operator === "delete") {
    if (expr.argument.type === "MemberExpression") {
      const obj = yield* evalExpression(expr.argument.object, env);
      const key = yield* resolveMemberKey(expr.argument, env);
      if (obj && typeof obj === "object") {
        delete (obj as Record<string, unknown>)[key];
      }
      return true;
    }
    return true;
  }

  if (expr.operator === "void") {
    yield* evalExpression(expr.argument, env);
    return undefined;
  }

  const argument = yield* evalExpression(expr.argument, env);
  switch (expr.operator) {
    case "!": return !isTruthy(argument);
    case "-": return -toNumericOperand(toPrimitive(argument));
    case "~": return ~toNumericOperand(toPrimitive(argument));
    default:
      throw new Error(`Unknown unary operator: ${expr.operator}`);
  }
}

function* evalLogicalExpression(
  expr: Expression & { type: "LogicalExpression" },
  env: Environment,
): Generator<unknown, unknown, unknown> {
  const left = yield* evalExpression(expr.left, env);
  switch (expr.operator) {
    case "&&": return isTruthy(left) ? yield* evalExpression(expr.right, env) : left;
    case "||": return isTruthy(left) ? left : yield* evalExpression(expr.right, env);
    case "??": return (left !== null && left !== undefined) ? left : yield* evalExpression(expr.right, env);
    default:
      throw new Error(`Unknown logical operator: ${expr.operator}`);
  }
}

function* evalBinaryExpression(
  expr: Expression & { type: "BinaryExpression" },
  env: Environment,
): Generator<unknown, unknown, unknown> {
  const rawLeft = yield* evalExpression(expr.left, env);
  const rawRight = yield* evalExpression(expr.right, env);
  // 算術/比較演算子はオブジェクトを ToPrimitive で変換
  const left = toPrimitive(rawLeft);
  const right = toPrimitive(rawRight);
  switch (expr.operator) {
    case "+":
      // TW の toPrimitive はプレーンオブジェクトで host string を返すことが
      // あるので、host string も文字列連結の対象にして JSString を生成する
      // (host string のまま流すと intern 前提の内容比較から漏れる)
      if (isJSString(left) || isJSString(right) || typeof left === "string" || typeof right === "string") {
        const l = isJSString(left) ? left : createSeqString(String(left));
        const r = isJSString(right) ? right : createSeqString(String(right));
        return jsStringConcat(l, r);
      }
      return (left as number) + (right as number);
    case "-": return toNumericOperand(left) - toNumericOperand(right);
    case "*": return toNumericOperand(left) * toNumericOperand(right);
    case "/": return toNumericOperand(left) / toNumericOperand(right);
    case "%": return toNumericOperand(left) % toNumericOperand(right);
    case "**": return toNumericOperand(left) ** toNumericOperand(right);
    case "&": return toNumericOperand(left) & toNumericOperand(right);
    case "|": return toNumericOperand(left) | toNumericOperand(right);
    case "^": return toNumericOperand(left) ^ toNumericOperand(right);
    case "<<": return toNumericOperand(left) << toNumericOperand(right);
    case ">>": return toNumericOperand(left) >> toNumericOperand(right);
    case ">>>": return toNumericOperand(left) >>> toNumericOperand(right);
    // 相対比較: 両辺文字列なら辞書順 (JS 仕様 7.2.13)。JSString のまま
    // number キャストすると host の ToPrimitive で両辺 "[object Object]" になり
    // 'a' < 'b' すら false になる (VM の LessThan 系と同じ分岐にする)。
    // TW の toPrimitive はプレーンオブジェクトで host string を返すことが
    // あるので、JSString と host string の両方を文字列として扱う
    case "<": case ">": case "<=": case ">=": {
      const ls = isJSString(left) ? jsStringToString(left) : typeof left === "string" ? left : null;
      const rs = isJSString(right) ? jsStringToString(right) : typeof right === "string" ? right : null;
      if (ls !== null && rs !== null) {
        switch (expr.operator) {
          case "<": return ls < rs;
          case ">": return ls > rs;
          case "<=": return ls <= rs;
          default: return ls >= rs;
        }
      }
      const ln = toNumericOperand(left), rn = toNumericOperand(right);
      switch (expr.operator) {
        case "<": return ln < rn;
        case ">": return ln > rn;
        case "<=": return ln <= rn;
        default: return ln >= rn;
      }
    }
    case "==": {
      if (isJSString(left) && isJSString(right)) return jsStringEquals(left, right);
      // 両辺オブジェクトなら参照比較 (JS 仕様 7.2.14)。ToPrimitive しない。
      // これを怠ると別オブジェクト同士が "[object Object]" 同士で true になる
      if (isEqObjectTW(rawLeft) && isEqObjectTW(rawRight)) return rawLeft === rawRight;
      // JSString は host string に解いて host の == に委ねる。
      // string↔number/boolean の ToNumber 段 ("5" == 5 → true) を host が行う
      const lh = isJSString(left) ? jsStringToString(left) : left;
      const rh = isJSString(right) ? jsStringToString(right) : right;
      return lh == rh;
    }
    case "===":
      if (isJSString(rawLeft) && isJSString(rawRight)) return jsStringEquals(rawLeft, rawRight);
      if (isJSString(rawLeft) || isJSString(rawRight)) return false;
      return rawLeft === rawRight;
    case "!=": {
      if (isJSString(left) && isJSString(right)) return !jsStringEquals(left, right);
      if (isEqObjectTW(rawLeft) && isEqObjectTW(rawRight)) return rawLeft !== rawRight;
      const lh = isJSString(left) ? jsStringToString(left) : left;
      const rh = isJSString(right) ? jsStringToString(right) : right;
      return lh != rh;
    }
    case "!==":
      if (isJSString(rawLeft) && isJSString(rawRight)) return !jsStringEquals(rawLeft, rawRight);
      if (isJSString(rawLeft) || isJSString(rawRight)) return true;
      return rawLeft !== rawRight;
    case "in": {
      const key = isJSString(rawLeft) ? jsStringToString(rawLeft) : String(rawLeft);
      return key in (rawRight as Record<string, unknown>);
    }
    case "instanceof": {
      // ネイティブコンストラクタ (ReferenceError 等) はそのまま JS の instanceof に委譲
      if (typeof rawRight === "function") return rawLeft instanceof rawRight;
      if (!isJSFunction(rawRight)) throw new TypeError("Right-hand side of instanceof is not callable");
      // プロトタイプチェーンを辿って right.prototype を探す
      const proto = (rawRight as JSFunction).prototype;
      let current = (rawLeft as JSObject)?.[PROTO_KEY] as JSObject | null;
      while (current !== null && current !== undefined) {
        if (current === proto) return true;
        current = (current as JSObject)?.[PROTO_KEY] as JSObject | null;
      }
      return false;
    }
    default:
      throw new Error(`Unknown operator: ${expr.operator}`);
  }
}
