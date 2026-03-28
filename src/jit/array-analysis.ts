// バイトコード静的解析: 配列として使われているローカル変数を検出
import type { BytecodeFunction } from "../vm/bytecode.js";

// 配列ローカルのスロット番号の集合を返す
export function detectArrayLocals(func: BytecodeFunction): Set<number> {
  const arrayLocals = new Set<number>();
  const { bytecode } = func;

  for (let pc = 0; pc < bytecode.length; pc++) {
    const instr = bytecode[pc];

    if (instr.op === "GetPropertyComputed") {
      // パターン: LdaLocal <arr>, LdaLocal <idx>, GetPropertyComputed
      // → arr が配列
      if (pc >= 2) {
        const objInstr = bytecode[pc - 2];
        if (objInstr.op === "LdaLocal") {
          arrayLocals.add(objInstr.operand!);
        }
      }
    }

    if (instr.op === "SetPropertyComputed") {
      // パターン: LdaLocal <arr>, LdaLocal <idx>, <value>, SetPropertyComputed
      // → arr が配列
      if (pc >= 3) {
        const objInstr = bytecode[pc - 3];
        if (objInstr.op === "LdaLocal") {
          arrayLocals.add(objInstr.operand!);
        }
      }
      // パターン: LdaLocal <arr>, LdaLocal <idx>, GetPropertyComputed, SetPropertyComputed
      // (arr[i] = arr[j] のように Get の結果を Set する場合、中間に GetPropertyComputed がある)
      // この場合 pc-3 は LdaLocal <arr> (Get 側の arr)
      // pc の直前の stack: [arr, idx, value]
      // value が GetPropertyComputed の場合: [obj, key, GetPropComp] で 3 命令前
      // 実際には pc-3 が LdaLocal で配列なら既に上で捕捉されている
    }

    // GetProperty "length" パターン: LdaLocal <arr>, GetProperty "length"
    if (instr.op === "GetProperty") {
      const name = func.constants[instr.operand!];
      if (name === "length" && pc >= 1) {
        const objInstr = bytecode[pc - 1];
        if (objInstr.op === "LdaLocal") {
          arrayLocals.add(objInstr.operand!);
        }
      }
    }
  }

  return arrayLocals;
}
