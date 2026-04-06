// CSE (Common Subexpression Elimination) — 同一計算の重複除去
//
// 同じ opcode + 同じ args の Op を検出し、後の方を最初の Op に置換。
// 副作用のある Op (Call, StoreGlobal, ArraySet) は対象外。

import type { IRFunction, Op, Block } from "./types.js";
import { isPhi } from "./types.js";

// 副作用があるか、CSE 対象外の opcode
const NOT_CSE_TARGET = new Set([
  "Branch", "Jump", "Return",    // 制御フロー
  "Call",                         // 副作用あり
  "StoreGlobal",                  // 副作用あり
  "ArraySet",                     // 副作用あり
  "Phi",                          // 合流点
  "Param",                        // パラメータ (ユニーク)
  "Const",                        // 定数 (constant folding で処理)
  "Undefined",                    // ユニーク
  "TypeGuard",                    // 型ガード (位置が重要)
  "LoadGlobal",                   // グローバル読み込み (副作用の間で値が変わりうる)
  "ArrayGet",                     // 配列読み込み (ArraySet で値が変わりうる)
  "ArrayLength",                  // 配列長 (変わりうる)
]);

function opKey(op: Op): string {
  return `${op.opcode}:${op.args.join(",")}`;
}

export function cse(func: IRFunction): boolean {
  let changed = false;

  // Op ID → Op のマップ
  const opById = new Map<number, Op>();
  for (const block of func.blocks) {
    for (const phi of block.phis) opById.set(phi.id, phi);
    for (const op of block.ops) opById.set(op.id, op);
  }

  // ブロック内 CSE (Local CSE)
  for (const block of func.blocks) {
    // key → 最初の Op ID
    const seen = new Map<string, number>();

    for (const op of block.ops) {
      if (NOT_CSE_TARGET.has(op.opcode)) continue;
      if (op.args.length === 0) continue; // 引数なしは対象外

      const key = opKey(op);
      const firstId = seen.get(key);

      if (firstId !== undefined) {
        // 重複発見 → この Op への参照を firstId に付け替え
        replaceUses(func, op.id, firstId);
        changed = true;
      } else {
        seen.set(key, op.id);
      }
    }
  }

  return changed;
}

// oldId への参照を全て newId に置換
function replaceUses(func: IRFunction, oldId: number, newId: number): void {
  for (const block of func.blocks) {
    for (const phi of block.phis) {
      for (let i = 0; i < phi.inputs.length; i++) {
        if (phi.inputs[i][1] === oldId) {
          phi.inputs[i][1] = newId;
        }
      }
    }
    for (const op of block.ops) {
      for (let i = 0; i < op.args.length; i++) {
        if (op.args[i] === oldId) {
          op.args[i] = newId;
        }
      }
    }
  }
}
