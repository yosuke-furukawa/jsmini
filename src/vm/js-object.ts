// Hidden Class 付きオブジェクト
// VM 内部で obj[name] の代わりに slots[offset] でアクセスする

import { type HiddenClass, getRootHC, transition, lookupOffset } from "./hidden-class.js";

// Symbol ではなく通常プロパティを使う (V8-JITless で Symbol アクセスが遅いため)
const HC_KEY = "__hc__";
const SLOTS_KEY = "__slots__";

// getter/setter アクセサディスクリプタ
export type AccessorDescriptor = {
  __accessor__: true;
  get?: unknown; // BytecodeFunction or closure
  set?: unknown;
};

export function isAccessorDescriptor(val: unknown): val is AccessorDescriptor {
  return typeof val === "object" && val !== null && (val as any).__accessor__ === true;
}

export function createAccessorDescriptor(): AccessorDescriptor {
  return { __accessor__: true };
}

export type JSObjectInternal = Record<string, unknown> & {
  __hc__: HiddenClass;
  __slots__: unknown[];
};

// Hidden Class 付きの空オブジェクトを作成
export function createJSObject(): JSObjectInternal {
  const obj = Object.create(null) as JSObjectInternal;
  obj.__hc__ = getRootHC();
  obj.__slots__ = [];
  return obj;
}

// オブジェクトが Hidden Class 付きか判定
export function isJSObject(obj: unknown): obj is JSObjectInternal {
  return typeof obj === "object" && obj !== null && (obj as any).__hc__ !== undefined;
}

// Hidden Class を取得
export function getHiddenClass(obj: JSObjectInternal): HiddenClass {
  return obj.__hc__;
}

// slots 配列を取得 (IC 用)
export function getSlots(obj: JSObjectInternal): unknown[] {
  return obj.__slots__;
}

// プロパティを読む (HC のオフセットで slots からアクセス + prototype チェーン)
export function getProperty(obj: JSObjectInternal, name: string): unknown {
  const offset = lookupOffset(obj.__hc__, name);
  if (offset >= 0) return obj.__slots__[offset];
  // prototype チェーンを辿る
  const protoOffset = lookupOffset(obj.__hc__, "__proto__");
  const proto = protoOffset >= 0 ? obj.__slots__[protoOffset] : undefined;
  if (proto && typeof proto === "object") {
    if (isJSObject(proto)) return getProperty(proto, name);
    return (proto as Record<string, unknown>)[name];
  }
  return undefined;
}

// プロパティを書く (HC を遷移させつつ slots に格納)
export function setProperty(obj: JSObjectInternal, name: string, value: unknown): void {
  const hc = obj.__hc__;
  const offset = lookupOffset(hc, name);

  if (offset >= 0) {
    obj.__slots__[offset] = value;
  } else {
    const newHC = transition(hc, name);
    obj.__hc__ = newHC;
    const newOffset = lookupOffset(newHC, name);
    obj.__slots__[newOffset] = value;
  }

  // 互換性: 通常のプロパティとしても設定
  obj[name] = value;
}
