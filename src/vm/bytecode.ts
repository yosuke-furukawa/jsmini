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

  // 関数
  | "Call"            // Call <argc> — スタックから関数 + argc 個の引数を pop、呼び出し

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

// バイトコードを人間が読める形式にダンプ
export function disassemble(func: BytecodeFunction): string {
  const lines: string[] = [];
  lines.push(`== ${func.name || "<script>"} ==`);
  for (let i = 0; i < func.bytecode.length; i++) {
    const instr = func.bytecode[i];
    const addr = String(i).padStart(4, "0");
    if (instr.operand !== undefined) {
      const constVal = instr.op === "LdaConst" ? ` (${formatValue(func.constants[instr.operand])})` : "";
      lines.push(`  ${addr}: ${instr.op} ${instr.operand}${constVal}`);
    } else {
      lines.push(`  ${addr}: ${instr.op}`);
    }
  }
  return lines.join("\n");
}

function formatValue(val: unknown): string {
  if (typeof val === "string") return `"${val}"`;
  return String(val);
}
