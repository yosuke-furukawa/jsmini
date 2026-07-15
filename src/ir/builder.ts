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

  const localCount = func.localCount;
  const opById = new Map<number, Op>();
  function registerOp(op: Op): Op { opById.set(op.id, op); return op; }

  // 2つの型から結果の型を推論
  function inferBinType(leftId: number, rightId: number): IRType {
    const l = opById.get(leftId), r = opById.get(rightId);
    if (l?.type === "f64" || r?.type === "f64") return "f64";
    if (l?.type === "i32" && r?.type === "i32") return "i32";
    return "i32";
  }

  // ======== パス 1: ブロック構造 + エッジ構築 + 合流点 Phi 予約 ========

  // bytecode を走査してブロック間のエッジを構築 (ops は生成しない)
  const blockEdges = new Map<number, { successors: number[]; predecessors: number[] }>();
  for (const [, b] of blocks) blockEdges.set(b.id, { successors: [], predecessors: [] });

  for (let blockId = 0; blockId < sortedBoundaries.length; blockId++) {
    const startPC = sortedBoundaries[blockId];
    const endPC = blockId + 1 < sortedBoundaries.length ? sortedBoundaries[blockId + 1] : bytecode.length;
    for (let pc = startPC; pc < endPC; pc++) {
      const instr = bytecode[pc];
      if (instr.op === "Jump") {
        const t = pcToBlock.get(instr.operand!)!;
        blockEdges.get(blockId)!.successors.push(t);
        blockEdges.get(t)!.predecessors.push(blockId);
      } else if (instr.op === "JumpIfFalse" || instr.op === "JumpIfTrue") {
        const t = pcToBlock.get(instr.operand!)!;
        const f = pcToBlock.get(pc + 1)!;
        if (instr.op === "JumpIfFalse") {
          blockEdges.get(blockId)!.successors.push(f, t);
        } else {
          blockEdges.get(blockId)!.successors.push(t, f);
        }
        blockEdges.get(t)!.predecessors.push(blockId);
        blockEdges.get(f)!.predecessors.push(blockId);
      } else if (instr.op === "Return") {
        // no successor
      }
    }
    // fall-through: 末尾が制御フロー命令でなければ次のブロックへ
    const lastInstr = bytecode[endPC - 1];
    if (lastInstr && lastInstr.op !== "Jump" && lastInstr.op !== "JumpIfFalse" && lastInstr.op !== "JumpIfTrue" && lastInstr.op !== "Return") {
      if (blockId + 1 < sortedBoundaries.length) {
        blockEdges.get(blockId)!.successors.push(blockId + 1);
        blockEdges.get(blockId + 1)!.predecessors.push(blockId);
      }
    }
  }

  // エッジをブロックに反映
  for (const [id, edges] of blockEdges) {
    blocks.get(id)!.successors = edges.successors;
    blocks.get(id)!.predecessors = edges.predecessors;
  }

  // 合流点 (predecessors >= 2) に Phi を予約
  // phiMap: blockId → { slot → phiOp }
  const phiMap = new Map<number, Map<number, PhiOp>>();
  for (const [id, edges] of blockEdges) {
    if (edges.predecessors.length >= 2) {
      const phis = new Map<number, PhiOp>();
      for (let slot = 0; slot < localCount; slot++) {
        const phi = createPhi(irFunc, "any");
        registerOp(phi);
        phis.set(slot, phi);
        blocks.get(id)!.phis.push(phi);
      }
      phiMap.set(id, phis);
    }
  }

  // ======== パス 2: 抽象解釈 (Phi ID を使う) ========

  const blockEntryStacks = new Map<number, AbstractStack>();
  const blockExitLocals = new Map<number, (number | undefined)[]>();
  // 合流点 (preds >= 2) の「スタック上の値」用 Phi。
  // `a || b` / `a && b` / 三項演算子は分岐した値をスタックに乗せたまま
  // 合流するので、locals と同様に Phi で受けないと片方の辺の値が消える
  // (実害: || の右辺が丸ごと IR から消えて JIT が誤コンパイルしていた)
  const stackPhis = new Map<number, PhiOp[]>();          // 合流 blockId → スタック slot ごとの Phi
  const stackContribs = new Map<number, Map<number, AbstractStack>>(); // 合流 blockId → predId → そのエッジのスタック

  // ブロック0 の初期状態
  const initLocals: (number | undefined)[] = new Array(localCount).fill(undefined);
  for (let i = 0; i < func.paramCount; i++) initLocals[i] = paramOps[i].id;

  const blockEntryLocals = new Map<number, (number | undefined)[]>();
  blockEntryLocals.set(0, initLocals);
  blockEntryStacks.set(0, []);

  const visited = new Set<number>();
  const queue: number[] = [0];

  while (queue.length > 0) {
    const blockId = queue.shift()!;
    if (visited.has(blockId)) continue;
    visited.add(blockId);

    const block = blocks.get(blockId)!;
    const startPC = sortedBoundaries[blockId];
    const endPC = blockId + 1 < sortedBoundaries.length ? sortedBoundaries[blockId + 1] : bytecode.length;

    // 初期ローカル: Phi があるブロックは Phi ID で上書き
    let locals: (number | undefined)[];
    if (phiMap.has(blockId)) {
      locals = [...(blockEntryLocals.get(blockId) ?? new Array(localCount).fill(undefined))];
      const phis = phiMap.get(blockId)!;
      for (const [slot, phi] of phis) {
        if (locals[slot] !== undefined) {
          locals[slot] = phi.id;  // ★ Phi ID で上書き
        }
      }
    } else {
      locals = [...(blockEntryLocals.get(blockId) ?? new Array(localCount).fill(undefined))];
    }
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
        case "LdaConst": {
          const val = constants[instr.operand!];
          if (typeof val === "number") {
            const op = registerOp(createConst(irFunc, val, Number.isInteger(val) ? "i32" : "f64"));
            block.ops.push(op); stack.push(op.id);
          } else {
            const op = registerOp(createOp(irFunc, "Const", [], "any"));
            op.value = val as any; block.ops.push(op); stack.push(op.id);
          }
          break;
        }
        case "LdaUndefined": { const op = registerOp(createOp(irFunc, "Undefined", [], "any")); block.ops.push(op); stack.push(op.id); break; }
        case "LdaNull": { const op = registerOp(createConst(irFunc, 0, "any")); op.value = null as any; block.ops.push(op); stack.push(op.id); break; }
        case "LdaTrue": { const op = registerOp(createConst(irFunc, 1, "bool")); op.value = true; block.ops.push(op); stack.push(op.id); break; }
        case "LdaFalse": { const op = registerOp(createConst(irFunc, 0, "bool")); op.value = false; block.ops.push(op); stack.push(op.id); break; }
        case "LdaLocal": {
          const slot = instr.operand!;
          const valId = locals[slot];
          if (valId !== undefined) { stack.push(valId); }
          else { const op = registerOp(createOp(irFunc, "Undefined", [], "any")); block.ops.push(op); stack.push(op.id); }
          break;
        }
        case "StaLocal": { locals[instr.operand!] = stack[stack.length - 1]; break; }
        case "Add": case "Sub": case "Mul": case "Div": case "Mod": {
          const r = stack.pop()!, l = stack.pop()!;
          const op = registerOp(createOp(irFunc, instr.op as any, [l, r], inferBinType(l, r)));
          block.ops.push(op); stack.push(op.id); break;
        }
        case "BitAnd": case "BitOr": case "BitXor": case "ShiftLeft": case "ShiftRight": {
          const r = stack.pop()!, l = stack.pop()!;
          const op = registerOp(createOp(irFunc, instr.op as any, [l, r], "i32"));
          block.ops.push(op); stack.push(op.id); break;
        }
        case "Negate": case "BitNot": case "LogicalNot": {
          const a = stack.pop()!;
          const opc = instr.op === "LogicalNot" ? "Not" : instr.op as any;
          const op = registerOp(createOp(irFunc, opc, [a], instr.op === "LogicalNot" ? "bool" : "i32"));
          block.ops.push(op); stack.push(op.id); break;
        }
        case "LessThan": case "GreaterThan": case "LessEqual": case "GreaterEqual":
        case "Equal": case "StrictEqual": case "NotEqual": case "StrictNotEqual": {
          const r = stack.pop()!, l = stack.pop()!;
          const op = registerOp(createOp(irFunc, instr.op as any, [l, r], "bool"));
          block.ops.push(op); stack.push(op.id); break;
        }
        case "Increment": {
          const a = stack.pop()!; const one = registerOp(createConst(irFunc, 1)); block.ops.push(one);
          const op = registerOp(createOp(irFunc, "Add", [a, one.id], "i32")); block.ops.push(op); stack.push(op.id); break;
        }
        case "Decrement": {
          const a = stack.pop()!; const one = registerOp(createConst(irFunc, 1)); block.ops.push(one);
          const op = registerOp(createOp(irFunc, "Sub", [a, one.id], "i32")); block.ops.push(op); stack.push(op.id); break;
        }
        case "Pop": stack.pop(); break;
        case "Dup": stack.push(stack[stack.length - 1]); break;
        case "Return": {
          const val = stack.pop()!;
          block.ops.push(registerOp(createOp(irFunc, "Return", [val], "any"))); break;
        }
        case "Jump": {
          block.ops.push(registerOp(createOp(irFunc, "Jump", [], "any")));
          const t = pcToBlock.get(instr.operand!)!;
          propagate(t, locals, stack, blockId); if (!visited.has(t)) queue.push(t);
          break;
        }
        case "JumpIfFalse": case "JumpIfTrue": {
          const cond = stack.pop()!;
          block.ops.push(registerOp(createOp(irFunc, "Branch", [cond], "any")));
          const t = pcToBlock.get(instr.operand!)!, f = pcToBlock.get(pc + 1)!;
          propagate(t, locals, stack, blockId); propagate(f, locals, stack, blockId);
          if (!visited.has(t)) queue.push(t); if (!visited.has(f)) queue.push(f);
          break;
        }
        case "LdaGlobal": {
          const name = constants[instr.operand!] as string;
          // knownFuncs にある関数参照 → Const + calleeName (Inlining 用)
          if (knownFuncs?.has(name)) {
            const op = registerOp(createOp(irFunc, "Const", [], "any"));
            op.value = name as any; op.calleeName = name;
            block.ops.push(op); stack.push(op.id);
          } else {
            // グローバル変数の読み込み
            const op = registerOp(createOp(irFunc, "LoadGlobal", [], "any"));
            op.globalName = name;
            block.ops.push(op); stack.push(op.id);
          }
          break;
        }
        case "StaGlobal":
        case "StaGlobalStrict": {
          const name = constants[instr.operand!] as string;
          const val = stack[stack.length - 1]; // peek
          const op = registerOp(createOp(irFunc, "StoreGlobal", [val], "any"));
          op.globalName = name;
          block.ops.push(op);
          break;
        }
        case "LdaUpvalue": {
          const uvIndex = instr.operand!;
          const op = registerOp(createOp(irFunc, "LoadUpvalue", [], "any"));
          op.index = uvIndex;
          block.ops.push(op); stack.push(op.id);
          break;
        }
        case "StaUpvalue": {
          const uvIndex = instr.operand!;
          const val = stack[stack.length - 1]; // peek
          const op = registerOp(createOp(irFunc, "StoreUpvalue", [val], "any"));
          op.index = uvIndex;
          block.ops.push(op);
          break;
        }
        case "Call": {
          const argc = instr.operand!;
          const calleeId = stack.pop()!;
          const args: number[] = [];
          for (let j = 0; j < argc; j++) args.unshift(stack.pop()!);
          const calleeOp = opById.get(calleeId);
          const op = registerOp(createOp(irFunc, "Call", [calleeId, ...args], "any"));
          if (calleeOp?.calleeName) op.calleeName = calleeOp.calleeName;
          else if (calleeOp?.globalName) op.calleeName = calleeOp.globalName;
          block.ops.push(op); stack.push(op.id); break;
        }
        // 配列アクセス
        case "GetPropertyComputed": {
          const index = stack.pop()!;
          const arr = stack.pop()!;
          const op = registerOp(createOp(irFunc, "ArrayGet", [arr, index], "i32"));
          block.ops.push(op); stack.push(op.id); break;
        }
        case "SetPropertyComputed": {
          // VM は [arr, idx, value] を全部 pop して value を push する。
          // 旧実装は arr を peek で残しており、連鎖代入 (lastX = x[i] = v) で
          // 後続の Sta が value でなく arr (配列!) を拾う desync だった
          const value = stack.pop()!;
          const index = stack.pop()!;
          const arr = stack.pop()!;
          const op = registerOp(createOp(irFunc, "ArraySet", [arr, index, value], "any"));
          block.ops.push(op);
          stack.push(value);
          break;
        }
        // プロパティアクセス
        case "GetProperty": {
          const obj = stack.pop()!;
          const name = constants[instr.operand!] as string;
          if (name === "length") {
            const op = registerOp(createOp(irFunc, "ArrayLength", [obj], "i32"));
            block.ops.push(op); stack.push(op.id);
          } else {
            // named property: obj.name
            const op = registerOp(createOp(irFunc, "LoadProperty", [obj], "i32"));
            op.globalName = name;
            // Math.X 検出: 後続の Call が Math.X として lowering できるよう calleeName をタグ
            const objOp = opById.get(obj);
            if (objOp?.opcode === "LoadGlobal" && objOp.globalName === "Math") {
              op.calleeName = "Math." + name;
            }
            block.ops.push(op); stack.push(op.id);
          }
          break;
        }
        case "SetPropertyAssign": {
          // スタック: [value, obj] → obj.name = value
          const obj = stack.pop()!;
          const value = stack.pop()!;
          const name = constants[instr.operand!] as string;
          const op = registerOp(createOp(irFunc, "StoreProperty", [obj, value], "any"));
          op.globalName = name;
          block.ops.push(op);
          // SetPropertyAssign は value をスタックに残す
          stack.push(value);
          break;
        }
        case "CallMethod": {
          const argc = instr.operand!;
          // スタック: [args..., thisObj(Dup), methodRef(GetProperty)]
          const methodRef = stack.pop()!; // GetProperty の結果 (LoadProperty op)
          const thisObj = stack.pop()!;    // Dup の結果 (thisObj)
          const args: number[] = [];
          for (let j = 0; j < argc; j++) args.unshift(stack.pop()!);
          // methodRef から calleeName を取得 (Math.X は LoadProperty で
          // calleeName="Math.sin" 等がタグ付け済み。それを優先する)
          const methodOp = opById.get(methodRef);
          // arr.push(x) → ArrayPush(arr, x)。1 引数の push のみ対応。
          if (methodOp?.globalName === "push" && !methodOp?.calleeName && argc === 1) {
            const op = registerOp(createOp(irFunc, "ArrayPush", [thisObj, args[0]], "any"));
            block.ops.push(op);
            // push は新しい length を返す。簡単のため length を別途読む形にせず、
            // ArrayLength を後続で読めるよう、ここでは push の戻り値として
            // ArrayLength(arr) を積む (push の戻り値が使われるケースは稀)
            const lenOp = registerOp(createOp(irFunc, "ArrayLength", [thisObj], "i32"));
            block.ops.push(lenOp); stack.push(lenOp.id);
            break;
          }
          const isMathCall = methodOp?.calleeName?.startsWith("Math.");
          const methodName = methodOp?.calleeName ?? methodOp?.globalName;
          // Math.X は this を使わないので thisObj を落として通常の Call 形式にする
          const callArgs = isMathCall
            ? [methodRef, ...args]
            : [methodRef, ...args, thisObj];
          const op = registerOp(createOp(irFunc, "Call", callArgs, "any"));
          if (methodName) op.calleeName = methodName;
          block.ops.push(op); stack.push(op.id); break;
        }
        case "Construct": {
          const argc = instr.operand!;
          const ctorRef = stack.pop()!; // コンストラクタ参照
          const args: number[] = [];
          for (let j = 0; j < argc; j++) args.unshift(stack.pop()!);
          // new Array(n) → AllocArray(n): 関数内で確保する固定長 WasmGC array。
          // 1 引数 (長さ) の形のみ対応。それ以外は通常の Construct にフォールバック。
          const ctorOpEarly = opById.get(ctorRef);
          if (ctorOpEarly?.opcode === "LoadGlobal" && ctorOpEarly.globalName === "Array" && argc === 1) {
            const allocArr = registerOp(createOp(irFunc, "AllocArray", [args[0]], "any"));
            block.ops.push(allocArr);
            stack.push(allocArr.id);
            break;
          }
          // Alloc: オブジェクト領域確保
          const alloc = registerOp(createOp(irFunc, "Alloc", [], "i32"));
          block.ops.push(alloc);
          // Call: コンストラクタ呼び出し (args + this=alloc)
          const ctorOp = opById.get(ctorRef);
          const call = registerOp(createOp(irFunc, "Call", [ctorRef, ...args, alloc.id], "any"));
          if (ctorOp?.calleeName) call.calleeName = ctorOp.calleeName;
          block.ops.push(call);
          // Construct の結果は alloc (base address)
          stack.push(alloc.id);
          break;
        }
        case "CreateArray": {
          // [] (空配列) → AllocGrowableArray。動的成長対応。
          // [a, b, c] (要素あり) は未対応 (要素のプッシュが要る) なので、
          // 0 要素のみ growable array に。N>0 は AllocGrowableArray + ArrayPush に展開。
          const n = instr.operand!;
          const elems: number[] = [];
          for (let j = 0; j < n; j++) elems.unshift(stack.pop()!);
          const arr = registerOp(createOp(irFunc, "AllocGrowableArray", [], "any"));
          block.ops.push(arr);
          // 初期要素を push で詰める
          for (const e of elems) {
            const p = registerOp(createOp(irFunc, "ArrayPush", [arr.id, e], "any"));
            block.ops.push(p);
          }
          stack.push(arr.id);
          break;
        }
        case "LoadThis": {
          const op = registerOp(createOp(irFunc, "LoadThis", [], "i32"));
          block.ops.push(op); stack.push(op.id);
          break;
        }
        case "Await": {
          const value = stack.pop()!;
          // Await は JSPI の import call として表現
          // call $__await(value) → suspend → resume → 結果値
          const op = registerOp(createOp(irFunc, "Call", [value], "i32"));
          op.calleeName = "__await";
          block.ops.push(op); stack.push(op.id);
          break;
        }
        default: break;
      }
    }

    // 出口ローカルを保存
    blockExitLocals.set(blockId, [...locals]);

    // fall-through
    const lastOp = block.ops[block.ops.length - 1];
    if (!lastOp || (lastOp.opcode !== "Return" && lastOp.opcode !== "Jump" && lastOp.opcode !== "Branch")) {
      if (blockId + 1 < sortedBoundaries.length) {
        block.ops.push(registerOp(createOp(irFunc, "Jump", [], "any")));
        propagate(blockId + 1, locals, stack, blockId);
        if (!visited.has(blockId + 1)) queue.push(blockId + 1);
      }
    }
  }

  // ======== パス 3a: 全 Phi の inputs を先に埋める ========
  // (collapse を「埋めながら」やると、先に collapse した Phi の置換が
  //  まだ inputs 未充填の後続 Phi に届かず、stale な値を拾って dangling
  //  参照になる。例: 2 つ目のループの param 参照が消えた Phi を指す。
  //  → 充填と collapse を分離する)
  for (const [blockId, phis] of phiMap) {
    const preds = blockEdges.get(blockId)!.predecessors;
    for (const [slot, phi] of phis) {
      phi.inputs = [];
      for (const predId of preds) {
        const exitLocals = blockExitLocals.get(predId);
        const val = exitLocals ? exitLocals[slot] : undefined;
        if (val !== undefined) {
          phi.inputs.push([predId, val]);
        }
      }
    }
  }

  // ======== パス 3a': スタック Phi の inputs を埋める ========
  // 各エッジ通過時のスタック (stackContribs) から slot ごとに接続。
  // 片方の pred からしか値が来ない場合 (もう一方は空スタックで到達) は
  // 3b の collapse (inputs < 2) がその値に畳む
  for (const [blockId, phis] of stackPhis) {
    const contribs = stackContribs.get(blockId)!;
    for (let i = 0; i < phis.length; i++) {
      const phi = phis[i];
      phi.inputs = [];
      for (const [predId, st] of contribs) {
        if (st[i] !== undefined) phi.inputs.push([predId, st[i]]);
      }
    }
  }

  // ======== パス 3b: 不要な Phi を collapse (fixpoint) ========
  // 全 inputs が充填済みなので、置換は全 Phi/Op に正しく伝播する。
  // chained collapse (Phi → Phi → 値) に対応するため変化が無くなるまで回す。
  const allPhiList: PhiOp[] = [];
  for (const [, phis] of phiMap) for (const [, phi] of phis) allPhiList.push(phi);
  for (const [, phis] of stackPhis) for (const phi of phis) allPhiList.push(phi);
  let collapsed = true;
  while (collapsed) {
    collapsed = false;
    for (const phi of allPhiList) {
      {
        if (phi.inputs.length === 0) continue; // 既に collapse 済み
        const nonSelfInputs = phi.inputs.filter(([, vid]) => vid !== phi.id);
        const allSame = nonSelfInputs.length > 0 && nonSelfInputs.every(([, vid]) => vid === nonSelfInputs[0][1]);
        if (allSame || phi.inputs.length < 2) {
          const replacement = nonSelfInputs.length > 0 ? nonSelfInputs[0][1] : undefined;
          if (replacement !== undefined) {
            for (const b of irFunc.blocks) {
              for (const op of b.ops) {
                op.args = op.args.map(a => a === phi.id ? replacement : a);
              }
              for (const p of b.phis) {
                p.inputs = p.inputs.map(([bid, vid]) => [bid, vid === phi.id ? replacement : vid]);
              }
            }
          }
          phi.inputs = [];
          collapsed = true;
        }
      }
    }
  }

  // 空の Phi を除去
  for (const block of irFunc.blocks) {
    block.phis = block.phis.filter(p => p.inputs.length >= 2);
  }

  return irFunc;

  function propagate(targetBlockId: number, locals: (number | undefined)[], stack: AbstractStack, fromBlockId: number): void {
    const preds = blockEdges.get(targetBlockId)?.predecessors ?? [];
    // スタック深さがエッジ間で食い違う合流は表現できない (slot がずれて
    // 配列とスカラーが混ざる等)。検出したら IR を poisoned にして
    // compile 側で拒否する (VM フォールバック)
    const prevContrib = stackContribs.get(targetBlockId);
    if (prevContrib) {
      for (const [, st] of prevContrib) {
        if (st.length !== stack.length) {
          (irFunc as { stackMismatch?: boolean }).stackMismatch = true;
        }
        break;
      }
    }
    const existingEntry = blockEntryStacks.get(targetBlockId);
    if (existingEntry && existingEntry.length !== stack.length && preds.length >= 2) {
      (irFunc as { stackMismatch?: boolean }).stackMismatch = true;
    }
    if (preds.length >= 2 && stack.length > 0) {
      // 合流点にスタック値を持ち込む → slot ごとに Phi で受ける
      if (!stackContribs.has(targetBlockId)) stackContribs.set(targetBlockId, new Map());
      stackContribs.get(targetBlockId)!.set(fromBlockId, cloneStack(stack));
      if (!stackPhis.has(targetBlockId)) {
        const phis = stack.map(() => {
          const p = createPhi(irFunc, "any");
          registerOp(p);
          blocks.get(targetBlockId)!.phis.push(p);
          return p;
        });
        stackPhis.set(targetBlockId, phis);
        blockEntryStacks.set(targetBlockId, phis.map(p => p.id));
      }
    } else if (!blockEntryStacks.has(targetBlockId)) {
      blockEntryStacks.set(targetBlockId, cloneStack(stack));
    }
    if (!blockEntryLocals.has(targetBlockId)) {
      blockEntryLocals.set(targetBlockId, [...locals]);
    }
  }
}

