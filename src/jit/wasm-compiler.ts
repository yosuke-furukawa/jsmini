import type { BytecodeFunction } from "../vm/bytecode.js";
import { WasmBuilder, WASM_OP, WASM_TYPE, f64ToBytes, i32ToLEB128 } from "./wasm-builder.js";
// WasmNumericType は JitManager から使われる

type SpecializationType = "i32" | "f64";

// 単一関数をコンパイル (後方互換)
export async function compileToWasm(
  func: BytecodeFunction,
  spec?: SpecializationType,
): Promise<((...args: number[]) => number) | null> {
  const result = compileToWasmSync(func, spec);
  return result;
}

// 単一関数をコンパイル (同期版)
export function compileToWasmSync(
  func: BytecodeFunction,
  spec?: SpecializationType,
): ((...args: number[]) => number) | null {
  const result = compileMultiSync([func], spec);
  if (!result) return null;
  return result.get(func.name) ?? null;
}

// 複数関数を 1 つの Wasm モジュールにコンパイル
export function compileMultiSync(
  funcs: BytecodeFunction[],
  spec?: SpecializationType,
): Map<string, (...args: number[]) => number> | null {
  const t = spec ?? "f64";
  const wasmType = t === "i32" ? WASM_TYPE.i32 : WASM_TYPE.f64;

  // 関数名 → インデックスのマッピング
  const funcIndex = new Map<string, number>();
  for (let i = 0; i < funcs.length; i++) {
    funcIndex.set(funcs[i].name, i);
  }

  const builder = new WasmBuilder();
  const ctx: TranslateContext = { spec: t, isI32: t === "i32", wasmType, funcIndex };

  for (const func of funcs) {
    const params = new Array(func.paramCount).fill(wasmType);
    const results = [wasmType];
    // ローカル変数 (params 以外) の宣言
    const extraLocals = func.localCount - func.paramCount;
    const body = translateBytecode(func, ctx);
    if (!body) return null;
    builder.addFunction(func.name, params, results, body, extraLocals > 0 ? extraLocals : 0);
  }

  try {
    const bytes = builder.build();
    const mod = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(mod);
    const result = new Map<string, (...args: number[]) => number>();
    for (const func of funcs) {
      result.set(func.name, instance.exports[func.name] as (...args: number[]) => number);
    }
    return result;
  } catch {
    return null;
  }
}

type TranslateContext = {
  spec: SpecializationType;
  isI32: boolean;
  wasmType: number;
  funcIndex: Map<string, number>;
};

// jsmini バイトコード → Wasm 命令列に変換
function translateBytecode(func: BytecodeFunction, ctx: TranslateContext): number[] | null {
  const out: number[] = [];
  const result = translateRange(func, 0, func.bytecode.length, ctx, out);
  if (!result) return null;
  out.push(WASM_OP.end);
  return out;
}

// バイトコード範囲 [start, end) を Wasm に変換
function translateRange(
  func: BytecodeFunction,
  start: number,
  end: number,
  ctx: TranslateContext,
  out: number[],
): boolean {
  const { bytecode, constants } = func;
  const { isI32, funcIndex } = ctx;

  for (let pc = start; pc < end; pc++) {
    const instr = bytecode[pc];
    switch (instr.op) {
      case "LdaLocal":
        out.push(WASM_OP.local_get, instr.operand!);
        break;
      case "StaLocal":
        // jsmini の StaLocal は値をスタックに残す (peek)
        // Wasm の local.set は値を消費する
        // → local.tee を使って値を残す (後続の Pop で drop)
        out.push(0x22, instr.operand!); // local.tee
        break;
      case "LdaConst": {
        const val = constants[instr.operand!];
        if (typeof val !== "number") return false;
        if (isI32) {
          out.push(WASM_OP.i32_const, ...i32ToLEB128(val | 0));
        } else {
          out.push(WASM_OP.f64_const, ...f64ToBytes(val));
        }
        break;
      }
      case "LdaTrue":
        if (!isI32) return false;
        out.push(WASM_OP.i32_const, ...i32ToLEB128(1));
        break;
      case "LdaFalse":
        if (!isI32) return false;
        out.push(WASM_OP.i32_const, ...i32ToLEB128(0));
        break;

      // 算術
      case "Add": out.push(isI32 ? WASM_OP.i32_add : WASM_OP.f64_add); break;
      case "Sub": out.push(isI32 ? WASM_OP.i32_sub : WASM_OP.f64_sub); break;
      case "Mul": out.push(isI32 ? WASM_OP.i32_mul : WASM_OP.f64_mul); break;
      case "Div": out.push(isI32 ? WASM_OP.i32_div_s : WASM_OP.f64_div); break;
      case "Mod":
        if (isI32) { out.push(WASM_OP.i32_rem_s); }
        else return false;
        break;
      case "Negate":
        if (isI32) return false;
        out.push(WASM_OP.f64_neg);
        break;
      case "Increment":
        if (isI32) { out.push(WASM_OP.i32_const, ...i32ToLEB128(1), WASM_OP.i32_add); }
        else { out.push(WASM_OP.f64_const, ...f64ToBytes(1), WASM_OP.f64_add); }
        break;
      case "Decrement":
        if (isI32) { out.push(WASM_OP.i32_const, ...i32ToLEB128(1), WASM_OP.i32_sub); }
        else { out.push(WASM_OP.f64_const, ...f64ToBytes(1), WASM_OP.f64_sub); }
        break;

      // 比較
      case "LessThan": out.push(isI32 ? WASM_OP.i32_lt_s : WASM_OP.f64_lt); break;
      case "GreaterThan": out.push(isI32 ? WASM_OP.i32_gt_s : WASM_OP.f64_gt); break;
      case "LessEqual": out.push(isI32 ? WASM_OP.i32_le_s : WASM_OP.f64_le); break;
      case "GreaterEqual": out.push(isI32 ? WASM_OP.i32_ge_s : WASM_OP.f64_ge); break;
      case "Equal":
      case "StrictEqual":
        if (isI32) { out.push(0x46); } // i32.eq
        else return false;
        break;
      case "NotEqual":
      case "StrictNotEqual":
        if (isI32) { out.push(0x47); } // i32.ne
        else return false;
        break;

      // 条件分岐
      case "JumpIfFalse": {
        const target = instr.operand!;

        // パターン 1: ループ
        // JumpIfFalse がループ脱出で、target の直前に Jump(後方) がある
        // bytecode: [loopStart] ... test JumpIfFalse(exit) ... body ... Jump(loopStart) [exit]
        const lastBeforeTarget = target > 0 ? bytecode[target - 1] : null;
        if (lastBeforeTarget && lastBeforeTarget.op === "Jump" && lastBeforeTarget.operand! <= pc) {
          const loopStart = lastBeforeTarget.operand!;
          // 条件は既にスタック上にある (外側の translateRange が処理した)
          // これを drop して、ループ内で条件を再評価する
          out.push(WASM_OP.drop);

          // Wasm: block $exit { loop $loop { 条件; eqz; br_if $exit; body; 条件; eqz; br_if $exit; br $loop } }
          out.push(WASM_OP.block, 0x40);  // block $exit (void)
          out.push(WASM_OP.loop, 0x40);   // loop $loop (void)

          // ループ条件を評価: loopStart ～ JumpIfFalse の直前
          if (!translateRange(func, loopStart, pc, ctx, out)) return false;
          out.push(WASM_OP.i32_eqz);
          out.push(WASM_OP.br_if, 0x01);  // br_if $exit (条件 false なら脱出)

          // ループ本体: JumpIfFalse の次 ～ Jump の手前
          if (!translateRange(func, pc + 1, target - 1, ctx, out)) return false;

          out.push(WASM_OP.br, 0x00);    // br $loop (continue)
          out.push(WASM_OP.end);          // end loop
          out.push(WASM_OP.end);          // end block
          pc = target - 1; // for の pc++ で target へ
          break;
        }

        // パターン 2: if-then-return
        const trueBlock = bytecode.slice(pc + 1, target);
        const hasReturn = trueBlock.some(i => i.op === "Return");
        if (hasReturn) {
          out.push(WASM_OP.if, 0x40);
          if (!translateRange(func, pc + 1, target, ctx, out)) return false;
          out.push(WASM_OP.end);
          pc = target - 1;
          break;
        }

        // パターン 3: if-else (target に Jump がある)
        if (target < bytecode.length && bytecode[target].op === "Jump") {
          const elseEnd = bytecode[target].operand!;
          out.push(WASM_OP.if, 0x40);
          if (!translateRange(func, pc + 1, target, ctx, out)) return false;
          out.push(WASM_OP.else);
          if (!translateRange(func, target + 1, elseEnd, ctx, out)) return false;
          out.push(WASM_OP.end);
          pc = elseEnd - 1;
          break;
        }

        return false;
      }

      // Jump: ループの br は JumpIfFalse のループパターンで処理済み
      case "Jump":
        // 後方ジャンプはループパターンで、前方は if/else で処理されるべき
        return false;

      // 関数呼び出し
      case "LdaGlobal": {
        const name = constants[instr.operand!] as string;
        // 次の命令が Call で、呼び出し先が既知の関数なら skip (Call で処理)
        if (typeof name === "string" && pc + 1 < bytecode.length && bytecode[pc + 1].op === "Call") {
          if (funcIndex.has(name)) {
            break; // skip — Call で処理
          }
        }
        return false;
      }

      case "Call": {
        if (pc > 0 && bytecode[pc - 1].op === "LdaGlobal") {
          const name = constants[bytecode[pc - 1].operand!] as string;
          const idx = funcIndex.get(name);
          if (idx !== undefined) {
            out.push(WASM_OP.call, idx);
            break;
          }
        }
        return false;
      }

      case "Return":
        out.push(WASM_OP.return);
        break;
      case "LdaUndefined":
        if (isI32) { out.push(WASM_OP.i32_const, 0x00); }
        else { out.push(WASM_OP.f64_const, ...f64ToBytes(0)); }
        break;
      case "Pop":
        out.push(WASM_OP.drop);
        break;
      default:
        return false;
    }
  }
  return true;
}
