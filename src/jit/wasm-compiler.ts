import type { BytecodeFunction } from "../vm/bytecode.js";
import { WasmBuilder, WASM_OP, WASM_TYPE, f64ToBytes } from "./wasm-builder.js";

// BytecodeFunction → Wasm バイナリに変換
// number (f64) 専用の算術関数のみ対応
export async function compileToWasm(
  func: BytecodeFunction,
): Promise<((...args: number[]) => number) | null> {
  // 全パラメータが f64 前提
  const params = new Array(func.paramCount).fill(WASM_TYPE.f64);
  const results = [WASM_TYPE.f64];

  const body = translateBytecode(func);
  if (!body) return null; // 変換不可能な命令があった

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

// jsmini バイトコード → Wasm 命令列に変換
function translateBytecode(func: BytecodeFunction): number[] | null {
  const out: number[] = [];
  const { bytecode, constants } = func;

  // ローカル変数宣言 (パラメータ以外のローカルが必要な場合)
  // 簡易: パラメータのみ使用する関数を対象とするので、追加ローカルは 0

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
        if (typeof val !== "number") return null; // number 以外は変換不可
        out.push(0x44, ...f64ToBytes(val));
        break;
      }
      case "Add": out.push(WASM_OP.f64_add); break;
      case "Sub": out.push(WASM_OP.f64_sub); break;
      case "Mul": out.push(WASM_OP.f64_mul); break;
      case "Div": out.push(WASM_OP.f64_div); break;
      case "Negate": out.push(WASM_OP.f64_neg); break;
      case "LessThan": out.push(WASM_OP.f64_lt); break;
      case "GreaterThan": out.push(WASM_OP.f64_gt); break;
      case "LessEqual": out.push(WASM_OP.f64_le); break;
      case "GreaterEqual": out.push(WASM_OP.f64_ge); break;
      case "Return":
        out.push(WASM_OP.return);
        break;
      case "LdaUndefined":
        // undefined → f64 の 0 (JIT 対象は number 専用なので)
        out.push(0x44, ...f64ToBytes(0));
        break;
      case "Pop":
        out.push(WASM_OP.drop);
        break;
      default:
        // 変換不可能な命令 → JIT 対象外
        return null;
    }
  }

  out.push(WASM_OP.end);
  return out;
}
