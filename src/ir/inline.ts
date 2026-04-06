// Inlining パス — Call ノードを呼び出し先の IR で展開
//
// SSA だから安全にコピペできる:
//   1. 呼び出し先の IR を構築
//   2. Op ID を振り直して衝突回避
//   3. Param → 引数に置換
//   4. Return → Call の結果に置換
//   5. Call ノードを削除

import type { BytecodeFunction } from "../vm/bytecode.js";
import type { IRFunction, Block, Op, IRType } from "./types.js";
import { createBlock, createOp } from "./types.js";
import { buildIR, type BuildIROptions } from "./builder.js";

export type InlineOptions = {
  knownFuncs: Map<string, BytecodeFunction>;
  maxInlineSize?: number;   // bytecode 命令数の上限 (default: 30)
  maxInlineDepth?: number;  // Inlining の深さ上限 (default: 3)
  buildIROptions?: BuildIROptions;
};

export function inlinePass(irFunc: IRFunction, options: InlineOptions): boolean {
  const { knownFuncs, buildIROptions } = options;
  const maxSize = options.maxInlineSize ?? 30;
  let changed = false;

  for (const block of irFunc.blocks) {
    for (let i = 0; i < block.ops.length; i++) {
      const op = block.ops[i];
      if (op.opcode !== "Call") continue;
      if (!op.calleeName) continue;

      // 再帰呼び出しはスキップ
      if (op.calleeName === irFunc.name) continue;

      // 呼び出し先を取得
      const calleeBC = knownFuncs.get(op.calleeName);
      if (!calleeBC) continue;

      // サイズチェック
      if (calleeBC.bytecode.length > maxSize) continue;

      // 呼び出し先の IR を構築
      const calleeIR = buildIR(calleeBC, buildIROptions);

      // Inlining 実行
      const result = performInline(irFunc, block, i, op, calleeIR);
      if (result) {
        changed = true;
        i--; // ブロックが変わったので再走査
      }
    }
  }

  return changed;
}

function performInline(
  callerFunc: IRFunction,
  callerBlock: Block,
  callOpIndex: number,
  callOp: Op,
  calleeIR: IRFunction,
): boolean {
  // Call の引数: args[0] = callee ref, args[1..] = 実引数
  const callArgs = callOp.args.slice(1);

  // ID の振り直しマップ: 呼び出し先の Op ID → 呼び出し元の新 ID
  const idMap = new Map<number, number>();

  // 呼び出し先が単一ブロック + Return で終わるシンプルなケースのみ対応
  // (複数ブロック/制御フローの Inlining は複雑なので後回し)
  const calleeBlocks = calleeIR.blocks.filter(b => b.ops.length > 0);
  if (calleeBlocks.length !== 1) return false;

  const calleeBlock = calleeBlocks[0];

  // Return を見つける
  const returnOp = calleeBlock.ops.find(op => op.opcode === "Return");
  if (!returnOp) return false;

  // 新しい Op をコピー (Param → 引数置換、Return → 結果置換)
  const newOps: Op[] = [];

  for (const op of calleeBlock.ops) {
    if (op.opcode === "Param") {
      // Param → 対応する引数の ID にマッピング
      const argIdx = op.index ?? 0;
      if (argIdx < callArgs.length) {
        idMap.set(op.id, callArgs[argIdx]);
      }
      continue;
    }

    if (op.opcode === "TypeGuard") {
      // TypeGuard は Inlining 先では不要 (呼び出し元が型を保証)
      // TypeGuard の引数をそのまま通す
      const mappedArg = idMap.get(op.args[0]) ?? op.args[0];
      idMap.set(op.id, mappedArg);
      continue;
    }

    if (op.opcode === "Return") {
      // Return の値が Call の結果になる
      const returnValId = idMap.get(op.args[0]) ?? op.args[0];
      idMap.set(callOp.id, returnValId);
      continue;
    }

    // 通常の Op: ID を振り直してコピー
    const newId = callerFunc.nextOpId++;
    idMap.set(op.id, newId);

    const newArgs = op.args.map(argId => idMap.get(argId) ?? argId);
    const newOp: Op = {
      id: newId,
      opcode: op.opcode,
      args: newArgs,
      type: op.type,
      value: op.value,
      index: op.index,
      guardType: op.guardType,
      calleeName: op.calleeName,
      globalName: op.globalName,
    };
    newOps.push(newOp);
  }

  // Call ノードの位置に、Inlining した Op を挿入
  // Call ノードの前にある callee の Const (LdaGlobal) も削除
  const calleeConstIndex = callerBlock.ops.findIndex(op =>
    op.id === callOp.args[0] && op.opcode === "Const" && op.calleeName
  );

  // Call を Inlining した Op で置換
  const opsToRemove = new Set<number>();
  opsToRemove.add(callOp.id);
  if (calleeConstIndex >= 0) opsToRemove.add(callerBlock.ops[calleeConstIndex].id);

  const newBlockOps: Op[] = [];
  for (const op of callerBlock.ops) {
    if (opsToRemove.has(op.id)) {
      if (op.id === callOp.id) {
        // Call の位置に Inlining した Op を挿入
        newBlockOps.push(...newOps);

        // Call を参照してた全 Op の引数を、Inlining 結果に書き換え
        const resultId = idMap.get(callOp.id);
        if (resultId !== undefined) {
          // callerFunc 全体の Op + Phi を書き換え
          for (const b of callerFunc.blocks) {
            for (const op of b.ops) {
              op.args = op.args.map(a => a === callOp.id ? resultId : a);
            }
            for (const phi of b.phis) {
              phi.inputs = phi.inputs.map(([bid, vid]) => [bid, vid === callOp.id ? resultId : vid]);
            }
          }
          for (const newOp of newBlockOps) {
            newOp.args = newOp.args.map(a => a === callOp.id ? resultId : a);
          }
        }
      }
      continue;
    }
    newBlockOps.push(op);
  }

  callerBlock.ops = newBlockOps;
  return true;
}
