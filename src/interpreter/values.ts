import type { Identifier, BlockStatement } from "../parser/ast.js";
import { Environment } from "./environment.js";

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
  let current: JSObject | null = obj;
  while (current !== null && current !== undefined) {
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      return current[key];
    }
    current = (current[PROTO_KEY] as JSObject | null) ?? null;
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
    // Iterator Protocol で要素を取り出す
    const iterable = value as any;
    const iterFn = iterable != null && typeof iterable[Symbol.iterator] === "function"
      ? () => iterable[Symbol.iterator]()
      : iterable != null && typeof iterable?.["@@iterator"] === "function"
        ? () => iterable["@@iterator"]()
        : null;

    if (iterFn) {
      const iterator = iterFn();
      for (let i = 0; i < pattern.elements.length; i++) {
        const el = pattern.elements[i];
        if (!el) {
          // elision: iterator を進めるが値は捨てる
          iterator.next();
          continue;
        }
        if (el.type === "RestElement") {
          const rest: unknown[] = [];
          let r = iterator.next();
          while (r && !r.done) { rest.push(r.value); r = iterator.next(); }
          bindPattern(el.argument, rest, env, kind, defaultResolver);
          return;
        }
        const r = iterator.next();
        const val = r && !r.done ? r.value : undefined;
        bindPattern(el, val, env, kind, defaultResolver);
      }
    } else {
      // 配列風オブジェクト: 直接インデックスアクセス
      const arr = iterable as unknown[];
      for (let i = 0; i < pattern.elements.length; i++) {
        const el = pattern.elements[i];
        if (!el) continue;
        if (el.type === "RestElement") {
          bindPattern(el.argument, arr?.slice(i) ?? [], env, kind, defaultResolver);
          break;
        }
        bindPattern(el, arr?.[i], env, kind, defaultResolver);
      }
    }
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
