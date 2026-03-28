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
  const wasmType = isI32 ? WASM_TYPE.i32 : WASM_TYPE.f64;

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
        else return null;
        break;
      case "Negate":
        if (isI32) return null;
        out.push(WASM_OP.f64_neg);
        break;
      case "LessThan": out.push(isI32 ? WASM_OP.i32_lt_s : WASM_OP.f64_lt); break;
      case "GreaterThan": out.push(isI32 ? WASM_OP.i32_gt_s : WASM_OP.f64_gt); break;
      case "LessEqual": out.push(isI32 ? WASM_OP.i32_le_s : WASM_OP.f64_le); break;
      case "GreaterEqual": out.push(isI32 ? WASM_OP.i32_ge_s : WASM_OP.f64_ge); break;
      case "Equal":
      case "StrictEqual":
        if (isI32) { out.push(0x46); } // i32.eq
        else return null;
        break;
      case "NotEqual":
      case "StrictNotEqual":
        if (isI32) { out.push(0x47); } // i32.ne
        else return null;
        break;

      // 条件分岐: JumpIfFalse → Wasm if/end
      case "JumpIfFalse": {
        const target = instr.operand!;
        // JumpIfFalse は条件が false なら target にジャンプ
        // → Wasm: if (条件が true) { ... } end で、true パスのコードを if 内に入れる
        // target の直前が Return なら if (result type) ... return ... end パターン
        const trueBlock = bytecode.slice(pc + 1, target);
        const hasReturn = trueBlock.some(i => i.op === "Return");
        if (!hasReturn) return null; // return なしの分岐は未対応

        // if (result wasmType) — 関数全体の戻り値型を result に
        // ただし true ブロックが return で終わるなら result なしでもOK
        out.push(WASM_OP.if, 0x40); // 0x40 = void block type

        // true ブロックの中身を再帰的に変換
        for (let j = pc + 1; j < target; j++) {
          const inner = bytecode[j];
          const innerResult = translateSingleInstruction(inner, func, spec, isI32, wasmType, out);
          if (!innerResult) return null;
        }

        out.push(WASM_OP.end); // if の end
        pc = target - 1; // for ループの pc++ で target に進む
        break;
      }

      // 自己再帰呼び出し: LdaGlobal(func名) + Call → call 0
      case "LdaGlobal": {
        const name = constants[instr.operand!];
        // 次の命令が Call で、ロードしたのが自分自身の関数名なら
        // LdaGlobal をスキップ (Call で call 0 にする)
        if (typeof name === "string" && name === func.name && pc + 1 < bytecode.length && bytecode[pc + 1].op === "Call") {
          // skip — Call 側で処理
          break;
        }
        return null; // 一般的なグローバル参照は未対応
      }

      case "Call": {
        const argc = instr.operand!;
        // 直前が LdaGlobal(自分自身) なら自己再帰
        if (pc > 0 && bytecode[pc - 1].op === "LdaGlobal") {
          const prevName = constants[bytecode[pc - 1].operand!];
          if (prevName === func.name) {
            // call 0 — 関数インデックス 0 (自分自身)
            out.push(WASM_OP.call, 0x00);
            break;
          }
        }
        return null; // 一般的な関数呼び出しは未対応
      }

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

// 単一命令を変換 (JumpIfFalse の true ブロック内で使用)
function translateSingleInstruction(
  instr: { op: string; operand?: number },
  func: BytecodeFunction,
  spec: SpecializationType,
  isI32: boolean,
  wasmType: number,
  out: number[],
): boolean {
  const { constants } = func;
  switch (instr.op) {
    case "LdaLocal": out.push(WASM_OP.local_get, instr.operand!); return true;
    case "StaLocal": out.push(WASM_OP.local_set, instr.operand!); return true;
    case "LdaConst": {
      const val = constants[instr.operand!];
      if (typeof val !== "number") return false;
      if (isI32) { out.push(WASM_OP.i32_const, ...i32ToLEB128(val | 0)); }
      else { out.push(WASM_OP.f64_const, ...f64ToBytes(val)); }
      return true;
    }
    case "Add": out.push(isI32 ? WASM_OP.i32_add : WASM_OP.f64_add); return true;
    case "Sub": out.push(isI32 ? WASM_OP.i32_sub : WASM_OP.f64_sub); return true;
    case "Mul": out.push(isI32 ? WASM_OP.i32_mul : WASM_OP.f64_mul); return true;
    case "Div": out.push(isI32 ? WASM_OP.i32_div_s : WASM_OP.f64_div); return true;
    case "Return": out.push(WASM_OP.return); return true;
    case "LdaUndefined":
      if (isI32) { out.push(WASM_OP.i32_const, 0x00); }
      else { out.push(WASM_OP.f64_const, ...f64ToBytes(0)); }
      return true;
    case "Pop": out.push(WASM_OP.drop); return true;
    case "LessThan": out.push(isI32 ? WASM_OP.i32_lt_s : WASM_OP.f64_lt); return true;
    case "GreaterThan": out.push(isI32 ? WASM_OP.i32_gt_s : WASM_OP.f64_gt); return true;
    case "LessEqual": out.push(isI32 ? WASM_OP.i32_le_s : WASM_OP.f64_le); return true;
    case "GreaterEqual": out.push(isI32 ? WASM_OP.i32_ge_s : WASM_OP.f64_ge); return true;
    case "Equal":
    case "StrictEqual":
      if (isI32) { out.push(0x46); return true; }
      return false;
    default: return false;
  }
}
