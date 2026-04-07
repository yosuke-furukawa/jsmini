// IR の文字列ダンプ
//
// V8 の --print-opt-code や SpiderMonkey の IONFLAGS=codegen に相当。
// `--print-ir` で IR を表示する。

import type { IRFunction, Block, Op, PhiOp } from "./types.js";
import { isPhi } from "./types.js";

function formatType(type: string): string {
  return type;
}

function formatOp(op: Op, indent: string = "  "): string {
  const typeStr = formatType(op.type);

  switch (op.opcode) {
    case "Const":
      return `${indent}v${op.id}: ${typeStr} = Const(${op.value})`;

    case "Param":
      return `${indent}v${op.id}: ${typeStr} = Param(${op.index})`;

    case "Undefined":
      return `${indent}v${op.id}: any = Undefined`;

    case "Phi": {
      const phi = op as PhiOp;
      const inputs = phi.inputs.map(([blockId, valId]) => `B${blockId}:v${valId}`).join(", ");
      return `${indent}v${op.id}: ${typeStr} = Phi(${inputs})`;
    }

    case "ArrayGet":
      return `${indent}v${op.id}: ${typeStr} = ArrayGet(v${op.args[0]}, v${op.args[1]})`;
    case "ArraySet":
      return `${indent}ArraySet(v${op.args[0]}, v${op.args[1]}, v${op.args[2]})`;
    case "ArrayLength":
      return `${indent}v${op.id}: ${typeStr} = ArrayLength(v${op.args[0]})`;

    case "LoadGlobal":
      return `${indent}v${op.id}: ${typeStr} = LoadGlobal("${op.globalName}")`;

    case "StoreGlobal":
      return `${indent}StoreGlobal("${op.globalName}", v${op.args[0]})`;

    case "LoadUpvalue":
      return `${indent}v${op.id}: ${typeStr} = LoadUpvalue(${op.index})`;

    case "StoreUpvalue":
      return `${indent}StoreUpvalue(${op.index}, v${op.args[0]})`;

    case "LoadThis":
      return `${indent}v${op.id}: ${typeStr} = LoadThis`;

    case "LoadProperty":
      return `${indent}v${op.id}: ${typeStr} = LoadProperty(v${op.args[0]}, "${op.globalName}")`;

    case "StoreProperty":
      return `${indent}StoreProperty(v${op.args[0]}, "${op.globalName}", v${op.args[1]})`;

    case "TypeGuard":
      return `${indent}v${op.id}: ${typeStr} = TypeGuard(v${op.args[0]}, ${op.guardType})`;

    case "Branch":
      return `${indent}Branch(v${op.args[0]})`;

    case "Jump":
      return `${indent}Jump`;

    case "Return":
      return `${indent}Return(v${op.args[0]})`;

    case "Call": {
      const [callee, ...callArgs] = op.args;
      const argsStr = callArgs.map(a => `v${a}`).join(", ");
      return `${indent}v${op.id}: ${typeStr} = Call(v${callee}, ${argsStr})`;
    }

    default: {
      // 算術・比較・論理: 2引数 or 1引数
      const argsStr = op.args.map(a => `v${a}`).join(", ");
      return `${indent}v${op.id}: ${typeStr} = ${op.opcode}(${argsStr})`;
    }
  }
}

function formatBlock(block: Block): string {
  const lines: string[] = [];

  // ブロックヘッダ
  const preds = block.predecessors.length > 0
    ? ` <- [${block.predecessors.map(p => `B${p}`).join(", ")}]`
    : "";
  const succs = block.successors.length > 0
    ? ` -> [${block.successors.map(s => `B${s}`).join(", ")}]`
    : "";
  lines.push(`B${block.id}${preds}${succs}:`);

  // Phi ノード
  for (const phi of block.phis) {
    lines.push(formatOp(phi));
  }

  // 通常の命令
  for (const op of block.ops) {
    lines.push(formatOp(op));
  }

  return lines.join("\n");
}

export function printIR(func: IRFunction): string {
  const lines: string[] = [];
  lines.push(`== IR: ${func.name} (params: ${func.paramCount}) ==`);
  for (const block of func.blocks) {
    lines.push(formatBlock(block));
  }
  return lines.join("\n");
}
