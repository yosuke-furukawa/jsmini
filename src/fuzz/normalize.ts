// エンジン横断で比較可能な canonical 表現へ正規化する。
//
// jsmini は同じ JS 値でもエンジンごとに内部表現が違う:
//   - 文字列: host string / JSString (rope)
//   - オブジェクト: native object (TW) / hidden-class JSObject (VM)
//   - 関数: closure (TW) / bytecode function (VM)
//   - throw: ThrowSignal ラッパ (TW user throw) / 生値 (VM) / 生 host error (参照エラー等)
// これらを同一の文字列に畳み込むことで、差分ファジングの「意味的に同じか」を判定する。

import { isJSString, jsStringToString } from "../vm/js-string.js";

const INTERNAL_KEYS = new Set(["__hc__", "__slots__", "__proto__", "@@iterator", "__attrs__", "__ext__"]);
const MAX_DEPTH = 8;

function isFunctionLike(v: any): boolean {
  if (typeof v === "function") return true;
  if (v === null || typeof v !== "object") return false;
  // VM の BytecodeFunction / TW の JSFunction
  if ("bytecode" in v && "constants" in v) return true;
  if ("body" in v && "params" in v && "closure" in v) return true;
  return false;
}

function isErrorLike(v: any): { name: string } | null {
  if (v instanceof Error) return { name: v.name };
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const name = v.name ?? v.constructor?.name;
  if (typeof name === "string" && /Error$/.test(name)) return { name };
  // jsmini の Error は name を持たない plain object ({ message } のみ) の場合がある。
  // message を持つオブジェクトは Error 相当として種別 "Error" に畳む。
  if ("message" in v) return { name: typeof v.name === "string" ? v.name : "Error" };
  return null;
}

function num(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  if (n === 0) return Object.is(n, -0) ? "-0" : "0";
  return String(n);
}

// 値 → canonical 文字列
export function canonValue(v: unknown, depth = 0, seen = new WeakSet<object>()): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";

  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") return num(v as number);
  if (t === "bigint") return `${v}n`;
  if (t === "symbol") return `Symbol(${(v as symbol).description ?? ""})`;
  if (t === "string") return JSON.stringify(v);

  if (isJSString(v)) return JSON.stringify(jsStringToString(v as any));
  if (isFunctionLike(v)) return "[Function]";

  if (depth >= MAX_DEPTH) return "[deep]";

  if (Array.isArray(v)) {
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    const parts: string[] = [];
    for (let i = 0; i < v.length; i++) parts.push(canonValue(v[i], depth + 1, seen));
    seen.delete(v);
    return `[${parts.join(",")}]`;
  }

  if (v instanceof Map) {
    const entries = [...v.entries()]
      .map(([k, val]) => `${canonValue(k, depth + 1, seen)}=>${canonValue(val, depth + 1, seen)}`)
      .sort();
    return `Map{${entries.join(",")}}`;
  }
  if (v instanceof Set) {
    const items = [...v.values()].map((x) => canonValue(x, depth + 1, seen)).sort();
    return `Set{${items.join(",")}}`;
  }

  if (t === "object") {
    const obj = v as Record<string, unknown>;
    if (seen.has(obj)) return "[circular]";
    seen.add(obj);
    const attrs = (obj as any).__attrs__ as Map<string, { enumerable: boolean }> | undefined;
    const keys = Object.keys(obj)
      .filter((k) => !INTERNAL_KEYS.has(k))
      // VM の属性モデル: enumerable:false は列挙に出さない (TW は host 属性で自然に消える)
      .filter((k) => attrs?.get(k)?.enumerable !== false)
      .sort();
    const parts = keys.map((k) => {
      // getter は node の console.log と同じく [Getter] マーカーで表現する
      // (TW は host descriptor、VM は AccessorDescriptor slot — 読み方が違うと
      //  「getter を呼んだ値 vs 生の descriptor」で偽発散になる)
      const hostDesc = Object.getOwnPropertyDescriptor(obj, k);
      if (hostDesc && (hostDesc.get || hostDesc.set)) return `${JSON.stringify(k)}:[Getter]`;
      const raw = obj[k];
      if (raw && typeof raw === "object" && (raw as any).__accessor__ === true) return `${JSON.stringify(k)}:[Getter]`;
      return `${JSON.stringify(k)}:${canonValue(raw, depth + 1, seen)}`;
    });
    seen.delete(obj);
    return `{${parts.join(",")}}`;
  }

  return String(v);
}

// throw された値 → canonical 文字列。
// エラー種別 (ReferenceError 等) が主要な比較キー。message はエンジン/host 依存なので使わない。
export function canonThrow(thrown: unknown): string {
  // throw の内部ラッパを剥がす:
  //   TW user throw → ThrowSignal(value)
  //   VM throw      → { __thrown: true, value }
  let val: any = thrown;
  if (val && typeof val === "object") {
    if (val.constructor && val.constructor.name === "ThrowSignal") val = val.value;
    else if (val.__thrown === true && "value" in val) val = val.value;
  }
  const err = isErrorLike(val);
  if (err) return `Error:${err.name}`;
  // エラー以外の値を throw した場合 (throw 5, throw "x" など)
  return `value:${canonValue(val)}`;
}

export type Outcome =
  | { kind: "value"; repr: string; logs: string[] }
  | { kind: "throw"; repr: string; logs: string[] };

// Outcome を 1 本の比較キーへ。完了値だけでなく console.log の副作用も含める。
export function outcomeKey(o: Outcome): string {
  const logs = o.logs.length ? ` LOGS[${o.logs.join("|")}]` : "";
  return `${o.kind === "value" ? "V" : "T"}:${o.repr}${logs}`;
}
