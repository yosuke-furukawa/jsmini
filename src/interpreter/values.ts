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

export class BreakSignal {}
export class ContinueSignal {}

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
  if (pattern.type === "ObjectPattern") {
    const names: string[] = [];
    for (const prop of pattern.properties) {
      names.push(...collectBoundNames(prop.value));
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
    for (const prop of pattern.properties) {
      const propValue = obj ? getProperty(obj as JSObject, prop.key.name) : undefined;
      bindPattern(prop.value, propValue, env, kind);
    }
  } else if (pattern.type === "ArrayPattern") {
    const arr = value as unknown[];
    for (let i = 0; i < pattern.elements.length; i++) {
      if (pattern.elements[i]) {
        bindPattern(pattern.elements[i], arr?.[i], env, kind);
      }
    }
  } else if (pattern.type === "AssignmentPattern") {
    // デフォルト引数: value が undefined のときデフォルト値をそのまま渡す
    // (evaluator 側で defaultResolver を通じて評価済みの値を渡す)
    bindPattern(pattern.left, value, env, kind);
  }
}

// 代入式の分割代入: 既存変数に値を set する
export function assignPattern(pattern: any, value: unknown, env: Environment): void {
  if (pattern.type === "Identifier") {
    env.set(pattern.name, value);
  } else if (pattern.type === "ObjectPattern") {
    const obj = value as Record<string, unknown>;
    for (const prop of pattern.properties) {
      const propValue = obj ? getProperty(obj as JSObject, prop.key.name) : undefined;
      assignPattern(prop.value, propValue, env);
    }
  } else if (pattern.type === "ArrayPattern") {
    const arr = value as unknown[];
    for (let i = 0; i < pattern.elements.length; i++) {
      if (pattern.elements[i]) {
        assignPattern(pattern.elements[i], arr?.[i], env);
      }
    }
  }
}
