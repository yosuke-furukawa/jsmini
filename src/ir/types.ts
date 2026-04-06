// IR データ構造 — CFG + SSA 形式
//
// 全エンジン (V8 Turboshaft, JSC B3, SpiderMonkey MIR) が
// CFG + SSA に収束した。jsmini もこれに倣う。

// ========== 型 ==========

export type IRType = "i32" | "f64" | "bool" | "any";

// ========== Opcode ==========

export type IROpcode =
  // 定数・パラメータ
  | "Const"           // 即値。value フィールドに値を持つ
  | "Param"           // 関数パラメータ。index フィールドにパラメータ番号
  | "Undefined"       // undefined

  // 算術
  | "Add"
  | "Sub"
  | "Mul"
  | "Div"
  | "Mod"
  | "Negate"          // 単項 -

  // 比較
  | "LessThan"
  | "LessEqual"
  | "GreaterThan"
  | "GreaterEqual"
  | "Equal"           // ==
  | "StrictEqual"     // ===
  | "NotEqual"
  | "StrictNotEqual"

  // 論理・ビット
  | "Not"             // !
  | "BitAnd"
  | "BitOr"
  | "BitXor"
  | "BitNot"
  | "ShiftLeft"
  | "ShiftRight"

  // 制御フロー
  | "Branch"          // 条件分岐。args[0] = 条件、successors で分岐先
  | "Jump"            // 無条件ジャンプ
  | "Return"          // args[0] = 返す値

  // 配列
  | "ArrayGet"        // args[0] = array, args[1] = index → 要素値
  | "ArraySet"        // args[0] = array, args[1] = index, args[2] = value
  | "ArrayLength"     // args[0] = array → 長さ

  // グローバル変数
  | "LoadGlobal"      // グローバル変数の読み込み。globalName フィールドに変数名
  | "StoreGlobal"     // グローバル変数の書き込み。args[0] = 値、globalName に変数名

  // 関数呼び出し
  | "Call"            // args[0] = callee, args[1..] = 引数

  // 型ガード
  | "TypeGuard"       // TypeGuard(value, expectedType) — 型チェック、失敗で deopt

  // SSA
  | "Phi";            // 合流点での値選択

// ========== Op (SSA 命令) ==========

export interface Op {
  id: number;         // SSA 値の一意 ID
  opcode: IROpcode;
  args: number[];     // 他の Op の id への参照
  type: IRType;

  // Const 用
  value?: number | boolean;

  // Param 用
  index?: number;

  // TypeGuard 用
  guardType?: IRType;

  // Call 用: インライン展開対象の BytecodeFunction
  calleeName?: string;

  // LoadGlobal / StoreGlobal 用
  globalName?: string;

  // Range Analysis 用
  range?: { min: number; max: number };
}

// ========== Phi ノード ==========

export interface PhiOp extends Op {
  opcode: "Phi";
  // [predecessorBlockId, valueId] のペア
  inputs: [number, number][];
}

export function isPhi(op: Op): op is PhiOp {
  return op.opcode === "Phi";
}

// ========== 基本ブロック ==========

export interface Block {
  id: number;
  ops: Op[];
  phis: PhiOp[];
  successors: number[];    // 後続ブロックの id
  predecessors: number[];  // 前任ブロックの id
}

// ========== IR 関数 ==========

export interface IRFunction {
  name: string;
  paramCount: number;
  blocks: Block[];
  nextOpId: number;        // 次の Op id (自動採番用)
}

// ========== ヘルパー ==========

export function createBlock(id: number): Block {
  return { id, ops: [], phis: [], successors: [], predecessors: [] };
}

export function createOp(func: IRFunction, opcode: IROpcode, args: number[], type: IRType): Op {
  const op: Op = { id: func.nextOpId++, opcode, args, type };
  return op;
}

export function createConst(func: IRFunction, value: number, type: IRType = "i32"): Op {
  const op = createOp(func, "Const", [], type);
  op.value = value;
  return op;
}

export function createParam(func: IRFunction, index: number, type: IRType = "any"): Op {
  const op = createOp(func, "Param", [], type);
  op.index = index;
  return op;
}

export function createPhi(func: IRFunction, type: IRType = "any"): PhiOp {
  const op = createOp(func, "Phi", [], type) as PhiOp;
  op.inputs = [];
  return op;
}

export function createIRFunction(name: string, paramCount: number): IRFunction {
  return { name, paramCount, blocks: [], nextOpId: 0 };
}
