// IR 最適化パス — Constant Folding + Dead Code Elimination
//
// Constant Folding: 定数同士の演算をコンパイル時に計算
//   Add(Const(3), Const(4)) → Const(7)
//
// DCE: 使われていない Op を除去
//   use count == 0 の Op を消す

import type { IRFunction, Block, Op } from "./types.js";
import { isPhi } from "./types.js";
import { inlinePass } from "./inline.js";
import { licm } from "./licm.js";
import { cse } from "./cse.js";
export type { InlineOptions } from "./inline.js";

// ========== Constant Folding ==========

export function constantFolding(func: IRFunction): boolean {
  let changed = false;

  // Op を id で引けるテーブルを構築
  const opById = new Map<number, Op>();
  for (const block of func.blocks) {
    for (const phi of block.phis) opById.set(phi.id, phi);
    for (const op of block.ops) opById.set(op.id, op);
  }

  for (const block of func.blocks) {
    for (let i = 0; i < block.ops.length; i++) {
      const op = block.ops[i];
      const folded = tryFold(op, opById);
      if (folded !== null) {
        // Op を Const に置き換え
        op.opcode = "Const";
        op.value = folded;
        op.args = [];
        op.type = typeof folded === "boolean" ? "bool" : Number.isInteger(folded) ? "i32" : "f64";
        changed = true;
      }
    }
  }

  return changed;
}

function tryFold(op: Op, opById: Map<number, Op>): number | boolean | null {
  // 2引数演算: 両方 Const なら畳み込み
  if (op.args.length === 2) {
    const left = opById.get(op.args[0]);
    const right = opById.get(op.args[1]);
    if (!left || !right) return null;
    if (left.opcode !== "Const" || right.opcode !== "Const") return null;
    if (left.value === undefined || right.value === undefined) return null;
    if (typeof left.value !== "number" || typeof right.value !== "number") return null;

    const l = left.value;
    const r = right.value;

    switch (op.opcode) {
      case "Add": return l + r;
      case "Sub": return l - r;
      case "Mul": return l * r;
      case "Div": return r !== 0 ? l / r : null;
      case "Mod": return r !== 0 ? l % r : null;
      case "BitAnd": return l & r;
      case "BitOr": return l | r;
      case "BitXor": return l ^ r;
      case "ShiftLeft": return l << r;
      case "ShiftRight": return l >> r;
      case "LessThan": return l < r;
      case "LessEqual": return l <= r;
      case "GreaterThan": return l > r;
      case "GreaterEqual": return l >= r;
      case "Equal": case "StrictEqual": return l === r;
      case "NotEqual": case "StrictNotEqual": return l !== r;
      default: return null;
    }
  }

  // 1引数演算
  if (op.args.length === 1) {
    const arg = opById.get(op.args[0]);
    if (!arg || arg.opcode !== "Const" || arg.value === undefined) return null;
    if (typeof arg.value !== "number") return null;

    switch (op.opcode) {
      case "Negate": return -arg.value;
      case "BitNot": return ~arg.value;
      case "Not": return !arg.value;
      default: return null;
    }
  }

  return null;
}

// ========== Dead Code Elimination ==========

export function deadCodeElimination(func: IRFunction): boolean {
  let changed = false;

  // use count を計算
  const useCount = new Map<number, number>();
  for (const block of func.blocks) {
    for (const phi of block.phis) {
      for (const [, valId] of phi.inputs) {
        useCount.set(valId, (useCount.get(valId) ?? 0) + 1);
      }
    }
    for (const op of block.ops) {
      for (const argId of op.args) {
        useCount.set(argId, (useCount.get(argId) ?? 0) + 1);
      }
    }
  }

  // use count == 0 の Op を除去 (制御フロー命令は除外)
  const controlOps = new Set(["Return", "Branch", "Jump"]);

  for (const block of func.blocks) {
    const newOps: Op[] = [];
    for (const op of block.ops) {
      if (controlOps.has(op.opcode)) {
        newOps.push(op);
        continue;
      }
      if ((useCount.get(op.id) ?? 0) > 0) {
        newOps.push(op);
      } else {
        changed = true;
      }
    }
    block.ops = newOps;
  }

  return changed;
}

// ========== 最適化パイプライン ==========

export function optimize(func: IRFunction, inlineOptions?: InlineOptions): void {
  // Inlining → Constant Folding → DCE → LICM を繰り返す (fixpoint)
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    if (inlineOptions) {
      changed = inlinePass(func, inlineOptions) || changed;
    }
    changed = constantFolding(func) || changed;
    changed = cse(func) || changed;
    changed = deadCodeElimination(func) || changed;
    changed = licm(func) || changed;
    if (!changed) break;
  }
}
