import type { Identifier, BlockStatement } from "../parser/ast.js";
import { Environment } from "./environment.js";
import { isJSString, jsStringToString, internString, type JSString } from "../vm/js-string.js";

// 制御フローシグナル
export class ReturnSignal {
  value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

export class ThrowSignal {
  value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

export class BreakSignal {
  label: string | null;
  constructor(label: string | null = null) { this.label = label; }
}
export class ContinueSignal {
  label: string | null;
  constructor(label: string | null = null) { this.label = label; }
}

// 関数オブジェクトの内部表現
export const JS_FUNCTION_BRAND = Symbol("JSFunction");
export const PROTO_KEY = "__proto__";

export type JSObject = Record<string, unknown>;

export type JSFunction = {
  [JS_FUNCTION_BRAND]: true;
  params: Identifier[];
  body: BlockStatement;
  closure: Environment;
  isArrow?: boolean;
  isClass?: boolean;
  prototype: JSObject;
  [key: string]: unknown;
};

export function isJSFunction(value: unknown): value is JSFunction {
  return typeof value === "object" && value !== null && JS_FUNCTION_BRAND in value;
}

export function createJSFunction(
  params: Identifier[],
  body: BlockStatement,
  closure: Environment,
  opts?: { isArrow?: boolean; isClass?: boolean },
): JSFunction {
  return {
    [JS_FUNCTION_BRAND]: true,
    params,
    body,
    closure,
    isArrow: opts?.isArrow,
    isClass: opts?.isClass,
    prototype: opts?.isArrow ? (undefined as any) : {},
  };
}

// プロトタイプチェーンを辿ってプロパティを取得
export function getProperty(obj: JSObject, key: string): unknown {
  // JSFunction の length は params から合成 (spec: デフォルト/rest より前の数)
  if (key === "length" && obj && typeof obj === "object" && (obj as any)[JS_FUNCTION_BRAND]) {
    let fnLen = 0;
    for (const prm of ((obj as any).params ?? []) as any[]) {
      if (prm.type === "AssignmentPattern" || prm.type === "RestElement") break;
      fnLen++;
    }
    return fnLen;
  }
  let current: JSObject | null = obj;
  while (current !== null && current !== undefined) {
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      // host getter (Set.prototype.size 等) は元の receiver で呼ぶ必要がある
      const desc = Object.getOwnPropertyDescriptor(current, key);
      if (desc && typeof desc.get === "function") return desc.get.call(obj);
      return current[key];
    }
    current = (current[PROTO_KEY] as JSObject | null) ?? null;
  }
  // PROTO_KEY チェーンに無ければ host のプロトタイプチェーンを見る。
  // TW のオブジェクト/JSFunction は素の JS オブジェクトなので、
  // `Object.defineProperty(Object.prototype, "inh", ...)` で定義した
  // プロパティ (deltablue の inheritsFrom パターン) はここで見える
  if (typeof obj === "object" && obj !== null && key in obj) {
    return (obj as any)[key];
  }
  return undefined;
}

// Pattern から束縛される変数名を全て収集する (BoundNames)
export function collectBoundNames(pattern: any): string[] {
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "RestElement") return collectBoundNames(pattern.argument);
  if (pattern.type === "AssignmentPattern") return collectBoundNames(pattern.left);
  if (pattern.type === "ObjectPattern") {
    const names: string[] = [];
    for (const prop of pattern.properties) {
      if (prop.type === "RestElement") names.push(...collectBoundNames(prop.argument));
      else names.push(...collectBoundNames(prop.value));
    }
    return names;
  }
  if (pattern.type === "ArrayPattern") {
    const names: string[] = [];
    for (const el of pattern.elements) {
      if (el) names.push(...collectBoundNames(el));
    }
    return names;
  }
  return [];
}

// jsmini 関数 (JSFunction) を同期的に呼ぶフック。values.ts は evaluator を
// import できない (循環) ので、evaluator がモジュール初期化時に登録する
// (promise.ts の setHandlerCaller と同じパターン)
let _jsFunctionCaller: ((fn: JSFunction, thisValue: unknown, args: unknown[]) => unknown) | null = null;
export function setJSFunctionCaller(caller: (fn: JSFunction, thisValue: unknown, args: unknown[]) => unknown): void {
  _jsFunctionCaller = caller;
}
function callCallable(fn: unknown, thisValue: unknown, args: unknown[], what: string): unknown {
  if (typeof fn === "function") return (fn as Function).apply(thisValue, args);
  if (isJSFunction(fn) && _jsFunctionCaller) return _jsFunctionCaller(fn, thisValue, args);
  throw new TypeError(`${what} is not a function`);
}
const isObjectLike = (v: unknown): boolean => (typeof v === "object" && v !== null) || typeof v === "function";

// 分割代入用のイテレータ (spec GetIterator / IteratorStep / IteratorClose の近似)。
// - 文字列はコードポイント単位、host 配列 (@@iterator の上書きなし) はインデックス
//   fast path
// - それ以外は @@iterator (host の Symbol.iterator / jsmini の "@@iterator" 文字列
//   キー) を呼ぶ。jsmini 側の JSFunction は _jsFunctionCaller 経由。getter の
//   throw、非 callable、next() の非オブジェクト結果は spec 通り伝播/TypeError
// - step() 内の throw は [[Done]]=true 扱い (spec: next の abrupt では close しない)
// - close(abrupt): 未完了なら return() を呼ぶ。abrupt (束縛中の throw) のときは
//   return の例外/結果は握りつぶし、正常完了時は結果が非オブジェクトなら TypeError
export type PatternIterator = {
  step: () => { done: boolean; value: unknown };
  close: (abrupt: boolean) => void;
};
export function getPatternIterator(value: unknown): PatternIterator {
  const fromArray = (arr: unknown[]): PatternIterator => {
    let i = 0;
    return {
      step: () => (i < arr.length ? { done: false, value: arr[i++] } : { done: true, value: undefined }),
      close: () => {},
    };
  };
  if (isJSString(value) || typeof value === "string") {
    const str = isJSString(value) ? jsStringToString(value) : value;
    return fromArray(Array.from(str).map(internString));
  }
  if (value === null || value === undefined) {
    throw new TypeError(`${destructureName(value)} is not iterable`);
  }
  const obj = value as Record<string, unknown>;
  // @@iterator の取得 (JSObject は host object なので getter があればここで走る)
  let method: unknown = obj["@@iterator"];
  if (method === undefined && Array.isArray(value)) return fromArray(value as unknown[]);
  if (method === undefined) method = (obj as any)[Symbol.iterator];
  if (method === undefined || method === null) {
    throw new TypeError(`${destructureName(value)} is not iterable`);
  }
  const iterator = callCallable(method, value, [], "[Symbol.iterator]");
  if (!isObjectLike(iterator)) throw new TypeError("Result of the Symbol.iterator method is not an object");
  const it = iterator as Record<string, unknown>;
  const nextMethod = it.next; // spec: IteratorRecord.[[NextMethod]] は一度だけ読む
  let done = false;
  return {
    step: () => {
      if (done) return { done: true, value: undefined };
      let r: unknown;
      try {
        r = callCallable(nextMethod, iterator, [], "iterator.next");
      } catch (e) { done = true; throw e; }
      if (!isObjectLike(r)) { done = true; throw new TypeError("Iterator result is not an object"); }
      const rec = r as Record<string, unknown>;
      const d = rec.done;
      const falsy = d === false || d === undefined || d === null || d === 0 || d === ""
        || (typeof d === "number" && Number.isNaN(d)) || (isJSString(d) && (d as JSString).length === 0);
      if (!falsy) { done = true; return { done: true, value: undefined }; }
      return { done: false, value: rec.value };
    },
    close: (abrupt: boolean) => {
      if (done) return;
      done = true;
      let ret: unknown;
      try {
        ret = it.return;
        if (ret === undefined || ret === null) return;
        const r = callCallable(ret, iterator, [], "iterator.return");
        if (!abrupt && !isObjectLike(r)) throw new TypeError("Iterator return result is not an object");
      } catch (e) {
        if (!abrupt) throw e; // 束縛中の throw が優先 (return の例外は握りつぶす)
      }
    },
  };
}

// 分割対象のエラーメッセージ用表示名
export function destructureName(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (isJSString(value)) return JSON.stringify(jsStringToString(value));
  if (typeof value === "object" || typeof value === "function") return "object";
  return String(value);
}

// パターンに対して値を分解して環境に定義する
export function bindPattern(
  pattern: any,
  value: unknown,
  env: Environment,
  kind: "var" | "let" | "const",
  defaultResolver?: (expr: any) => unknown,
): void {
  if (pattern.type === "Identifier") {
    if (kind === "const") {
      env.defineConst(pattern.name, value);
    } else if (kind === "let") {
      env.define(pattern.name, value);
    } else {
      const varEnv = env.findVarScope();
      varEnv.define(pattern.name, value);
    }
  } else if (pattern.type === "ObjectPattern") {
    // RequireObjectCoercible: null/undefined の分割は TypeError (空パターンでも)
    if (value === null || value === undefined) {
      throw new TypeError(`Cannot destructure '${destructureName(value)}' as it is ${value === null ? "null" : "undefined"}.`);
    }
    const obj = value as Record<string, unknown>;
    const boundKeys: string[] = [];
    for (const prop of pattern.properties) {
      if (prop.type === "RestElement") {
        const rest: Record<string, unknown> = {};
        if (obj) {
          for (const k of Object.keys(obj)) {
            if (!boundKeys.includes(k) && k !== "__proto__") rest[k] = obj[k];
          }
        }
        bindPattern(prop.argument, rest, env, kind, defaultResolver);
      } else {
        boundKeys.push(prop.key.name);
        const propValue = obj ? getProperty(obj as JSObject, prop.key.name) : undefined;
        bindPattern(prop.value, propValue, env, kind, defaultResolver);
      }
    }
  } else if (pattern.type === "ArrayPattern") {
    // Iterator Protocol で要素を取り出す (getPatternIterator: 文字列/配列の fast
    // path + ユーザー定義 @@iterator。束縛中の throw では IteratorClose(abrupt))
    const it = getPatternIterator(value);
    try {
      for (let i = 0; i < pattern.elements.length; i++) {
        const el = pattern.elements[i];
        if (!el) { it.step(); continue; } // elision: 進めるだけ
        if (el.type === "RestElement") {
          const rest: unknown[] = [];
          for (let r = it.step(); !r.done; r = it.step()) rest.push(r.value);
          bindPattern(el.argument, rest, env, kind, defaultResolver);
          break;
        }
        const r = it.step();
        bindPattern(el, r.done ? undefined : r.value, env, kind, defaultResolver);
      }
    } catch (e) {
      it.close(true);
      throw e;
    }
    it.close(false);
  } else if (pattern.type === "AssignmentPattern") {
    const val = (value === undefined && defaultResolver) ? defaultResolver(pattern.right) : value;
    bindPattern(pattern.left, val, env, kind, defaultResolver);
  }
}

// 代入式の分割代入: 既存変数に値を set する
export function assignPattern(pattern: any, value: unknown, env: Environment): void {
  if (pattern.type === "Identifier") {
    env.set(pattern.name, value);
  } else if (pattern.type === "ObjectPattern") {
    const obj = value as Record<string, unknown>;
    const boundKeys: string[] = [];
    for (const prop of pattern.properties) {
      if (prop.type === "RestElement") {
        const rest: Record<string, unknown> = {};
        if (obj) {
          for (const k of Object.keys(obj)) {
            if (!boundKeys.includes(k) && k !== "__proto__") rest[k] = obj[k];
          }
        }
        assignPattern(prop.argument, rest, env);
      } else {
        boundKeys.push(prop.key.name);
        const propValue = obj ? getProperty(obj as JSObject, prop.key.name) : undefined;
        assignPattern(prop.value, propValue, env);
      }
    }
  } else if (pattern.type === "ArrayPattern") {
    const arr = value as unknown[];
    for (let i = 0; i < pattern.elements.length; i++) {
      const el = pattern.elements[i];
      if (!el) continue;
      if (el.type === "RestElement") {
        assignPattern(el.argument, arr?.slice(i) ?? [], env);
        break;
      }
      assignPattern(el, arr?.[i], env);
    }
  }
}
