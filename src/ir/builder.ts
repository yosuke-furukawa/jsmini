// SSA Builder — Bytecode → IR (CFG + SSA) 変換
//
// スタックマシンの bytecode を抽象解釈して SSA 形式の CFG に変換する。
// V8 の Maglev や SpiderMonkey の WarpBuilder と同じ役割。

import type { BytecodeFunction, Instruction } from "../vm/bytecode.js";
import type { FeedbackCollector, WasmNumericType } from "../jit/feedback.js";
import {
  type IRFunction, type Block, type Op, type PhiOp, type IRType,
  createIRFunction, createBlock, createConst, createParam, createPhi, createOp,
} from "./types.js";

export type BuildIROptions = {
  feedback?: FeedbackCollector;
  knownFuncs?: Map<string, BytecodeFunction>;
};

// ========== ブロック境界の特定 ==========

// ジャンプ先と次の命令をブロック境界として特定
function findBlockBoundaries(bytecode: Instruction[]): Set<number> {
  const boundaries = new Set<number>();
  boundaries.add(0); // エントリポイント

  for (let pc = 0; pc < bytecode.length; pc++) {
    const instr = bytecode[pc];
    if (instr.op === "Jump" || instr.op === "JumpIfFalse" || instr.op === "JumpIfTrue") {
      const target = instr.operand!;
      boundaries.add(target);             // ジャンプ先
      boundaries.add(pc + 1);             // fall-through (次の命令)
    }
    if (instr.op === "Return") {
      if (pc + 1 < bytecode.length) {
        boundaries.add(pc + 1);           // return の後ろも新ブロック
      }
    }
  }
  return boundaries;
}

// pc → blockId のマッピング
function buildPCToBlockMap(boundaries: Set<number>, bcLength: number): Map<number, number> {
  const sorted = [...boundaries].sort((a, b) => a - b);
  const map = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) {
    map.set(sorted[i], i);
  }
  return map;
}

// ========== 抽象スタック ==========

// 抽象スタック: スタック位置を SSA 値 ID にマッピング
type AbstractStack = number[]; // Op.id の配列

function cloneStack(stack: AbstractStack): AbstractStack {
  return [...stack];
}

// ========== SSA Builder ==========

export function buildIR(func: BytecodeFunction, options?: BuildIROptions): IRFunction {
  const bytecode = func.bytecode;
  const constants = func.constants;
  const feedback = options?.feedback;
  const knownFuncs = options?.knownFuncs;

  // 型フィードバックからパラメータの型を取得
  const wasmArgTypes: (WasmNumericType | null)[] = [];
  if (feedback) {
    const types = feedback.getWasmArgTypes(func);
    if (types) {
      for (let i = 0; i < func.paramCount; i++) {
        wasmArgTypes.push(i < types.length ? types[i] : null);
      }
    }
  }

  const irFunc = createIRFunction(func.name, func.paramCount);

  // ブロック境界を特定
  const boundaries = findBlockBoundaries(bytecode);
  const pcToBlock = buildPCToBlockMap(boundaries, bytecode.length);
  const sortedBoundaries = [...boundaries].sort((a, b) => a - b);

  // ブロックを作成
  const blocks = new Map<number, Block>();
  for (let i = 0; i < sortedBoundaries.length; i++) {
    const block = createBlock(i);
    blocks.set(i, block);
    irFunc.blocks.push(block);
  }

  // パラメータの Op を作成 (型フィードバックで型を設定)
  // 型が特殊化されてる場合は TypeGuard を挿入
  const paramOps: Op[] = [];
  const guardOps: Op[] = [];
  for (let i = 0; i < func.paramCount; i++) {
    const paramType: IRType = wasmArgTypes[i] === "f64" ? "f64" : wasmArgTypes[i] === "i32" ? "i32" : "any";
    const param = createParam(irFunc, i, paramType);
    paramOps.push(param);

    // 型が推測された場合に TypeGuard を挿入
    if (paramType !== "any") {
      const guard = createOp(irFunc, "TypeGuard", [param.id], paramType);
      guard.guardType = paramType;
      guardOps.push(guard);
    }
  }

  // ローカル変数の SSA 値を追跡
  // locals[slot] = 現在の SSA 値 ID
  const localCount = func.localCount;

  // 各ブロックの入口でのローカル状態
  const blockEntryLocals = new Map<number, (number | undefined)[]>();
  // 各ブロックの入口でのスタック状態
  const blockEntryStacks = new Map<number, AbstractStack>();
  // 各ブロックの出口でのローカル状態
  const blockExitLocals = new Map<number, (number | undefined)[]>();

  // ========== ブロックごとに抽象解釈 ==========

  // Op を Op ID で引けるようにする
  const opById = new Map<number, Op>();

  function registerOp(op: Op): Op {
    opById.set(op.id, op);
    return op;
  }

  // ブロック0 の初期状態
  const initLocals: (number | undefined)[] = new Array(localCount).fill(undefined);
  for (let i = 0; i < func.paramCount; i++) {
    initLocals[i] = paramOps[i].id;
  }
  blockEntryLocals.set(0, initLocals);
  blockEntryStacks.set(0, []);

  // BFS でブロックを処理
  const visited = new Set<number>();
  const queue: number[] = [0];

  while (queue.length > 0) {
    const blockId = queue.shift()!;
    if (visited.has(blockId)) continue;
    visited.add(blockId);

    const block = blocks.get(blockId)!;
    const startPC = sortedBoundaries[blockId];
    const endPC = blockId + 1 < sortedBoundaries.length
      ? sortedBoundaries[blockId + 1]
      : bytecode.length;

    // 初期状態
    let locals = [...(blockEntryLocals.get(blockId) ?? new Array(localCount).fill(undefined))];
    let stack: AbstractStack = cloneStack(blockEntryStacks.get(blockId) ?? []);

    // パラメータ Op + TypeGuard をブロック0に追加
    if (blockId === 0) {
      for (const p of paramOps) { registerOp(p); block.ops.push(p); }
      for (const g of guardOps) { registerOp(g); block.ops.push(g); }
    }

    // 各命令を抽象解釈
    for (let pc = startPC; pc < endPC; pc++) {
      const instr = bytecode[pc];

      switch (instr.op) {
        // 定数ロード
        case "LdaConst": {
          const val = constants[instr.operand!];
          if (typeof val === "number") {
            const op = registerOp(createConst(irFunc, val, Number.isInteger(val) ? "i32" : "f64"));
            block.ops.push(op);
            stack.push(op.id);
          } else {
            // 非数値の定数 (文字列等) → any 型の Const
            const op = registerOp(createOp(irFunc, "Const", [], "any"));
            op.value = val as any;
            block.ops.push(op);
            stack.push(op.id);
          }
          break;
        }
        case "LdaUndefined": {
          const op = registerOp(createOp(irFunc, "Undefined", [], "any"));
          block.ops.push(op);
          stack.push(op.id);
          break;
        }
        case "LdaNull": {
          const op = registerOp(createConst(irFunc, 0, "any"));
          op.value = null as any;
          block.ops.push(op);
          stack.push(op.id);
          break;
        }
        case "LdaTrue": {
          const op = registerOp(createConst(irFunc, 1, "bool"));
          op.value = true;
          block.ops.push(op);
          stack.push(op.id);
          break;
        }
        case "LdaFalse": {
          const op = registerOp(createConst(irFunc, 0, "bool"));
          op.value = false;
          block.ops.push(op);
          stack.push(op.id);
          break;
        }

        // ローカル変数
        case "LdaLocal": {
          const slot = instr.operand!;
          const valId = locals[slot];
          if (valId !== undefined) {
            stack.push(valId);
          } else {
            // 未初期化 → undefined
            const op = registerOp(createOp(irFunc, "Undefined", [], "any"));
            block.ops.push(op);
            stack.push(op.id);
          }
          break;
        }
        case "StaLocal": {
          const slot = instr.operand!;
          locals[slot] = stack[stack.length - 1]; // peek (pop しない)
          break;
        }

        // 算術 (pop 2, push 1)
        case "Add": case "Sub": case "Mul": case "Div": case "Mod": {
          const right = stack.pop()!;
          const left = stack.pop()!;
          const resultType = inferBinType(left, right);
          const op = registerOp(createOp(irFunc, instr.op as any, [left, right], resultType));
          block.ops.push(op);
          stack.push(op.id);
          break;
        }
        case "BitAnd": case "BitOr": case "BitXor":
        case "ShiftLeft": case "ShiftRight": {
          const right = stack.pop()!;
          const left = stack.pop()!;
          const op = registerOp(createOp(irFunc, instr.op as any, [left, right], "i32")); // ビット演算は常に i32
          block.ops.push(op);
          stack.push(op.id);
          break;
        }

        // 単項 (pop 1, push 1)
        case "Negate": case "BitNot": case "LogicalNot": {
          const arg = stack.pop()!;
          const opcode = instr.op === "LogicalNot" ? "Not" : instr.op as any;
          const op = registerOp(createOp(irFunc, opcode, [arg], instr.op === "LogicalNot" ? "bool" : "i32"));
          block.ops.push(op);
          stack.push(op.id);
          break;
        }

        // 比較 (pop 2, push 1)
        case "LessThan": case "GreaterThan": case "LessEqual": case "GreaterEqual":
        case "Equal": case "StrictEqual": case "NotEqual": case "StrictNotEqual": {
          const right = stack.pop()!;
          const left = stack.pop()!;
          const op = registerOp(createOp(irFunc, instr.op as any, [left, right], "bool"));
          block.ops.push(op);
          stack.push(op.id);
          break;
        }

        // 更新
        case "Increment": {
          const arg = stack.pop()!;
          const one = registerOp(createConst(irFunc, 1));
          block.ops.push(one);
          const op = registerOp(createOp(irFunc, "Add", [arg, one.id], "i32"));
          block.ops.push(op);
          stack.push(op.id);
          break;
        }
        case "Decrement": {
          const arg = stack.pop()!;
          const one = registerOp(createConst(irFunc, 1));
          block.ops.push(one);
          const op = registerOp(createOp(irFunc, "Sub", [arg, one.id], "i32"));
          block.ops.push(op);
          stack.push(op.id);
          break;
        }

        // スタック操作
        case "Pop":
          stack.pop();
          break;
        case "Dup":
          stack.push(stack[stack.length - 1]);
          break;

        // 制御フロー
        case "Return": {
          const val = stack.pop()!;
          const op = registerOp(createOp(irFunc, "Return", [val], "any"));
          block.ops.push(op);
          break;
        }
        case "Jump": {
          const targetPC = instr.operand!;
          const targetBlockId = pcToBlock.get(targetPC)!;
          block.successors.push(targetBlockId);
          blocks.get(targetBlockId)!.predecessors.push(blockId);
          const op = registerOp(createOp(irFunc, "Jump", [], "any"));
          block.ops.push(op);
          // ターゲットブロックの入口状態を伝播
          propagateState(targetBlockId, locals, stack);
          if (!visited.has(targetBlockId)) queue.push(targetBlockId);
          break;
        }
        case "JumpIfFalse": case "JumpIfTrue": {
          const cond = stack.pop()!;
          const targetPC = instr.operand!;
          const targetBlockId = pcToBlock.get(targetPC)!;
          const fallBlockId = pcToBlock.get(pc + 1)!;

          if (instr.op === "JumpIfFalse") {
            // false → target, true → fall-through
            block.successors.push(fallBlockId, targetBlockId);
          } else {
            // true → target, false → fall-through
            block.successors.push(targetBlockId, fallBlockId);
          }
          blocks.get(targetBlockId)!.predecessors.push(blockId);
          blocks.get(fallBlockId)!.predecessors.push(blockId);

          const op = registerOp(createOp(irFunc, "Branch", [cond], "any"));
          block.ops.push(op);

          // 両方のターゲットに状態を伝播
          propagateState(targetBlockId, locals, stack);
          propagateState(fallBlockId, locals, stack);
          if (!visited.has(targetBlockId)) queue.push(targetBlockId);
          if (!visited.has(fallBlockId)) queue.push(fallBlockId);
          break;
        }

        // グローバル変数 (関数参照)
        case "LdaGlobal": {
          const name = constants[instr.operand!] as string;
          // 関数参照 → Const として扱い、calleeName を記録
          const op = registerOp(createOp(irFunc, "Const", [], "any"));
          op.value = name as any;
          op.calleeName = name;
          block.ops.push(op);
          stack.push(op.id);
          break;
        }

        // 関数呼び出し
        case "Call": {
          const argc = instr.operand!;
          const calleeId = stack.pop()!; // 関数
          const args: number[] = [];
          for (let j = 0; j < argc; j++) {
            args.unshift(stack.pop()!);
          }
          const calleeOp = opById.get(calleeId);
          const op = registerOp(createOp(irFunc, "Call", [calleeId, ...args], "any"));
          if (calleeOp?.calleeName) op.calleeName = calleeOp.calleeName;
          block.ops.push(op);
          stack.push(op.id);
          break;
        }

        default:
          // 未対応の命令はスキップ (IR 変換対象外)
          break;
      }
    }

    // ブロックの出口でのローカル状態を保存
    blockExitLocals.set(blockId, [...locals]);

    // ブロック末尾がジャンプ/リターンでなければ fall-through
    const lastOp = block.ops[block.ops.length - 1];
    if (lastOp && lastOp.opcode !== "Return" && lastOp.opcode !== "Jump" && lastOp.opcode !== "Branch") {
      if (blockId + 1 < sortedBoundaries.length) {
        const nextBlockId = blockId + 1;
        block.successors.push(nextBlockId);
        blocks.get(nextBlockId)!.predecessors.push(blockId);
        const jmp = registerOp(createOp(irFunc, "Jump", [], "any"));
        block.ops.push(jmp);
        propagateState(nextBlockId, locals, stack);
        if (!visited.has(nextBlockId)) queue.push(nextBlockId);
      }
    }
  }

  // Phi ノードを挿入 (合流点で値が異なる場合)
  insertPhiNodes(irFunc, blockExitLocals, blockEntryLocals, opById);

  // Phi の値で後続ブロックの参照を書き換える
  rewritePhiReferences(irFunc, blockEntryLocals);

  return irFunc;

  // ========== ヘルパー ==========

  // 2つの型から結果の型を推論 (f64 が含まれたら f64 に widening)
  function inferBinType(leftId: number, rightId: number): IRType {
    const left = opById.get(leftId);
    const right = opById.get(rightId);
    if (left?.type === "f64" || right?.type === "f64") return "f64";
    if (left?.type === "i32" && right?.type === "i32") return "i32";
    return "i32"; // default
  }

  function propagateState(targetBlockId: number, locals: (number | undefined)[], stack: AbstractStack): void {
    if (!blockEntryLocals.has(targetBlockId)) {
      blockEntryLocals.set(targetBlockId, [...locals]);
      blockEntryStacks.set(targetBlockId, cloneStack(stack));
    }
    // 既に状態がある場合は合流 → Phi が必要になる可能性
    // (insertPhiNodes で後処理)
  }
}

// ========== Phi ノード挿入 ==========

function insertPhiNodes(
  irFunc: IRFunction,
  blockExitLocals: Map<number, (number | undefined)[]>,
  blockEntryLocals: Map<number, (number | undefined)[]>,
  opById: Map<number, Op>,
): void {
  for (const block of irFunc.blocks) {
    if (block.predecessors.length < 2) continue;

    // 各ローカルスロットについて、前任ブロックの出口での値が異なるか調べる
    const predLocals = block.predecessors
      .map(predId => blockExitLocals.get(predId))
      .filter((l): l is (number | undefined)[] => l !== undefined);

    if (predLocals.length < 2) continue;

    const localCount = predLocals[0].length;
    const entryLocals = blockEntryLocals.get(block.id);

    for (let slot = 0; slot < localCount; slot++) {
      const values = predLocals.map(l => l[slot]);
      // 全部同じなら Phi 不要
      if (values.every(v => v === values[0])) continue;
      // undefined が混じってるのは初期化前 → スキップ
      if (values.some(v => v === undefined)) continue;

      const phi = createPhi(irFunc, "any");
      for (let i = 0; i < block.predecessors.length; i++) {
        phi.inputs.push([block.predecessors[i], values[i]!]);
      }
      // Phi がどのローカルスロットの値を置き換えるか記録
      (phi as any).__slot = slot;
      // entry locals の対応する値を Phi の値に更新
      if (entryLocals && entryLocals[slot] !== undefined) {
        (phi as any).__replacedValue = entryLocals[slot];
      }
      block.phis.push(phi);
      opById.set(phi.id, phi);
    }
  }
}

// Phi の値で、合流ブロックとその後続ブロック内の参照を書き換える
function rewritePhiReferences(
  irFunc: IRFunction,
  blockEntryLocals: Map<number, (number | undefined)[]>,
): void {
  for (const block of irFunc.blocks) {
    if (block.phis.length === 0) continue;

    // このブロックの Phi が置き換える値のマップ: oldId → phiId
    const replaceMap = new Map<number, number>();
    for (const phi of block.phis) {
      const replacedVal = (phi as any).__replacedValue as number | undefined;
      if (replacedVal !== undefined) {
        replaceMap.set(replacedVal, phi.id);
      }
    }

    if (replaceMap.size === 0) continue;

    // このブロック内の ops の引数を書き換え
    for (const op of block.ops) {
      op.args = op.args.map(a => replaceMap.get(a) ?? a);
    }

    // 後続ブロック (successors) 内の ops も書き換え
    // (ループの場合、B1 → B2 → B1 で B2 が B1 の Phi を参照すべき)
    const visited = new Set<number>();
    const queue = [...block.successors];
    while (queue.length > 0) {
      const succId = queue.shift()!;
      if (visited.has(succId)) continue;
      if (succId === block.id) continue; // 自分自身はスキップ (既に処理済み)
      visited.add(succId);

      const succBlock = irFunc.blocks.find(b => b.id === succId);
      if (!succBlock) continue;

      for (const op of succBlock.ops) {
        op.args = op.args.map(a => replaceMap.get(a) ?? a);
      }
      // Phi の inputs も書き換え
      for (const phi of succBlock.phis) {
        phi.inputs = phi.inputs.map(([bid, vid]) => [bid, replaceMap.get(vid) ?? vid]);
      }

      // さらに後続へ (ただし Phi があるブロックで止まる — 別の Phi で置き換わるため)
      for (const nextId of succBlock.successors) {
        const nextBlock = irFunc.blocks.find(b => b.id === nextId);
        if (nextBlock && nextBlock.phis.length === 0) {
          queue.push(nextId);
        }
      }
    }
  }
}
