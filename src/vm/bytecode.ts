// バイトコード命令定義
// スタックベース VM: 中間結果をオペランドスタックに push/pop する

export type Opcode =
  // 定数ロード
  | "LdaConst"        // LdaConst <index> — 定数テーブルから値をロードして push
  | "LdaUndefined"    // undefined を push
  | "LdaNull"         // null を push
  | "LdaTrue"         // true を push
  | "LdaFalse"        // false を push

  // 算術
  | "Add"             // pop 2つ、加算して push (文字列連結も)
  | "Sub"             // pop 2つ、減算して push
  | "Mul"             // pop 2つ、乗算して push
  | "Div"             // pop 2つ、除算して push
  | "Mod"             // pop 2つ、剰余して push
  | "Negate"          // pop 1つ、符号反転して push

  // 比較
  | "Equal"           // ==
  | "StrictEqual"     // ===
  | "NotEqual"        // !=
  | "StrictNotEqual"  // !==
  | "LessThan"        // <
  | "GreaterThan"     // >
  | "LessEqual"       // <=
  | "GreaterEqual"    // >=

  // 論理
  | "LogicalNot"      // !

  // 変数
  | "LdaGlobal"       // LdaGlobal <nameIndex> — グローバル変数を push
  | "StaGlobal"       // StaGlobal <nameIndex> — スタックトップをグローバル変数に格納 (pop しない)
  | "LdaLocal"        // LdaLocal <slot> — ローカル変数を push
  | "StaLocal"        // StaLocal <slot> — スタックトップをローカル変数に格納 (pop しない)

  // プロパティ
  | "GetProperty"     // GetProperty <nameIndex> — pop obj, push obj[name]

  // 関数
  | "Call"            // Call <argc> — スタックから関数 + argc 個の引数を pop、呼び出し
  | "CallMethod"      // CallMethod <argc> — メソッド呼び出し (スタック: ...args, obj, method)

  // 制御フロー
  | "Jump"            // Jump <offset> — 無条件ジャンプ (pc = operand)
  | "JumpIfFalse"     // JumpIfFalse <offset> — falsy なら pc = operand (pop する)
  | "JumpIfTrue"      // JumpIfTrue <offset> — truthy なら pc = operand (pop する)

  // スタック操作
  | "Pop"             // スタックトップを捨てる
  | "Dup"             // スタックトップを複製
  | "Return";         // 関数から戻る (スタックトップが戻り値)

// 1つの命令
export type Instruction = {
  op: Opcode;
  operand?: number;   // LdaConst のインデックス等
};

// コンパイル結果: 1つの関数のバイトコード
export type BytecodeFunction = {
  name: string;
  paramCount: number;       // パラメータ数
  localCount: number;       // ローカル変数スロット数 (パラメータ含む)
  bytecode: Instruction[];
  constants: unknown[];
};

// バイトコードを人間が読める形式にダンプ（ネスト関数も再帰的に表示）
export function disassemble(func: BytecodeFunction): string {
  const lines: string[] = [];
  disassembleFunc(func, lines, "");
  return lines.join("\n");
}

function disassembleFunc(func: BytecodeFunction, lines: string[], indent: string): void {
  lines.push(`${indent}== ${func.name || "<script>"} (params: ${func.paramCount}, locals: ${func.localCount}) ==`);
  for (let i = 0; i < func.bytecode.length; i++) {
    const instr = func.bytecode[i];
    const addr = String(i).padStart(4, "0");
    const comment = formatOperandComment(instr, func.constants);
    if (instr.operand !== undefined) {
      lines.push(`${indent}  ${addr}: ${instr.op.padEnd(16)} ${instr.operand}${comment}`);
    } else {
      lines.push(`${indent}  ${addr}: ${instr.op}`);
    }
  }

  // ネストした関数をダンプ
  for (const c of func.constants) {
    if (isBytecodeFunction(c)) {
      lines.push("");
      disassembleFunc(c, lines, indent);
    }
  }
}

function formatOperandComment(instr: Instruction, constants: unknown[]): string {
  if (instr.operand === undefined) return "";
  switch (instr.op) {
    case "LdaConst": {
      const val = constants[instr.operand];
      if (isBytecodeFunction(val)) return ` ; <function ${val.name}>`;
      return ` ; ${formatValue(val)}`;
    }
    case "LdaGlobal":
    case "StaGlobal":
      return ` ; ${constants[instr.operand]}`;
    case "Jump":
    case "JumpIfFalse":
    case "JumpIfTrue":
      return ` ; -> ${String(instr.operand).padStart(4, "0")}`;
    case "Call":
      return ` ; argc=${instr.operand}`;
    default:
      return "";
  }
}

function formatValue(val: unknown): string {
  if (typeof val === "string") return `"${val}"`;
  return String(val);
}

function isBytecodeFunction(val: unknown): val is BytecodeFunction {
  return typeof val === "object" && val !== null && "bytecode" in val && "constants" in val;
}
