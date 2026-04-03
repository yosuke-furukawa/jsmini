// IR → Wasm コード生成
//
// 最適化済み SSA IR を Wasm バイナリ (function body) に変換する。
// CFG → Wasm の structured control flow 変換を行う。

import type { IRFunction, Block, Op, PhiOp } from "./types.js";
import { isPhi } from "./types.js";
import { WasmBuilder, WASM_OP, WASM_TYPE, i32ToLEB128, f64ToBytes } from "../jit/wasm-builder.js";

// ========== Wasm Codegen ==========

export interface IRCodegenResult {
  wasmBytes: Uint8Array;
  funcIndex: number;
}

export function codegenIR(irFunc: IRFunction): number[] {
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

  const extraLocals = nextLocal - irFunc.paramCount;

  // ========== CFG → Wasm structured control flow ==========
  // シンプルなアプローチ:
  // - ブロックをトポロジカル順序で配置
  // - ループ (back edge) → loop + br
  // - 条件分岐 → if/else or block + br_if

  // ループヘッダの検出 (predecessor に自分より後のブロックがある)
  const loopHeaders = new Set<number>();
  for (const block of irFunc.blocks) {
    for (const predId of block.predecessors) {
      if (predId >= block.id) {
        loopHeaders.add(block.id);
      }
    }
  }

  // 各ブロックのコードを生成
  // control flow 構造を管理するスタック
  const activeLoops: number[] = []; // loop ヘッダの block id
  const activeBlocks: number[] = []; // block の break target block id

  for (const block of irFunc.blocks) {
    // 空ブロックはスキップ
    if (block.ops.length === 0 && block.phis.length === 0) continue;

    // ループヘッダ: loop 命令を挿入
    if (loopHeaders.has(block.id)) {
      body.push(WASM_OP.loop, WASM_TYPE.void);
      activeLoops.push(block.id);
    }

    // Phi ノードの値は既に predecessors が local に書き込み済み (emitPhiWrites で)
    // ここでは読み取りだけ

    // 通常の命令
    for (const op of block.ops) {
      emitOp(op, body, opToLocal, irFunc, needsLocal, activeLoops, activeBlocks, loopHeaders);
    }

    // ループヘッダの end を、ループ内の最後のブロックの後に置く
    // (back edge の br で戻る)
  }

  // 全ての loop/block の end を閉じる
  for (let i = 0; i < activeLoops.length; i++) {
    body.push(WASM_OP.end);
  }

  body.push(WASM_OP.end); // function end

  return body;
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
      body.push(getWasmCmpOp(op.opcode));
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    // 単項
    case "Negate": {
      // -x = 0 - x
      body.push(WASM_OP.i32_const, ...i32ToLEB128(0));
      emitLoadValue(op.args[0], body, opToLocal);
      body.push(WASM_OP.i32_sub);
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
function getWasmCmpOp(opcode: string): number {
  switch (opcode) {
    case "LessThan": return WASM_OP.i32_lt_s;
    case "LessEqual": return WASM_OP.i32_le_s;
    case "GreaterThan": return WASM_OP.i32_gt_s;
    case "GreaterEqual": return WASM_OP.i32_ge_s;
    case "Equal": case "StrictEqual": return 0x46; // i32.eq
    case "NotEqual": case "StrictNotEqual": return 0x47; // i32.ne
    default: return WASM_OP.i32_lt_s;
  }
}

// ========== 完全なパイプライン: IR → Wasm module ==========

export function compileIRToWasm(irFunc: IRFunction): { instance: WebAssembly.Instance; funcName: string } | null {
  try {
    const builder = new WasmBuilder();

    // パラメータ: 全部 i32
    const params = new Array(irFunc.paramCount).fill(WASM_TYPE.i32);
    const results = [WASM_TYPE.i32]; // 戻り値は i32

    const bodyCode = codegenIR(irFunc);

    // extra locals の数を計算
    const opToLocal = new Map<number, number>();
    let nextLocal = irFunc.paramCount;
    for (const block of irFunc.blocks) {
      for (const phi of block.phis) {
        opToLocal.set(phi.id, nextLocal++);
      }
    }
    const useCount = computeUseCount(irFunc);
    for (const [id, count] of useCount) {
      if (count > 1 && !opToLocal.has(id)) {
        nextLocal++;
      }
    }
    const extraLocals = nextLocal - irFunc.paramCount;

    builder.addFunction(irFunc.name, params, results, bodyCode, extraLocals);
    const wasmBytes = builder.build();

    const module = new WebAssembly.Module(wasmBytes);
    const instance = new WebAssembly.Instance(module);
    return { instance, funcName: irFunc.name };
  } catch (e) {
    // Wasm コンパイルエラー → null (フォールバック)
    return null;
  }
}
