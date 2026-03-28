// Hidden Class 付きオブジェクト
// VM 内部で obj[name] の代わりに slots[offset] でアクセスする

import { type HiddenClass, getRootHC, transition, lookupOffset } from "./hidden-class.js";

const HIDDEN_CLASS = Symbol("hiddenClass");
const SLOTS = Symbol("slots");

export type JSObjectInternal = Record<string, unknown> & {
  [HIDDEN_CLASS]: HiddenClass;
  [SLOTS]: unknown[];
};

// Hidden Class 付きの空オブジェクトを作成
export function createJSObject(): JSObjectInternal {
  const obj = Object.create(null) as JSObjectInternal;
  obj[HIDDEN_CLASS] = getRootHC();
  obj[SLOTS] = [];
  return obj;
}

// オブジェクトが Hidden Class 付きか判定
export function isJSObject(obj: unknown): obj is JSObjectInternal {
  return typeof obj === "object" && obj !== null && HIDDEN_CLASS in (obj as any);
}

// Hidden Class を取得
export function getHiddenClass(obj: JSObjectInternal): HiddenClass {
  return obj[HIDDEN_CLASS];
}

// プロパティを読む (HC のオフセットで slots からアクセス + prototype チェーン)
export function getProperty(obj: JSObjectInternal, name: string): unknown {
  const offset = lookupOffset(obj[HIDDEN_CLASS], name);
  if (offset >= 0) return obj[SLOTS][offset];
  // prototype チェーンを辿る
  const proto = obj[SLOTS][lookupOffset(obj[HIDDEN_CLASS], "__proto__")];
  if (proto && typeof proto === "object") {
    if (isJSObject(proto)) return getProperty(proto, name);
    return (proto as Record<string, unknown>)[name];
  }
  return undefined;
}

// プロパティを書く (HC を遷移させつつ slots に格納)
export function setProperty(obj: JSObjectInternal, name: string, value: unknown): void {
  const hc = obj[HIDDEN_CLASS];
  const offset = lookupOffset(hc, name);

  if (offset >= 0) {
    // 既存プロパティの更新 — HC は変わらない
    obj[SLOTS][offset] = value;
  } else {
    // 新しいプロパティの追加 — HC を遷移
    const newHC = transition(hc, name);
    obj[HIDDEN_CLASS] = newHC;
    const newOffset = lookupOffset(newHC, name);
    obj[SLOTS][newOffset] = value;
  }

  // 互換性: 通常のプロパティとしても設定 (obj[name] でアクセスする外部コード用)
  obj[name] = value;
}
