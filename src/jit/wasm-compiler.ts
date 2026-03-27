import type { BytecodeFunction } from "../vm/bytecode.js";
import { WasmBuilder, WASM_OP, WASM_TYPE, f64ToBytes, i32ToLEB128 } from "./wasm-builder.js";
import type { WasmNumericType } from "./feedback.js";

type SpecializationType = "i32" | "f64";

// BytecodeFunction → Wasm バイナリに変換
// 非同期版
export async function compileToWasm(
  func: BytecodeFunction,
  spec?: SpecializationType,
): Promise<((...args: number[]) => number) | null> {
  const t = spec ?? "f64";
  const wasmType = t === "i32" ? WASM_TYPE.i32 : WASM_TYPE.f64;
  const params = new Array(func.paramCount).fill(wasmType);
  const results = [wasmType];

  const body = translateBytecode(func, t);
  if (!body) return null;

  const builder = new WasmBuilder();
  builder.addFunction(func.name, params, results, body);

  try {
    const bytes = builder.build();
    const { instance } = await WebAssembly.instantiate(bytes);
    return instance.exports[func.name] as (...args: number[]) => number;
  } catch {
    return null;
  }
}

// 同期版
export function compileToWasmSync(
  func: BytecodeFunction,
  spec?: SpecializationType,
): ((...args: number[]) => number) | null {
  const t = spec ?? "f64";
  const wasmType = t === "i32" ? WASM_TYPE.i32 : WASM_TYPE.f64;
  const params = new Array(func.paramCount).fill(wasmType);
  const results = [wasmType];

  const body = translateBytecode(func, t);
  if (!body) return null;

  const builder = new WasmBuilder();
  builder.addFunction(func.name, params, results, body);

  try {
    const bytes = builder.build();
    const mod = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(mod);
    return instance.exports[func.name] as (...args: number[]) => number;
  } catch {
    return null;
  }
}

// jsmini バイトコード → Wasm 命令列に変換
function translateBytecode(func: BytecodeFunction, spec: SpecializationType): number[] | null {
  const out: number[] = [];
  const { bytecode, constants } = func;
  const isI32 = spec === "i32";

  for (let pc = 0; pc < bytecode.length; pc++) {
    const instr = bytecode[pc];
    switch (instr.op) {
      case "LdaLocal":
        out.push(WASM_OP.local_get, instr.operand!);
        break;
      case "StaLocal":
        out.push(WASM_OP.local_set, instr.operand!);
        break;
      case "LdaConst": {
        const val = constants[instr.operand!];
        if (typeof val !== "number") return null;
        if (isI32) {
          out.push(WASM_OP.i32_const, ...i32ToLEB128(val | 0));
        } else {
          out.push(WASM_OP.f64_const, ...f64ToBytes(val));
        }
        break;
      }
      case "Add": out.push(isI32 ? WASM_OP.i32_add : WASM_OP.f64_add); break;
      case "Sub": out.push(isI32 ? WASM_OP.i32_sub : WASM_OP.f64_sub); break;
      case "Mul": out.push(isI32 ? WASM_OP.i32_mul : WASM_OP.f64_mul); break;
      case "Div": out.push(isI32 ? WASM_OP.i32_div_s : WASM_OP.f64_div); break;
      case "Mod":
        if (isI32) { out.push(WASM_OP.i32_rem_s); }
        else return null; // f64 の % は Wasm にはない
        break;
      case "Negate":
        if (isI32) {
          // i32 の neg: 0 - x
          out.push(WASM_OP.i32_const, 0x00); // i32.const 0
          // swap して sub... Wasm はスタックマシンなので先に 0 を push してから引く
          // → 一旦 local に退避が必要。簡易: 非対応
          return null;
        }
        out.push(WASM_OP.f64_neg);
        break;
      case "LessThan": out.push(isI32 ? WASM_OP.i32_lt_s : WASM_OP.f64_lt); break;
      case "GreaterThan": out.push(isI32 ? WASM_OP.i32_gt_s : WASM_OP.f64_gt); break;
      case "LessEqual": out.push(isI32 ? WASM_OP.i32_le_s : WASM_OP.f64_le); break;
      case "GreaterEqual": out.push(isI32 ? WASM_OP.i32_ge_s : WASM_OP.f64_ge); break;
      case "Return":
        out.push(WASM_OP.return);
        break;
      case "LdaUndefined":
        if (isI32) {
          out.push(WASM_OP.i32_const, 0x00);
        } else {
          out.push(WASM_OP.f64_const, ...f64ToBytes(0));
        }
        break;
      case "Pop":
        out.push(WASM_OP.drop);
        break;
      default:
        return null;
    }
  }

  out.push(WASM_OP.end);
  return out;
}
