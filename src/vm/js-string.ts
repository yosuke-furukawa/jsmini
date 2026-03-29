// 独自文字列表現
// V8 の SeqString / ConsString / SlicedString に対応する最小実装

// --- 型定義 ---

export type SeqString = {
  kind: "seq";
  data: Uint8Array;  // UTF-8 エンコード
  length: number;    // 文字数 (= byte 数、ASCII 前提)
};

export type ConsString = {
  kind: "cons";
  left: JSString;
  right: JSString;
  length: number;
};

export type SlicedString = {
  kind: "sliced";
  parent: JSString;
  offset: number;
  length: number;
};

export type JSString = SeqString | ConsString | SlicedString;

// V8 と同じ: 13 文字未満の連結はコピー (ConsString のオーバーヘッドのほうが大きい)
const CONS_MIN_LENGTH = 13;

// --- ブランド ---
const JS_STRING_BRAND = Symbol("JSString");

type BrandedJSString = JSString & { [JS_STRING_BRAND]: true };

// --- 生成 ---

// JS string → SeqString
export function createSeqString(str: string): JSString {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const s: BrandedJSString = {
    kind: "seq",
    data,
    length: data.length,
    [JS_STRING_BRAND]: true,
  };
  return s;
}

// 空文字列
const EMPTY_STRING = createSeqString("");

export function emptyJSString(): JSString {
  return EMPTY_STRING;
}

// --- 判定 ---

export function isJSString(value: unknown): value is JSString {
  return typeof value === "object" && value !== null && JS_STRING_BRAND in (value as any);
}

// --- 連結 ---

export function jsStringConcat(a: JSString, b: JSString): JSString {
  if (a.length === 0) return b;
  if (b.length === 0) return a;

  const totalLength = a.length + b.length;

  // 短い場合はフラットにコピー (V8 と同じ閾値)
  if (totalLength < CONS_MIN_LENGTH) {
    const flat = flatten(a);
    const flatB = flatten(b);
    const data = new Uint8Array(totalLength);
    data.set((flat as SeqString).data, 0);
    data.set((flatB as SeqString).data, flat.length);
    const s: BrandedJSString = { kind: "seq", data, length: totalLength, [JS_STRING_BRAND]: true };
    return s;
  }

  // 長い場合は ConsString (コピーなし、O(1))
  const s: BrandedJSString = { kind: "cons", left: a, right: b, length: totalLength, [JS_STRING_BRAND]: true };
  return s;
}

// --- Slice ---

export function jsStringSlice(str: JSString, start: number, end?: number): JSString {
  const actualEnd = end ?? str.length;
  const length = actualEnd - start;
  if (length <= 0) return EMPTY_STRING;
  if (start === 0 && actualEnd === str.length) return str;

  // 短い場合はフラットにコピー
  if (length < CONS_MIN_LENGTH) {
    const flat = flatten(str);
    const data = (flat as SeqString).data.slice(start, actualEnd);
    const s: BrandedJSString = { kind: "seq", data, length, [JS_STRING_BRAND]: true };
    return s;
  }

  const s: BrandedJSString = { kind: "sliced", parent: str, offset: start, length, [JS_STRING_BRAND]: true };
  return s;
}

// --- Flatten (ConsString/SlicedString → SeqString) ---

export function flatten(str: JSString): SeqString {
  if (str.kind === "seq") return str;

  const buf = new Uint8Array(str.length);
  flattenInto(str, buf, 0);
  const flat: SeqString & { [JS_STRING_BRAND]: true } = {
    kind: "seq",
    data: buf,
    length: str.length,
    [JS_STRING_BRAND]: true,
  };

  // ConsString/SlicedString を SeqString に置き換え (キャッシュ)
  // 次回の flatten でコピーを省略できる
  // 元の子参照を切って GC 可能にする (Phase 10 の自前 GC でも有効)
  (str as any).kind = "seq";
  (str as any).data = buf;
  (str as any).left = null;
  (str as any).right = null;
  (str as any).parent = null;

  return flat;
}

function flattenInto(str: JSString, buf: Uint8Array, offset: number): void {
  switch (str.kind) {
    case "seq":
      buf.set(str.data, offset);
      break;
    case "cons":
      flattenInto(str.left, buf, offset);
      flattenInto(str.right, buf, offset + str.left.length);
      break;
    case "sliced": {
      const flat = flatten(str.parent);
      buf.set((flat as SeqString).data.subarray(str.offset, str.offset + str.length), offset);
      break;
    }
  }
}

// --- JS string に変換 ---

export function jsStringToString(str: JSString): string {
  const flat = flatten(str);
  const decoder = new TextDecoder();
  return decoder.decode(flat.data);
}

// --- 比較 ---

export function jsStringEquals(a: JSString, b: JSString): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const flatA = flatten(a);
  const flatB = flatten(b);
  for (let i = 0; i < flatA.length; i++) {
    if (flatA.data[i] !== flatB.data[i]) return false;
  }
  return true;
}

// --- charAt ---

export function jsStringCharAt(str: JSString, index: number): JSString {
  if (index < 0 || index >= str.length) return EMPTY_STRING;
  const flat = flatten(str);
  const data = new Uint8Array([flat.data[index]]);
  const s: BrandedJSString = { kind: "seq", data, length: 1, [JS_STRING_BRAND]: true };
  return s;
}

// --- 型変換 ---

export function numberToJSString(n: number): JSString {
  return createSeqString(String(n));
}

export function booleanToJSString(b: boolean): JSString {
  return createSeqString(b ? "true" : "false");
}

export function jsStringToNumber(str: JSString): number {
  return Number(jsStringToString(str));
}

// --- typeof ---

export function jsStringTypeOf(): JSString {
  return createSeqString("string");
}

// --- Intern 化 ---
// 同じ内容の文字列を 1 つのオブジェクトに統一する
// === が参照比較 (O(1)) になる

const internTable = new Map<string, JSString>();

export function internJSString(str: JSString): JSString {
  const key = jsStringToString(str);
  const existing = internTable.get(key);
  if (existing) return existing;
  internTable.set(key, str);
  return str;
}

// JS string から直接 intern 済み JSString を取得
export function internString(str: string): JSString {
  const existing = internTable.get(str);
  if (existing) return existing;
  const jsStr = createSeqString(str);
  internTable.set(str, jsStr);
  return jsStr;
}
