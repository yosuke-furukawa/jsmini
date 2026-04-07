// LICM (Loop-Invariant Code Motion) — ループ不変式をループ外に移動
//
// ループ内で値が変わらない計算をループ前に移動し、無駄な再計算を防ぐ。
//
// ループ不変の定義:
//   - 全引数がループ外で定義されている
//   - または全引数が既にループ不変と判定された
//   - 副作用のある Op (Call, StoreGlobal, ArraySet 等) は移動しない

import type { IRFunction, Op, Block } from "./types.js";
import { isPhi } from "./types.js";
import { analyzeCFG, type LoopInfo } from "./loop-analysis.js";

// 副作用がある or 移動不可な opcode
const UNMOVABLE = new Set([
  "Branch", "Jump", "Return",    // 制御フロー
  "Call",                         // 副作用あり
  "StoreGlobal",                  // 副作用あり
  "ArraySet",                     // 副作用あり
  "Phi",                          // ループの merge 点
  "TypeGuard",                    // deopt 位置が変わると意味が変わる
]);

export function licm(func: IRFunction): boolean {
  const cfg = analyzeCFG(func);
  if (cfg.loops.length === 0) return false;

  // ブロック ID → Block のマップ
  const blockMap = new Map<number, Block>();
  for (const b of func.blocks) blockMap.set(b.id, b);

  // Op ID → 定義ブロック ID のマップ
  const defBlock = new Map<number, number>();
  for (const b of func.blocks) {
    for (const phi of b.phis) defBlock.set(phi.id, b.id);
    for (const op of b.ops) defBlock.set(op.id, b.id);
  }

  // ネストしたループは内側から処理 (body が小さい順)
  const sortedLoops = [...cfg.loops].sort((a, b) => a.body.size - b.body.size);

  let changed = false;
  for (const loop of sortedLoops) {
    if (hoistFromLoop(func, loop, blockMap, defBlock)) {
      changed = true;
    }
  }

  return changed;
}

function hoistFromLoop(
  func: IRFunction,
  loop: LoopInfo,
  blockMap: Map<number, Block>,
  defBlock: Map<number, number>,
): boolean {
  // preheader を見つける: ループヘッダの predecessor でループ本体に含まれないもの
  const headerBlock = blockMap.get(loop.header);
  if (!headerBlock) return false;

  let preheaterId = -1;
  for (const predId of headerBlock.predecessors) {
    if (!loop.body.has(predId)) {
      preheaterId = predId;
      break;
    }
  }
  if (preheaterId === -1) return false;

  const preheader = blockMap.get(preheaterId);
  if (!preheader) return false;

  // ループ内の全 Op を収集
  const loopOps = new Set<number>();
  for (const bid of loop.body) {
    const block = blockMap.get(bid);
    if (!block) continue;
    for (const phi of block.phis) loopOps.add(phi.id);
    for (const op of block.ops) loopOps.add(op.id);
  }

  // ループ不変な Op を判定 (fixpoint)
  const invariant = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const bid of loop.body) {
      const block = blockMap.get(bid);
      if (!block) continue;
      for (const op of block.ops) {
        if (invariant.has(op.id)) continue;
        if (UNMOVABLE.has(op.opcode)) continue;
        if (isLoopInvariant(op, loopOps, invariant)) {
          invariant.add(op.id);
          changed = true;
        }
      }
    }
  }

  if (invariant.size === 0) return false;

  // 不変 Op を preheader に移動 (terminator の前に挿入)
  // 依存関係の順序を保つため、元の出現順で移動
  const opsToMove: Op[] = [];
  for (const bid of loop.body) {
    const block = blockMap.get(bid);
    if (!block) continue;
    const remaining: Op[] = [];
    for (const op of block.ops) {
      if (invariant.has(op.id)) {
        opsToMove.push(op);
        defBlock.set(op.id, preheaterId); // 定義ブロック更新
      } else {
        remaining.push(op);
      }
    }
    block.ops = remaining;
  }

  // preheader の terminator (Jump/Branch) の前に挿入
  const terminatorIdx = preheader.ops.findIndex(
    op => op.opcode === "Jump" || op.opcode === "Branch" || op.opcode === "Return"
  );
  if (terminatorIdx >= 0) {
    preheader.ops.splice(terminatorIdx, 0, ...opsToMove);
  } else {
    // terminator がない場合は末尾に追加
    preheader.ops.push(...opsToMove);
  }

  return true;
}

// Op がループ不変かどうか
function isLoopInvariant(
  op: Op,
  loopOps: Set<number>,
  invariant: Set<number>,
): boolean {
  // 全引数がループ外、またはすでに不変と判定済み
  for (const argId of op.args) {
    if (loopOps.has(argId) && !invariant.has(argId)) {
      return false; // ループ内で定義され、まだ不変と判定されていない
    }
  }
  return true;
}
