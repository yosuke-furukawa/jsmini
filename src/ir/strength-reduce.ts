// Strength Reduction — 高コスト演算を低コストに置き換え
//
// Mul/Div/Mod の 2 冪変換:
//   x * 2  → x << 1   (i32 のみ)
//   x * 4  → x << 2
//   x / 2  → x >> 1   (正の整数のみ、Range で判定)
//   x % 2  → x & 1    (正の整数のみ)
//
// 恒等変換:
//   x * 0  → 0
//   x * 1  → x
//   x + 0  → x
//   x - 0  → x

import type { IRFunction, Op, Block } from "./types.js";
import { createConst } from "./types.js";

// 2 の冪乗なら指数を返す (1→0, 2→1, 4→2, 8→3, ...)
function log2IfPow2(n: number): number {
  if (n <= 0 || !Number.isInteger(n)) return -1;
  if ((n & (n - 1)) !== 0) return -1;
  return Math.log2(n);
}

export function strengthReduce(func: IRFunction): boolean {
  let changed = false;

  // Op ID → Op のマップ
  const opById = new Map<number, Op>();
  for (const block of func.blocks) {
    for (const phi of block.phis) opById.set(phi.id, phi);
    for (const op of block.ops) opById.set(op.id, op);
  }

  // ブロックごとの挿入待ち Op (Op の直前に挿入する)
  const insertBefore = new Map<Op, Op[]>();

  for (const block of func.blocks) {
    for (const op of block.ops) {
      if (op.args.length !== 2) continue;

      const left = opById.get(op.args[0]);
      const right = opById.get(op.args[1]);
      if (!left || !right) continue;

      // 右辺が Const の場合
      if (right.opcode === "Const" && typeof right.value === "number") {
        const val = right.value;

        switch (op.opcode) {
          case "Mul": {
            if (val === 0) {
              op.opcode = "Const";
              op.value = 0;
              op.args = [];
              op.type = "i32";
              changed = true;
            } else if (val === 1) {
              replaceWithArg(func, op, op.args[0]);
              changed = true;
            } else {
              const shift = log2IfPow2(val);
              if (shift > 0) {
                const shiftConst = createConst(func, shift);
                opById.set(shiftConst.id, shiftConst);
                addInsert(insertBefore, op, shiftConst);
                op.opcode = "ShiftLeft";
                op.args[1] = shiftConst.id;
                changed = true;
              }
            }
            break;
          }

          case "Div": {
            if (val === 1) {
              replaceWithArg(func, op, op.args[0]);
              changed = true;
            } else {
              const shift = log2IfPow2(val);
              if (shift > 0 && isNonNegative(left)) {
                const shiftConst = createConst(func, shift);
                opById.set(shiftConst.id, shiftConst);
                addInsert(insertBefore, op, shiftConst);
                op.opcode = "ShiftRight";
                op.args[1] = shiftConst.id;
                changed = true;
              }
            }
            break;
          }

          case "Mod": {
            const shift = log2IfPow2(val);
            if (shift > 0 && isNonNegative(left)) {
              const maskConst = createConst(func, val - 1);
              opById.set(maskConst.id, maskConst);
              addInsert(insertBefore, op, maskConst);
              op.opcode = "BitAnd";
              op.args[1] = maskConst.id;
              changed = true;
            }
            break;
          }

          case "Add": {
            if (val === 0) {
              replaceWithArg(func, op, op.args[0]);
              changed = true;
            }
            break;
          }

          case "Sub": {
            if (val === 0) {
              replaceWithArg(func, op, op.args[0]);
              changed = true;
            }
            break;
          }
        }
        continue;
      }

      // 左辺が Const の場合 (可換演算のみ)
      if (left.opcode === "Const" && typeof left.value === "number") {
        const val = left.value;

        switch (op.opcode) {
          case "Mul": {
            if (val === 0) {
              op.opcode = "Const";
              op.value = 0;
              op.args = [];
              op.type = "i32";
              changed = true;
            } else if (val === 1) {
              replaceWithArg(func, op, op.args[1]);
              changed = true;
            } else {
              const shift = log2IfPow2(val);
              if (shift > 0) {
                const shiftConst = createConst(func, shift);
                opById.set(shiftConst.id, shiftConst);
                addInsert(insertBefore, op, shiftConst);
                op.opcode = "ShiftLeft";
                op.args = [op.args[1], shiftConst.id];
                changed = true;
              }
            }
            break;
          }

          case "Add": {
            if (val === 0) {
              replaceWithArg(func, op, op.args[1]);
              changed = true;
            }
            break;
          }
        }
      }
    }
  }

  // 新しい Const Op をブロックに挿入
  for (const block of func.blocks) {
    const newOps: Op[] = [];
    for (const op of block.ops) {
      const toInsert = insertBefore.get(op);
      if (toInsert) {
        newOps.push(...toInsert);
      }
      newOps.push(op);
    }
    block.ops = newOps;
  }

  return changed;
}

function addInsert(map: Map<Op, Op[]>, before: Op, newOp: Op): void {
  const list = map.get(before);
  if (list) list.push(newOp);
  else map.set(before, [newOp]);
}

// Range 情報から非負数かどうか判定
function isNonNegative(op: Op): boolean {
  if (op.range && op.range.min >= 0) return true;
  // Const で非負なら OK
  if (op.opcode === "Const" && typeof op.value === "number" && op.value >= 0) return true;
  return false;
}

// Op への参照を別の Op ID に付け替え
function replaceWithArg(func: IRFunction, op: Op, targetId: number): void {
  const oldId = op.id;
  // この Op を使っている全箇所で oldId → targetId に置換
  for (const block of func.blocks) {
    for (const phi of block.phis) {
      for (let i = 0; i < phi.inputs.length; i++) {
        if (phi.inputs[i][1] === oldId) {
          phi.inputs[i][1] = targetId;
        }
      }
    }
    for (const other of block.ops) {
      if (other === op) continue;
      for (let i = 0; i < other.args.length; i++) {
        if (other.args[i] === oldId) {
          other.args[i] = targetId;
        }
      }
    }
  }
}
