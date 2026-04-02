// jsmini 独自の Symbol 実装
// V8 の Symbol に依存せず、wrapper オブジェクトで表現する
// === で参照比較されるので、同じ description でも別の Symbol は区別される

let symbolCounter = 0;

export type JSSymbol = {
  __symbol__: true;
  id: number;
  description: string;
  // プロパティキーとして使う文字列
  key: string;
};

export function createSymbol(description: string): JSSymbol {
  const id = symbolCounter++;
  return { __symbol__: true, id, description, key: `@@symbol_${id}_${description}` };
}

export function isJSSymbol(val: unknown): val is JSSymbol {
  return typeof val === "object" && val !== null && (val as any).__symbol__ === true;
}

// Well-known symbols (固定ID)
export const SYMBOL_ITERATOR: JSSymbol = { __symbol__: true, id: -1, description: "Symbol.iterator", key: "@@iterator" };
export const SYMBOL_TO_PRIMITIVE: JSSymbol = { __symbol__: true, id: -2, description: "Symbol.toPrimitive", key: "@@toPrimitive" };
export const SYMBOL_HAS_INSTANCE: JSSymbol = { __symbol__: true, id: -3, description: "Symbol.hasInstance", key: "@@hasInstance" };
export const SYMBOL_TO_STRING_TAG: JSSymbol = { __symbol__: true, id: -4, description: "Symbol.toStringTag", key: "@@toStringTag" };
