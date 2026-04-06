// ループ解析 — CFG から back edge とループ構造を検出
//
// Stackifier の前段: どのブロックがループヘッダで、
// どのエッジが back edge (上に戻る) かを特定する。

import type { IRFunction, Block } from "./types.js";

// ========== ループ情報 ==========

export type LoopInfo = {
  header: number;         // ループヘッダブロック ID
  body: Set<number>;      // ループ本体のブロック ID 集合
  backEdgeFrom: number;   // back edge の始点ブロック ID
  exitBlock: number;      // ループ出口ブロック ID (header の successor で body に含まれない)
};

export type CFGAnalysis = {
  loops: LoopInfo[];
  backEdges: Set<string>;        // "fromId→toId" の文字列集合
  topoOrder: number[];           // トポロジカル順序
  loopHeaders: Set<number>;      // ループヘッダのブロック ID
};

// ========== Back Edge の検出 ==========

// DFS でブロックを訪問し、back edge (訪問中のブロックへの再訪問) を検出
function findBackEdges(irFunc: IRFunction): Set<string> {
  const backEdges = new Set<string>();
  const visited = new Set<number>();
  const inStack = new Set<number>();  // 現在の DFS パス上にあるブロック

  const blockMap = new Map<number, Block>();
  for (const b of irFunc.blocks) blockMap.set(b.id, b);

  function dfs(blockId: number): void {
    visited.add(blockId);
    inStack.add(blockId);

    const block = blockMap.get(blockId);
    if (!block) return;

    for (const succId of block.successors) {
      if (inStack.has(succId)) {
        // succId は現在のパス上にある → back edge
        backEdges.add(`${blockId}→${succId}`);
      } else if (!visited.has(succId)) {
        dfs(succId);
      }
    }

    inStack.delete(blockId);
  }

  // エントリブロック (id=0) から DFS
  if (irFunc.blocks.length > 0) {
    dfs(irFunc.blocks[0].id);
  }

  return backEdges;
}

// ========== トポロジカルソート ==========

// トポロジカル順序: Block ID の昇順
// builder がブロックを bytecode 順に作るので、ID 昇順で:
//   - entry が最初
//   - ループヘッダがループ本体より前
//   - exit がループ本体より後
// これは Stackifier に必要な性質を満たす
function topoSort(irFunc: IRFunction, _backEdges: Set<string>): number[] {
  // 空でないブロックだけを ID 昇順で返す
  return irFunc.blocks
    .filter(b => b.ops.length > 0 || b.phis.length > 0)
    .map(b => b.id)
    .sort((a, b) => a - b);
}

// ========== ループの特定 ==========

// back edge から、ループヘッダ + ループ本体 + 出口ブロックを特定
function findLoops(irFunc: IRFunction, backEdges: Set<string>): LoopInfo[] {
  const loops: LoopInfo[] = [];
  const blockMap = new Map<number, Block>();
  for (const b of irFunc.blocks) blockMap.set(b.id, b);

  for (const edge of backEdges) {
    const [fromStr, toStr] = edge.split("→");
    const backFrom = parseInt(fromStr);
    const header = parseInt(toStr);

    // ループ本体: header から backFrom まで到達可能なブロック集合
    // (back edge を除いた逆方向 BFS)
    const body = new Set<number>();
    body.add(header);
    body.add(backFrom);

    const queue = [backFrom];
    while (queue.length > 0) {
      const bid = queue.shift()!;
      const block = blockMap.get(bid);
      if (!block) continue;
      for (const predId of block.predecessors) {
        if (!body.has(predId) && predId !== header) {
          // header に到達できるか確認 (ループ内のブロックのみ追加)
          body.add(predId);
          queue.push(predId);
        }
      }
    }

    // 出口ブロック: header の successor で body に含まれないもの
    const headerBlock = blockMap.get(header);
    let exitBlock = -1;
    if (headerBlock) {
      for (const succId of headerBlock.successors) {
        if (!body.has(succId)) {
          exitBlock = succId;
          break;
        }
      }
    }

    loops.push({ header, body, backEdgeFrom: backFrom, exitBlock });
  }

  return loops;
}

// ========== 統合 API ==========

export function analyzeCFG(irFunc: IRFunction): CFGAnalysis {
  const backEdges = findBackEdges(irFunc);
  const topoOrder = topoSort(irFunc, backEdges);
  const loops = findLoops(irFunc, backEdges);
  const loopHeaders = new Set(loops.map(l => l.header));

  return { loops, backEdges, topoOrder, loopHeaders };
}
