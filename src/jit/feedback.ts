import type { BytecodeFunction } from "../vm/bytecode.js";
import { getElementKind, isTrackedArray } from "../vm/js-array.js";
import { isJSString, getInternId } from "../vm/js-string.js";

// 詳細な型分類
// number をさらに int32 / uint32 / f64 に細分化
// 配列を Element Kind で分類
export type DetailedType =
  | "int32"        // 整数、-2^31 <= x < 2^31
  | "uint32"       // 非負整数、0 <= x < 2^32
  | "f64"          // 小数 or 範囲外の整数
  | "interned_string" // intern 済み文字列 (intern id で i32 比較可能)
  | "smi_array"    // 整数のみの配列 (Element Kind = SMI)
  | "double_array" // 数値のみの配列 (Element Kind = DOUBLE)
  | "array"        // 汎用配列 (Element Kind = GENERIC or 未追跡)
  | "string"
  | "boolean"
  | "undefined"
  | "null"
  | "object"
  | "function";

// Wasm の型に変換する際に使う
export type WasmNumericType = "i32" | "f64";

export type TypeFeedback = {
  callCount: number;
  argTypes: DetailedType[][];  // 呼び出しごとの引数型 (最新 N 件)
  returnTypes: DetailedType[]; // 戻り値の型 (最新 N 件)
  isMonomorphic: boolean;      // 常に同じ型パターンか
};

const MAX_SAMPLES = 10;

export class FeedbackCollector {
  private feedbacks: Map<BytecodeFunction, TypeFeedback> = new Map();

  recordCall(func: BytecodeFunction, args: unknown[]): void {
    let fb = this.feedbacks.get(func);
    if (!fb) {
      fb = { callCount: 0, argTypes: [], returnTypes: [], isMonomorphic: true };
      this.feedbacks.set(func, fb);
    }
    fb.callCount++;

    const types = args.map(classifyType);
    if (fb.argTypes.length < MAX_SAMPLES) {
      fb.argTypes.push(types);
    }

    if (fb.isMonomorphic && fb.argTypes.length > 0) {
      const first = fb.argTypes[0].join(",");
      if (types.join(",") !== first) {
        fb.isMonomorphic = false;
      }
    }
  }

  recordReturn(func: BytecodeFunction, value: unknown): void {
    const fb = this.feedbacks.get(func);
    if (!fb) return;

    const t = classifyType(value);
    if (fb.returnTypes.length < MAX_SAMPLES) {
      fb.returnTypes.push(t);
    }
  }

  get(func: BytecodeFunction): TypeFeedback | undefined {
    return this.feedbacks.get(func);
  }

  // 引数の推奨 Wasm 型を返す (monomorphic な場合のみ)
  getWasmArgTypes(func: BytecodeFunction): WasmNumericType[] | null {
    const fb = this.feedbacks.get(func);
    if (!fb || !fb.isMonomorphic || fb.argTypes.length === 0) return null;
    return fb.argTypes[0].map(toWasmType).filter((t): t is WasmNumericType => t !== null);
  }

  // 戻り値の推奨 Wasm 型を返す
  getWasmReturnType(func: BytecodeFunction): WasmNumericType | null {
    const fb = this.feedbacks.get(func);
    if (!fb || fb.returnTypes.length === 0) return null;
    const unique = [...new Set(fb.returnTypes)];
    if (unique.length !== 1) return null;
    return toWasmType(unique[0]);
  }

  dump(): string {
    const lines: string[] = [];
    for (const [func, fb] of this.feedbacks) {
      lines.push(`Feedback for ${func.name}:`);
      lines.push(`  callCount: ${fb.callCount}`);
      if (fb.argTypes.length > 0) {
        const representative = fb.argTypes[0].join(", ");
        const status = fb.isMonomorphic ? "monomorphic" : "polymorphic";
        lines.push(`  argTypes: [${representative}] (${status})`);
        const wasmTypes = this.getWasmArgTypes(func);
        if (wasmTypes) {
          lines.push(`  wasmArgTypes: [${wasmTypes.join(", ")}]`);
        }
      }
      if (fb.returnTypes.length > 0) {
        const unique = [...new Set(fb.returnTypes)];
        lines.push(`  returnType: ${unique.join(" | ")}`);
        const wasmRet = this.getWasmReturnType(func);
        if (wasmRet) {
          lines.push(`  wasmReturnType: ${wasmRet}`);
        }
      }
    }
    return lines.join("\n");
  }
}

// 値から詳細型を分類
export function classifyType(val: unknown): DetailedType {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  if (typeof val === "boolean") return "boolean";
  if (isJSString(val)) {
    return getInternId(val) >= 0 ? "interned_string" : "string";
  }
  if (typeof val === "string") return "string";
  if (typeof val === "function") return "function";
  if (typeof val === "number") {
    if (Number.isInteger(val)) {
      if (val >= 0 && val < 2 ** 32) return "uint32";
      if (val >= -(2 ** 31) && val < 2 ** 31) return "int32";
    }
    return "f64";
  }
  if (Array.isArray(val)) {
    if (isTrackedArray(val)) {
      const kind = getElementKind(val);
      if (kind === "SMI") return "smi_array";
      if (kind === "DOUBLE") return "double_array";
    }
    return "array";
  }
  return "object";
}

// DetailedType → Wasm 型に変換
export function toWasmType(t: DetailedType): WasmNumericType | null {
  switch (t) {
    case "int32":
    case "uint32":
    case "smi_array":       // 配列は i32 (Wasm memory base address)
    case "interned_string":  // 文字列は i32 (intern id)
      return "i32";
    case "f64":
    case "double_array":
      return "f64";
    default:
      return null; // 数値以外は Wasm 化不可
  }
}

// 配列型かどうか
export function isArrayType(t: DetailedType): boolean {
  return t === "smi_array" || t === "double_array" || t === "array";
}
