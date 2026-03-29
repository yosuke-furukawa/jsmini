// Wasm GC ベースの JIT コンパイラ
// Phase 8E の linear memory 方式の代替。struct.new/struct.get で GC 管理オブジェクトを使う。

import type { BytecodeFunction } from "../vm/bytecode.js";
import { WasmBuilder, WASM_OP, WASM_TYPE, WASM_GC_OP, refType, i32ToLEB128, f64ToBytes } from "./wasm-builder.js";
import { detectArrayLocals } from "./array-analysis.js";

type GCCompileResult = {
  functions: Map<string, Function>;
  structTypeIndex: number;
};

// Vec のような数値プロパティのみのクラスを Wasm GC struct で JIT コンパイル
export function compileWithWasmGC(
  funcs: BytecodeFunction[],
): GCCompileResult | null {
  // プロパティ名の収集 (全関数で共通の struct 型を作る)
  const propNames = new Set<string>();
  for (const func of funcs) {
    for (const instr of func.bytecode) {
      if ((instr.op === "GetProperty" || instr.op === "SetPropertyAssign") && instr.operand !== undefined) {
        const name = func.constants[instr.operand] as string;
        if (name !== "length") propNames.add(name);
      }
    }
  }

  if (propNames.size === 0) return null;

  const propList = [...propNames];
  const propIndex = new Map<string, number>();
  for (let i = 0; i < propList.length; i++) propIndex.set(propList[i], i);

  // どの関数が constructor かを判定
  const isConstructorFunc = (func: BytecodeFunction) =>
    func.bytecode.some(i => i.op === "SetPropertyAssign") &&
    func.bytecode.some(i => i.op === "LoadThis") &&
    !func.bytecode.some(i => i.op === "GetProperty");

  // 関数名 → 実際のコンパイル後の index
  // constructor はスキップして __create に置き換えるので index がズレる
  const funcIndex = new Map<string, number>();
  let compiledIdx = 0;
  // __create を先頭に (index 0)
  funcIndex.set("__create", compiledIdx++);
  for (const func of funcs) {
    if (isConstructorFunc(func)) {
      // constructor は __create にリダイレクト
      funcIndex.set(func.name, 0); // __create の index
    } else {
      funcIndex.set(func.name, compiledIdx++);
    }
  }

  const builder = new WasmBuilder();

  // struct 型: 全プロパティを i32 フィールドに
  const structType = builder.addStruct(
    propList.map(() => ({ type: WASM_TYPE.i32, mutable: true }))
  );

  // create 関数を自動追加: (i32, i32, ...) -> ref struct
  // constructor の代わりに struct.new を直接呼ぶ
  const createBody: number[] = [];
  for (let i = 0; i < propList.length; i++) {
    createBody.push(WASM_OP.local_get, i);
  }
  createBody.push(0xfb, WASM_GC_OP.struct_new, structType);
  createBody.push(WASM_OP.end);
  const createParams = propList.map(() => WASM_TYPE.i32);
  builder.addFunction("__create",
    createParams,
    refType(structType),
    createBody,
    0,
    propList.length,
    1,
  );
  // funcIndex は上で設定済み (constructor は __create の index 0 にリダイレクト)

  // 各関数をコンパイル
  for (const func of funcs) {
    if (isConstructorFunc(func)) continue;

    const hasThis = func.bytecode.some(i => i.op === "LoadThis");
    const hasConstruct = func.bytecode.some(i => i.op === "Construct");

    // パラメータ: 通常引数 (i32) + this (ref struct) if hasThis
    const paramBytes: number[] = [];
    let paramCount = 0;
    for (let i = 0; i < func.paramCount; i++) {
      // 引数が ref か i32 かを判定
      // 配列ローカル or オブジェクトローカルなら ref、それ以外は i32
      const isObjParam = func.bytecode.some(instr =>
        (instr.op === "GetProperty" || instr.op === "SetPropertyAssign") &&
        // この引数が GetProperty のオブジェクト位置にあるか
        func.bytecode.some((prev, idx) =>
          prev.op === "LdaLocal" && prev.operand === i &&
          idx + 1 < func.bytecode.length &&
          (func.bytecode[idx + 1].op === "GetProperty" || func.bytecode[idx + 1].op === "SetPropertyAssign")
        )
      );
      if (isObjParam) {
        paramBytes.push(...refType(structType));
      } else {
        paramBytes.push(WASM_TYPE.i32);
      }
      paramCount++;
    }
    // this パラメータ
    if (hasThis) {
      paramBytes.push(...refType(structType));
      paramCount++;
    }

    // 結果型: Construct があるなら ref struct、なければ i32
    const resultBytes = hasConstruct ? refType(structType) : [WASM_TYPE.i32];
    const resultCount = 1;

    // 本体をコンパイル
    const body = translateGCBytecode(func, structType, propIndex, funcIndex, hasThis, builder);
    if (!body) return null;

    // extra locals
    let extraLocals = func.localCount - func.paramCount;
    // SetPropertyAssign 用の temp local
    if (func.bytecode.some(i => i.op === "SetPropertyAssign")) extraLocals += 2;

    builder.addFunction(func.name, paramBytes, resultBytes, body, extraLocals, paramCount, resultCount);
  }

  try {
    const bytes = builder.build();
    const mod = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(mod);
    const result = new Map<string, Function>();
    // __create を含む全 export を登録
    for (const name of Object.keys(instance.exports)) {
      const exp = instance.exports[name];
      if (typeof exp === "function") result.set(name, exp);
    }
    return { functions: result, structTypeIndex: structType };
  } catch (e: any) {
    if (process?.env?.DEBUG) console.error("Wasm GC compile error:", e.message);
    return null;
  }
}

function translateGCBytecode(
  func: BytecodeFunction,
  structType: number,
  propIndex: Map<string, number>,
  funcIndex: Map<string, number>,
  hasThis: boolean,
  builder: WasmBuilder,
): number[] | null {
  const out: number[] = [];
  const { bytecode, constants } = func;
  const thisLocal = func.paramCount; // this は最後の param

  for (let pc = 0; pc < bytecode.length; pc++) {
    const instr = bytecode[pc];
    switch (instr.op) {
      case "LdaLocal":
        out.push(WASM_OP.local_get, instr.operand!);
        break;
      case "StaLocal":
        out.push(0x22, instr.operand!); // local.tee
        break;
      case "LdaConst": {
        const val = constants[instr.operand!];
        if (typeof val !== "number") return null;
        out.push(WASM_OP.i32_const, ...i32ToLEB128(val | 0));
        break;
      }
      case "LoadThis":
        out.push(WASM_OP.local_get, thisLocal);
        break;
      case "GetProperty": {
        const name = constants[instr.operand!] as string;
        const fieldIdx = propIndex.get(name);
        if (fieldIdx === undefined) return null;
        out.push(0xfb, WASM_GC_OP.struct_get, structType, fieldIdx);
        break;
      }
      case "SetPropertyAssign": {
        const name = constants[instr.operand!] as string;
        const fieldIdx = propIndex.get(name);
        if (fieldIdx === undefined) return null;
        // スタック: [value, obj_ref]
        // struct.set expects: [obj_ref, value]
        // → swap using temp locals
        const tempRef = func.localCount;
        const tempVal = func.localCount + 1;
        out.push(0x22, tempRef);     // local.tee tempRef (obj)
        out.push(WASM_OP.drop);
        out.push(0x22, tempVal);     // local.tee tempVal (value)
        out.push(WASM_OP.drop);
        out.push(WASM_OP.local_get, tempRef);
        out.push(WASM_OP.local_get, tempVal);
        out.push(0xfb, WASM_GC_OP.struct_set, structType, fieldIdx);
        // push value (代入式の値)
        out.push(WASM_OP.local_get, tempVal);
        break;
      }
      case "Add": out.push(WASM_OP.i32_add); break;
      case "Sub": out.push(WASM_OP.i32_sub); break;
      case "Mul": out.push(WASM_OP.i32_mul); break;
      case "Div": out.push(WASM_OP.i32_div_s); break;
      case "Mod": out.push(WASM_OP.i32_rem_s); break;
      case "LessThan": out.push(WASM_OP.i32_lt_s); break;
      case "LessEqual": out.push(WASM_OP.i32_le_s); break;
      case "GreaterThan": out.push(WASM_OP.i32_gt_s); break;
      case "GreaterEqual": out.push(WASM_OP.i32_ge_s); break;
      case "Equal":
      case "StrictEqual": out.push(0x46); break; // i32.eq
      case "Return": out.push(WASM_OP.return); break;
      case "Pop": out.push(WASM_OP.drop); break;
      case "LdaUndefined":
        // Construct を返す関数では LdaUndefined+Return は到達不能
        // i32.const 0 を push すると型が合わない場合がある
        // → 次が Return ならまとめて unreachable に
        if (pc + 1 < bytecode.length && bytecode[pc + 1].op === "Return") {
          out.push(0x00); // unreachable
          pc++; // Return をスキップ
          break;
        }
        out.push(WASM_OP.i32_const, 0x00);
        break;

      case "LdaGlobal": {
        const name = constants[instr.operand!] as string;
        if (pc + 1 < bytecode.length && (bytecode[pc + 1].op === "Call" || bytecode[pc + 1].op === "Construct")) {
          if (funcIndex.has(name)) break; // skip — Call/Construct で処理
        }
        return null;
      }

      case "Call": {
        if (pc > 0 && bytecode[pc - 1].op === "LdaGlobal") {
          const name = constants[bytecode[pc - 1].operand!] as string;
          const idx = funcIndex.get(name);
          if (idx !== undefined) {
            out.push(WASM_OP.call, idx); // function index
            break;
          }
        }
        return null;
      }

      case "Construct": {
        // new Vec(arg0, arg1) → call __create(arg0, arg1) → ref struct
        if (pc > 0 && bytecode[pc - 1].op === "LdaGlobal") {
          const createIdx = funcIndex.get("__create");
          if (createIdx !== undefined) {
            out.push(WASM_OP.call, createIdx); // function index (not type index)
            break;
          }
        }
        return null;
      }

      case "JumpIfFalse": {
        const target = instr.operand!;
        const trueBlock = bytecode.slice(pc + 1, target);
        if (trueBlock.some(i => i.op === "Return")) {
          out.push(WASM_OP.if, 0x40);
          for (let j = pc + 1; j < target; j++) {
            // 再帰的に処理 (簡易版: 1 命令ずつ)
            const inner = bytecode[j];
            const saved = translateGCSingle(inner, func, structType, propIndex, funcIndex, hasThis, builder);
            if (!saved) return null;
            out.push(...saved);
          }
          out.push(WASM_OP.end);
          pc = target - 1;
          break;
        }
        return null;
      }

      default:
        return null;
    }
  }

  out.push(WASM_OP.end);
  return out;
}

function translateGCSingle(
  instr: { op: string; operand?: number },
  func: BytecodeFunction,
  structType: number,
  propIndex: Map<string, number>,
  funcIndex: Map<string, number>,
  hasThis: boolean,
  builder: WasmBuilder,
): number[] | null {
  const { constants } = func;
  const out: number[] = [];
  switch (instr.op) {
    case "LdaLocal": out.push(WASM_OP.local_get, instr.operand!); return out;
    case "LdaConst": {
      const val = constants[instr.operand!];
      if (typeof val !== "number") return null;
      out.push(WASM_OP.i32_const, ...i32ToLEB128(val | 0));
      return out;
    }
    case "LoadThis": out.push(WASM_OP.local_get, func.paramCount); return out;
    case "GetProperty": {
      const name = constants[instr.operand!] as string;
      const fieldIdx = propIndex.get(name);
      if (fieldIdx === undefined) return null;
      out.push(0xfb, WASM_GC_OP.struct_get, structType, fieldIdx);
      return out;
    }
    case "Add": out.push(WASM_OP.i32_add); return out;
    case "Sub": out.push(WASM_OP.i32_sub); return out;
    case "Mul": out.push(WASM_OP.i32_mul); return out;
    case "Return": out.push(WASM_OP.return); return out;
    case "LdaUndefined": out.push(WASM_OP.i32_const, 0x00); return out;
    default: return null;
  }
}
