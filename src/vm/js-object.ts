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

// プロパティ属性 (writable/enumerable/configurable)。
// __attrs__ には「デフォルト (全て true) から外れたプロパティ」だけを記録する。
// 通常の代入/リテラル由来のプロパティは記録なし = 全て true 扱いなので、
// defineProperty/freeze を使わないオブジェクトのホットパスは
// 「__attrs__ が undefined」の 1 チェックで素通りする
export type PropAttrs = { writable: boolean; enumerable: boolean; configurable: boolean };

export type JSObjectInternal = Record<string, unknown> & {
  __hc__: HiddenClass;
  __slots__: unknown[];
  __attrs__?: Map<string, PropAttrs>;
  __ext__?: boolean; // false = non-extensible (preventExtensions/seal/freeze)
};

export function getPropAttrs(obj: JSObjectInternal, name: string): PropAttrs | undefined {
  return obj.__attrs__?.get(name);
}

export function setPropAttrs(obj: JSObjectInternal, name: string, attrs: PropAttrs): void {
  if (!obj.__attrs__) obj.__attrs__ = new Map();
  obj.__attrs__.set(name, attrs);
}

export function isObjExtensible(obj: JSObjectInternal): boolean {
  return obj.__ext__ !== false;
}

export function preventObjExtensions(obj: JSObjectInternal): void {
  obj.__ext__ = false;
}

// 代入 (obj[name] = v) のチェック + 実行を一体化 (spec 9.1.9 OrdinarySet の近似)。
// 成功時はこの関数内で書き込む (resolveStore→set の二重 lookup を避ける)。
// 戻り値:
//   STORE_OK             — 書き込み完了
//   STORE_READONLY 等    — 違反 (caller が strict TypeError を投げる)
//   AccessorDescriptor   — setter を呼ぶ必要がある (caller が this 付きで呼ぶ)
export const STORE_OK = 0;
export const STORE_READONLY = 1;
export const STORE_NO_SETTER = 2;
export const STORE_NOT_EXTENSIBLE = 3;
export type StoreResult = 0 | 1 | 2 | 3 | AccessorDescriptor;

export function setPropertyChecked(obj: JSObjectInternal, name: string, value: unknown): StoreResult {
  const offset = lookupOffset(obj.__hc__, name);
  if (offset >= 0) {
    const cur = obj.__slots__[offset];
    if (isAccessorDescriptor(cur)) {
      return cur.set !== undefined ? cur : STORE_NO_SETTER;
    }
    if (obj.__attrs__ !== undefined && obj.__attrs__.get(name)?.writable === false) {
      return STORE_READONLY;
    }
    obj.__slots__[offset] = value;
    obj[name] = value; // 互換ミラー (setProperty と同じ。normalize 等の host 読みが見る)
    return STORE_OK;
  }
  // own に無い (新規プロパティ作成): プロトタイプチェーンの accessor / readonly を尊重。
  // class の prototype は host object なので最初の proto で即 break するのが通常
  let proto = getProtoOf(obj);
  while (proto !== undefined && proto !== null && isJSObject(proto)) {
    const poff = lookupOffset(proto.__hc__, name);
    if (poff >= 0) {
      const cur = proto.__slots__[poff];
      if (isAccessorDescriptor(cur)) {
        return cur.set !== undefined ? cur : STORE_NO_SETTER;
      }
      if (proto.__attrs__ !== undefined && proto.__attrs__.get(name)?.writable === false) {
        return STORE_READONLY;
      }
      break; // 継承データプロパティ (writable) → own を作ってシャドウ
    }
    proto = getProtoOf(proto);
  }
  if (obj.__ext__ === false) return STORE_NOT_EXTENSIBLE;
  setProperty(obj, name, value); // HC 遷移して新規スロット
  return STORE_OK;
}

function getProtoOf(obj: JSObjectInternal): unknown {
  const off = lookupOffset(obj.__hc__, "__proto__");
  return off >= 0 ? obj.__slots__[off] : undefined;
}

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
