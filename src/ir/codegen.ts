// IR → Wasm コード生成
//
// 最適化済み SSA IR を Wasm バイナリ (function body) に変換する。
// CFG → Wasm の structured control flow 変換を行う。

import type { IRFunction, Block, Op, PhiOp, IRType } from "./types.js";
import { isPhi } from "./types.js";
import { WasmBuilder, WASM_OP, WASM_TYPE, i32ToLEB128, f64ToBytes } from "../jit/wasm-builder.js";

const WASM_VOID = 0x40; // void block type
import { analyzeCFG, type CFGAnalysis, type LoopInfo } from "./loop-analysis.js";

// ========== Wasm Codegen ==========

export interface IRCodegenResult {
  wasmBytes: Uint8Array;
  funcIndex: number;
}

export function codegenIR(irFunc: IRFunction): { body: number[]; extraLocals: number } {
  const body: number[] = [];

  // Op ID → Wasm local index のマッピング
  // Wasm locals: [params..., phi locals..., temp locals...]
  const opToLocal = new Map<number, number>();
  let nextLocal = irFunc.paramCount;

  // パラメータ → local 0, 1, ...
  for (const block of irFunc.blocks) {
    for (const op of block.ops) {
      if (op.opcode === "Param" && op.index !== undefined) {
        opToLocal.set(op.id, op.index);
      }
    }
  }

  // Phi ノード → Wasm local に割り当て
  for (const block of irFunc.blocks) {
    for (const phi of block.phis) {
      opToLocal.set(phi.id, nextLocal++);
    }
  }

  // 中間値で複数回使われるもの → local に格納
  const useCount = computeUseCount(irFunc);
  const needsLocal = new Set<number>();
  for (const [id, count] of useCount) {
    if (count > 1 && !opToLocal.has(id)) {
      needsLocal.add(id);
      opToLocal.set(id, nextLocal++);
    }
  }

  // Phi の入力値も local に格納する必要がある (back edge の local.set で使うため)
  for (const block of irFunc.blocks) {
    for (const phi of block.phis) {
      for (const [, valueId] of phi.inputs) {
        if (!opToLocal.has(valueId)) {
          needsLocal.add(valueId);
          opToLocal.set(valueId, nextLocal++);
        }
      }
    }
  }

  const extraLocals = nextLocal - irFunc.paramCount;

  // Op を id で引けるテーブル
  const opById = new Map<number, Op>();
  for (const block of irFunc.blocks) {
    for (const phi of block.phis) opById.set(phi.id, phi);
    for (const op of block.ops) opById.set(op.id, op);
  }

  const blockMap = new Map<number, Block>();
  for (const b of irFunc.blocks) blockMap.set(b.id, b);

  // ========== Stackifier: CFG → Wasm structured control flow ==========
  const cfg = analyzeCFG(irFunc);

  // Phi の入力を書き込む: predecessor ブロックの末尾で local.set
  // { blockId → [{ phiLocal, valueId }] }
  const phiWrites = new Map<number, { phiLocal: number; valueId: number }[]>();
  for (const block of irFunc.blocks) {
    for (const phi of block.phis) {
      const phiLocal = opToLocal.get(phi.id);
      if (phiLocal === undefined) continue;
      for (const [predId, valueId] of phi.inputs) {
        if (!phiWrites.has(predId)) phiWrites.set(predId, []);
        phiWrites.get(predId)!.push({ phiLocal, valueId });
      }
    }
  }

  // Wasm の control flow スタック: 各エントリは { kind, targetBlockId }
  // br N は N 番目のエントリにジャンプ
  const controlStack: { kind: "block" | "loop"; targetBlockId: number }[] = [];

  // トポロジカル順にブロックを処理
  for (const blockId of cfg.topoOrder) {
    const block = blockMap.get(blockId);
    if (!block) continue;

    // ループヘッダ: block $exit + loop $continue を開始
    const loopInfo = cfg.loops.find(l => l.header === blockId);
    if (loopInfo) {
      // block $exit — forward edge (条件 false) で脱出
      body.push(WASM_OP.block, WASM_VOID);
      controlStack.push({ kind: "block", targetBlockId: loopInfo.exitBlock });
      // loop $continue — back edge で先頭に戻る
      body.push(WASM_OP.loop, WASM_VOID);
      controlStack.push({ kind: "loop", targetBlockId: blockId });
    }

    // 通常の命令を出力
    for (const op of block.ops) {
      if (op.opcode === "Branch") {
        // 条件分岐: Branch の条件を出力
        emitLoadValue(op.args[0], body, opToLocal);
        // Phi の値を書き込み (fall-through = body 方向の場合)
        // Branch は条件が true → successors[0], false → successors[1] (builder の規約に依存)
        // ループヘッダの Branch: false → exit (block 脱出)
        if (loopInfo) {
          // 条件が false → exit (block 脱出)
          body.push(WASM_OP.i32_eqz);
          const exitDepth = controlStack.length - 1 - controlStack.findLastIndex(
            e => e.kind === "block" && e.targetBlockId === loopInfo.exitBlock
          );
          body.push(WASM_OP.br_if, exitDepth);
        } else {
          // 非ループの if: とりあえず block + br_if
          // (シンプルに: 条件 false なら次のブロックに fall through)
          body.push(WASM_OP.br_if, 0); // placeholder
        }
      } else if (op.opcode === "Jump") {
        // 無条件ジャンプ
        // back edge → br $loop
        const jumpTarget = block.successors[0];
        // Phi がある successor への Jump: phiWrites を出力
        const writes = phiWrites.get(blockId);
        if (writes) {
          for (const { phiLocal, valueId } of writes) {
            emitValueOrConst(valueId, body, opToLocal, opById);
            body.push(WASM_OP.local_set, phiLocal);
          }
        }
        if (jumpTarget !== undefined && cfg.backEdges.has(`${blockId}→${jumpTarget}`)) {
          // back edge → br $loop
          const loopDepth = controlStack.length - 1 - controlStack.findLastIndex(
            e => e.kind === "loop" && e.targetBlockId === jumpTarget
          );
          body.push(WASM_OP.br, loopDepth);
        }
        // forward jump は fall-through
      } else if (op.opcode === "Return") {
        emitLoadValue(op.args[0], body, opToLocal);
        body.push(WASM_OP.return);
      } else {
        emitOp(op, body, opToLocal, irFunc, needsLocal, [], [], new Set(), opById);
      }
    }

    // ループの最後のブロックの後に loop + block の end を閉じる
    for (const loop of cfg.loops) {
      const lastBodyBlock = Math.max(...[...loop.body]);
      if (blockId === lastBodyBlock) {
        // loop end
        body.push(WASM_OP.end);
        controlStack.pop();
        // block end
        body.push(WASM_OP.end);
        controlStack.pop();
      }
    }
  }

  body.push(WASM_OP.end); // function end

  // Phi の初期値を関数の先頭に挿入
  const initCode: number[] = [];
  for (const block of irFunc.blocks) {
    for (const phi of block.phis) {
      const phiLocal = opToLocal.get(phi.id);
      if (phiLocal === undefined) continue;
      // B0 (entry) からの入力を初期値として出力
      const entryInput = phi.inputs.find(([predId]) => predId === 0);
      if (entryInput) {
        const [, valueId] = entryInput;
        emitValueOrConst(valueId, initCode, opToLocal, opById);
        initCode.push(WASM_OP.local_set, phiLocal);
      }
    }
  }

  return { body: [...initCode, ...body], extraLocals: nextLocal - irFunc.paramCount };
}

// ========== Op → Wasm 命令 ==========

function emitOp(
  op: Op,
  body: number[],
  opToLocal: Map<number, number>,
  irFunc: IRFunction,
  needsLocal: Set<number>,
  activeLoops: number[],
  activeBlocks: number[],
  loopHeaders: Set<number>,
  opById: Map<number, Op>,
): void {
  switch (op.opcode) {
    case "Const": {
      if (op.type === "f64") {
        body.push(WASM_OP.f64_const, ...f64ToBytes(op.value as number));
      } else if (op.type === "bool") {
        body.push(WASM_OP.i32_const, ...i32ToLEB128(op.value ? 1 : 0));
      } else {
        body.push(WASM_OP.i32_const, ...i32ToLEB128(op.value as number));
      }
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    case "Param": {
      // パラメータは既に local にある → 何もしない (使用時に local.get)
      // ただし命令列に出現したら local.get を発行
      const local = opToLocal.get(op.id);
      if (local !== undefined) {
        body.push(WASM_OP.local_get, local);
        maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      }
      break;
    }

    case "Undefined": {
      // undefined → i32 0 として扱う
      body.push(WASM_OP.i32_const, ...i32ToLEB128(0));
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    case "TypeGuard": {
      // 型ガード: 現在は型が合ってる前提で passthrough
      // 将来: 型チェック → 失敗で deopt (unreachable or special return)
      emitLoadValue(op.args[0], body, opToLocal);
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    // 2引数算術
    case "Add": case "Sub": case "Mul": case "Div": case "Mod":
    case "BitAnd": case "BitOr": case "BitXor":
    case "ShiftLeft": case "ShiftRight": {
      emitLoadValue(op.args[0], body, opToLocal);
      emitLoadValue(op.args[1], body, opToLocal);
      body.push(getWasmBinOp(op.opcode, op.type));
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    // 比較
    case "LessThan": case "LessEqual":
    case "GreaterThan": case "GreaterEqual":
    case "Equal": case "StrictEqual":
    case "NotEqual": case "StrictNotEqual": {
      emitLoadValue(op.args[0], body, opToLocal);
      emitLoadValue(op.args[1], body, opToLocal);
      const argOp = opById.get(op.args[0]);
      body.push(getWasmCmpOp(op.opcode, argOp?.type ?? "i32"));
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    // 単項
    case "Negate": {
      const argOp = opById.get(op.args[0]);
      if (argOp?.type === "f64") {
        emitLoadValue(op.args[0], body, opToLocal);
        body.push(WASM_OP.f64_neg);
      } else {
        body.push(WASM_OP.i32_const, ...i32ToLEB128(0));
        emitLoadValue(op.args[0], body, opToLocal);
        body.push(WASM_OP.i32_sub);
      }
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }
    case "BitNot": {
      // ~x = x ^ -1
      emitLoadValue(op.args[0], body, opToLocal);
      body.push(WASM_OP.i32_const, ...i32ToLEB128(-1));
      body.push(0x73); // i32.xor
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }
    case "Not": {
      // !x = x == 0
      emitLoadValue(op.args[0], body, opToLocal);
      body.push(WASM_OP.i32_eqz);
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    // 制御フロー
    case "Return": {
      emitLoadValue(op.args[0], body, opToLocal);
      body.push(WASM_OP.return);
      break;
    }

    case "Branch": {
      // 条件分岐: 条件値をスタックに積んで br_if
      emitLoadValue(op.args[0], body, opToLocal);
      // どの successors に飛ぶかはブロックの successors で決まる
      // Branch の親ブロックの successors[0] = true先, successors[1] = false先
      // (JumpIfFalse の場合は逆だが、builder で正規化済み)
      // ここでは br_if でループバックか block 脱出を判断
      // 簡易: ループヘッダへの分岐なら br、そうでなければ if/else
      body.push(WASM_OP.br_if, 0); // placeholder — 実際の depth は後で
      break;
    }

    case "Jump": {
      // 無条件ジャンプ: ループヘッダへなら br、そうでなければ何もしない (fall-through)
      // ループの先頭への back edge なら br
      if (activeLoops.length > 0) {
        body.push(WASM_OP.br, 0); // loop depth
      }
      break;
    }

    default:
      break;
  }
}

// ========== ヘルパー ==========

// Op の値を Wasm スタックにロード
function emitLoadValue(opId: number, body: number[], opToLocal: Map<number, number>): void {
  const local = opToLocal.get(opId);
  if (local !== undefined) {
    body.push(WASM_OP.local_get, local);
  }
  // local がない場合は直前の命令で既にスタックに載ってるはず
}

// Op の値を Wasm スタックにロード (Const なら直接出力)
function emitValueOrConst(opId: number, body: number[], opToLocal: Map<number, number>, opById: Map<number, Op>): void {
  const local = opToLocal.get(opId);
  if (local !== undefined) {
    body.push(WASM_OP.local_get, local);
    return;
  }
  const op = opById.get(opId);
  if (op?.opcode === "Const") {
    if (op.type === "f64") {
      body.push(WASM_OP.f64_const, ...f64ToBytes(op.value as number));
    } else {
      body.push(WASM_OP.i32_const, ...i32ToLEB128(op.value as number));
    }
    return;
  }
  if (op?.opcode === "Param" && op.index !== undefined) {
    body.push(WASM_OP.local_get, op.index);
    return;
  }
  // fallback: i32.const 0
  body.push(WASM_OP.i32_const, 0);
}

// 複数回使われる値を local に保存
function maybeStoreLocal(opId: number, body: number[], opToLocal: Map<number, number>, needsLocal: Set<number>): void {
  if (needsLocal.has(opId)) {
    const local = opToLocal.get(opId)!;
    body.push(WASM_OP.local_tee, local);
  }
}

// use count を計算
function computeUseCount(irFunc: IRFunction): Map<number, number> {
  const counts = new Map<number, number>();
  for (const block of irFunc.blocks) {
    for (const phi of block.phis) {
      for (const [, valId] of phi.inputs) {
        counts.set(valId, (counts.get(valId) ?? 0) + 1);
      }
    }
    for (const op of block.ops) {
      for (const argId of op.args) {
        counts.set(argId, (counts.get(argId) ?? 0) + 1);
      }
    }
  }
  return counts;
}

// IR opcode → Wasm binary opcode
function getWasmBinOp(opcode: string, type: string): number {
  const isF64 = type === "f64";
  switch (opcode) {
    case "Add": return isF64 ? WASM_OP.f64_add : WASM_OP.i32_add;
    case "Sub": return isF64 ? WASM_OP.f64_sub : WASM_OP.i32_sub;
    case "Mul": return isF64 ? WASM_OP.f64_mul : WASM_OP.i32_mul;
    case "Div": return isF64 ? WASM_OP.f64_div : WASM_OP.i32_div_s;
    case "Mod": return WASM_OP.i32_rem_s;
    case "BitAnd": return 0x71; // i32.and
    case "BitOr": return 0x72;  // i32.or
    case "BitXor": return 0x73; // i32.xor
    case "ShiftLeft": return 0x74;  // i32.shl
    case "ShiftRight": return 0x75; // i32.shr_s
    default: return WASM_OP.i32_add;
  }
}

// IR comparison opcode → Wasm comparison opcode
function getWasmCmpOp(opcode: string, argType: string = "i32"): number {
  const isF64 = argType === "f64";
  switch (opcode) {
    case "LessThan": return isF64 ? WASM_OP.f64_lt : WASM_OP.i32_lt_s;
    case "LessEqual": return isF64 ? WASM_OP.f64_le : WASM_OP.i32_le_s;
    case "GreaterThan": return isF64 ? WASM_OP.f64_gt : WASM_OP.i32_gt_s;
    case "GreaterEqual": return isF64 ? WASM_OP.f64_ge : WASM_OP.i32_ge_s;
    case "Equal": case "StrictEqual": return isF64 ? 0x61 : 0x46; // f64.eq / i32.eq
    case "NotEqual": case "StrictNotEqual": return isF64 ? 0x62 : 0x47; // f64.ne / i32.ne
    default: return WASM_OP.i32_lt_s;
  }
}

// パラメータの型を IR から取得
function getParamTypes(irFunc: IRFunction): IRType[] {
  const types: IRType[] = [];
  for (const block of irFunc.blocks) {
    for (const op of block.ops) {
      if (op.opcode === "Param" && op.index !== undefined) {
        types[op.index] = op.type;
      }
    }
  }
  for (let i = 0; i < irFunc.paramCount; i++) {
    if (!types[i]) types[i] = "i32";
  }
  return types;
}

// Return の引数の型から戻り値の型を推論
function getReturnType(irFunc: IRFunction): IRType {
  const opById = new Map<number, Op>();
  for (const block of irFunc.blocks) {
    for (const op of block.ops) opById.set(op.id, op);
  }
  for (const block of irFunc.blocks) {
    for (const op of block.ops) {
      if (op.opcode === "Return" && op.args.length > 0) {
        const retVal = opById.get(op.args[0]);
        if (retVal) return retVal.type;
      }
    }
  }
  return "i32";
}

// ========== 完全なパイプライン: IR → Wasm module ==========

export function compileIRToWasm(irFunc: IRFunction): { instance: WebAssembly.Instance; funcName: string } | null {
  try {
    const builder = new WasmBuilder();

    // パラメータの型を IR から取得
    const paramTypes = getParamTypes(irFunc);
    const params = paramTypes.map(t => t === "f64" ? WASM_TYPE.f64 : WASM_TYPE.i32);
    // 戻り値の型: Return の引数の型から推論
    const returnType = getReturnType(irFunc);
    const results = [returnType === "f64" ? WASM_TYPE.f64 : WASM_TYPE.i32];

    const { body: bodyCode, extraLocals } = codegenIR(irFunc);

    builder.addFunction(irFunc.name, params, results, bodyCode, extraLocals);
    const wasmBytes = builder.build();

    const module = new WebAssembly.Module(wasmBytes);
    const instance = new WebAssembly.Instance(module);
    return { instance, funcName: irFunc.name };
  } catch (e: any) {
    // Wasm コンパイルエラー → null (フォールバック)
    // debug: console.error(e.message ?? e);
    return null;
  }
}
