// IR → Wasm コード生成
//
// 最適化済み SSA IR を Wasm バイナリ (function body) に変換する。
// CFG → Wasm の structured control flow 変換を行う。

import type { IRFunction, Block, Op, PhiOp, IRType } from "./types.js";
import { isPhi } from "./types.js";
import { WasmBuilder, WASM_OP, WASM_TYPE, i32ToLEB128, f64ToBytes, type LocalGroup, WASM_GC_OP, refType } from "../jit/wasm-builder.js";

const WASM_VOID = 0x40; // void block type
import { analyzeCFG, type CFGAnalysis, type LoopInfo } from "./loop-analysis.js";
import { functionNeedsF64 } from "./range.js";

// ========== Wasm Codegen ==========

export interface IRCodegenResult {
  wasmBytes: Uint8Array;
  funcIndex: number;
}

export function codegenIR(irFunc: IRFunction, forceF64 = false, arrayTypeIdx = -1): { body: number[]; extraLocals: number; wat: string } {
  const body: number[] = [];
  const watLines: string[] = [];
  let watIndent = 1;
  function wat(line: string) { watLines.push("  ".repeat(watIndent) + line); }

  // Wasm opcode → WAT 文字列のマップ
  const opNames: Record<number, string> = {
    [WASM_OP.local_get]: "local.get", [WASM_OP.local_set]: "local.set", [WASM_OP.local_tee]: "local.tee",
    [WASM_OP.i32_const]: "i32.const", [WASM_OP.f64_const]: "f64.const",
    [WASM_OP.i32_add]: "i32.add", [WASM_OP.i32_sub]: "i32.sub", [WASM_OP.i32_mul]: "i32.mul",
    [WASM_OP.i32_div_s]: "i32.div_s", [WASM_OP.i32_rem_s]: "i32.rem_s",
    [WASM_OP.f64_add]: "f64.add", [WASM_OP.f64_sub]: "f64.sub", [WASM_OP.f64_mul]: "f64.mul",
    [WASM_OP.f64_div]: "f64.div", [WASM_OP.f64_neg]: "f64.neg",
    [WASM_OP.i32_lt_s]: "i32.lt_s", [WASM_OP.i32_gt_s]: "i32.gt_s",
    [WASM_OP.i32_le_s]: "i32.le_s", [WASM_OP.i32_ge_s]: "i32.ge_s",
    [WASM_OP.i32_eqz]: "i32.eqz",
    [WASM_OP.f64_lt]: "f64.lt", [WASM_OP.f64_gt]: "f64.gt",
    [WASM_OP.f64_le]: "f64.le", [WASM_OP.f64_ge]: "f64.ge",
    [WASM_OP.return]: "return", [WASM_OP.end]: "end",
    [WASM_OP.block]: "block", [WASM_OP.loop]: "loop",
    [WASM_OP.br]: "br", [WASM_OP.br_if]: "br_if",
    0x46: "i32.eq", 0x47: "i32.ne", 0x61: "f64.eq", 0x62: "f64.ne",
    0x71: "i32.and", 0x72: "i32.or", 0x73: "i32.xor",
    0x74: "i32.shl", 0x75: "i32.shr_s",
  };

  // upvalue の数を検出 (追加パラメータとして渡される)
  let upvalueCount = 0;
  for (const block of irFunc.blocks) {
    for (const op of block.ops) {
      if ((op.opcode === "LoadUpvalue" || op.opcode === "StoreUpvalue") && op.index !== undefined) {
        upvalueCount = Math.max(upvalueCount, op.index + 1);
      }
    }
  }
  // this (オブジェクトプロパティアクセス) の検出
  let hasThis = false;
  const propOffsets = new Map<string, number>();
  let propCounter = 0;
  for (const block of irFunc.blocks) {
    for (const op of block.ops) {
      if (op.opcode === "LoadThis") hasThis = true;
      if ((op.opcode === "LoadProperty" || op.opcode === "StoreProperty") && op.globalName) {
        if (!propOffsets.has(op.globalName)) {
          propOffsets.set(op.globalName, propCounter++);
        }
      }
    }
  }

  const totalParamCount = irFunc.paramCount + upvalueCount + (hasThis ? 1 : 0);

  // Op ID → Wasm local index のマッピング
  // Wasm locals: [params..., upvalue params..., this param..., phi locals..., temp locals...]
  const opToLocal = new Map<number, number>();
  let nextLocal = totalParamCount;

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

  // グローバル変数 → Wasm local に割り当て
  const globalToLocal = new Map<string, number>();
  for (const block of irFunc.blocks) {
    for (const op of block.ops) {
      if ((op.opcode === "LoadGlobal" || op.opcode === "StoreGlobal") && op.globalName) {
        if (!globalToLocal.has(op.globalName)) {
          globalToLocal.set(op.globalName, nextLocal++);
        }
      }
    }
  }

  // 中間値で複数回使われるもの or 別ブロックで使われるもの → local に格納
  const useCount = computeUseCount(irFunc);
  // 各 Op がどのブロックで定義されてるか
  const opDefBlock = new Map<number, number>();
  for (const block of irFunc.blocks) {
    for (const op of block.ops) opDefBlock.set(op.id, block.id);
  }
  // 各 Op がどのブロックで使われてるか
  const opUseBlocks = new Map<number, Set<number>>();
  for (const block of irFunc.blocks) {
    for (const op of block.ops) {
      for (const argId of op.args) {
        if (!opUseBlocks.has(argId)) opUseBlocks.set(argId, new Set());
        opUseBlocks.get(argId)!.add(block.id);
      }
    }
  }
  const needsLocal = new Set<number>();
  for (const [id, count] of useCount) {
    if (opToLocal.has(id)) continue;
    const defBlock = opDefBlock.get(id);
    const useBlocks = opUseBlocks.get(id);
    // 複数回使用 or 別ブロックで使用 → local に格納
    if (count > 1 || (defBlock !== undefined && useBlocks && [...useBlocks].some(b => b !== defBlock))) {
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
      wat(`;; B${blockId} (loop header)`);
      body.push(WASM_OP.block, WASM_VOID);
      wat("block $exit_" + loopInfo.exitBlock);
      watIndent++;
      controlStack.push({ kind: "block", targetBlockId: loopInfo.exitBlock });
      body.push(WASM_OP.loop, WASM_VOID);
      wat("loop $loop_" + blockId);
      watIndent++;
      controlStack.push({ kind: "loop", targetBlockId: blockId });
    } else if (block.ops.length > 0) {
      wat(`;; B${blockId}`);
    }

    // 通常の命令を出力
    for (const op of block.ops) {
      if (op.opcode === "Branch") {
        // 条件分岐: Branch の条件を出力
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
        // Phi の値を書き込み (fall-through = body 方向の場合)
        // Branch は条件が true → successors[0], false → successors[1] (builder の規約に依存)
        // ループヘッダの Branch: false → exit (block 脱出)
        if (loopInfo) {
          body.push(WASM_OP.i32_eqz);
          wat("i32.eqz");
          const exitDepth = controlStack.length - 1 - controlStack.findLastIndex(
            e => e.kind === "block" && e.targetBlockId === loopInfo.exitBlock
          );
          body.push(WASM_OP.br_if, exitDepth);
          wat(`br_if ${exitDepth} ;; → exit`);
        } else {
          body.push(WASM_OP.br_if, 0);
          wat("br_if 0");
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
            wat(`;; phi write: local ${phiLocal} = v${valueId}`);
            body.push(WASM_OP.local_set, phiLocal);
            wat(`local.set ${phiLocal}`);
          }
        }
        if (jumpTarget !== undefined && cfg.backEdges.has(`${blockId}→${jumpTarget}`)) {
          const loopDepth = controlStack.length - 1 - controlStack.findLastIndex(
            e => e.kind === "loop" && e.targetBlockId === jumpTarget
          );
          body.push(WASM_OP.br, loopDepth);
          wat(`br ${loopDepth} ;; → loop`);
        }
        // forward jump は fall-through
      } else if (op.opcode === "Return") {
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
        wat(`local.get ${opToLocal.get(op.args[0]) ?? "?"} ;; v${op.args[0]}`);
        body.push(WASM_OP.return);
        wat("return");
      } else {
        const beforeLen = body.length;
        emitOp(op, body, opToLocal, irFunc, needsLocal, [], [], new Set(), opById, globalToLocal, forceF64, arrayTypeIdx, upvalueCount, propOffsets);
        // emitOp が出力した命令を WAT に変換
        watFromBytes(body, beforeLen, op, opToLocal, opById, opNames, wat);
      }
    }

    // ループの最後のブロックの後に loop + block の end を閉じる
    for (const loop of cfg.loops) {
      const lastBodyBlock = Math.max(...[...loop.body]);
      if (blockId === lastBodyBlock) {
        watIndent--;
        body.push(WASM_OP.end);
        wat("end ;; loop");
        watIndent--;
        body.push(WASM_OP.end);
        wat("end ;; block");
        controlStack.pop();
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

  const paramStr = Array.from({length: irFunc.paramCount}, (_, i) => `(param $p${i} i32)`).join(" ");
  const header = `(func $${irFunc.name} ${paramStr} (result i32)`;
  const localDecls = nextLocal > irFunc.paramCount
    ? `  (local ${Array(nextLocal - irFunc.paramCount).fill("i32").join(" ")})`
    : "";
  const fullWat = [header, localDecls, ";; phi init", ...watLines, ")"].filter(Boolean).join("\n");

  return { body: [...initCode, ...body], extraLocals: nextLocal - irFunc.paramCount, wat: fullWat };
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
  globalToLocal: Map<string, number> = new Map(),
  forceF64 = false,
  arrayTypeIdx = -1,
  upvalueCount = 0,
  propOffsets: Map<string, number> = new Map(),
): void {
  // forceF64 なら全演算を f64 として扱う
  const effectiveType = forceF64 ? "f64" : op.type;
  switch (op.opcode) {
    case "Const": {
      // needsLocal に入ってる場合だけ出力して local に保存
      // そうでなければ使用時に emitLoadValue/emitValueOrConst で直接出力
      if (needsLocal.has(op.id)) {
        if (effectiveType === "f64" && typeof op.value === "number") {
          body.push(WASM_OP.f64_const, ...f64ToBytes(op.value as number));
        } else if (op.type === "bool") {
          body.push(WASM_OP.i32_const, ...i32ToLEB128(op.value ? 1 : 0));
        } else {
          body.push(WASM_OP.i32_const, ...i32ToLEB128(op.value as number));
        }
        maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      }
      break;
    }

    case "Param": {
      // パラメータは既に local にある。使用時に emitLoadValue で local.get される。
      // ここでは何もしない。
      break;
    }

    case "Undefined": {
      // undefined → i32 0 として扱う
      body.push(WASM_OP.i32_const, ...i32ToLEB128(0));
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    case "LoadGlobal": {
      const gLocal = globalToLocal.get(op.globalName!);
      if (gLocal !== undefined) {
        body.push(WASM_OP.local_get, gLocal);
        maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      }
      break;
    }
    // 配列操作 (WasmGC array)
    case "ArrayGet": {
      if (arrayTypeIdx >= 0) {
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64); // arr ref
        emitLoadValue(op.args[1], body, opToLocal, opById, forceF64); // index
        if (forceF64) body.push(0xab); // i32.trunc_f64_s (index must be i32 for array.get)
        body.push(0xfb, WASM_GC_OP.array_get, arrayTypeIdx);
        // f64 array → result is already f64, no conversion needed
        maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      }
      break;
    }
    case "ArraySet": {
      if (arrayTypeIdx >= 0) {
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64); // arr ref
        emitLoadValue(op.args[1], body, opToLocal, opById, forceF64); // index
        if (forceF64) body.push(0xab); // i32.trunc_f64_s
        emitLoadValue(op.args[2], body, opToLocal, opById, forceF64); // value (f64 array takes f64)
        body.push(0xfb, WASM_GC_OP.array_set, arrayTypeIdx);
      }
      break;
    }
    case "ArrayLength": {
      if (arrayTypeIdx >= 0) {
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64); // arr ref
        body.push(0xfb, WASM_GC_OP.array_len);
        if (forceF64) body.push(0xb7); // f64.convert_i32_s
      }
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    case "StoreGlobal": {
      const gLocal = globalToLocal.get(op.globalName!);
      if (gLocal !== undefined) {
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
        body.push(WASM_OP.local_set, gLocal);
      }
      break;
    }

    case "LoadUpvalue": {
      // upvalue は追加パラメータ: local index = irFunc.paramCount + upvalue index
      const uvLocal = irFunc.paramCount + op.index!;
      body.push(WASM_OP.local_get, uvLocal);
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }
    case "StoreUpvalue": {
      const uvLocal = irFunc.paramCount + op.index!;
      emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
      body.push(WASM_OP.local_set, uvLocal);
      break;
    }

    case "LoadThis": {
      // this は upvalue の後の追加パラメータ
      const thisLocal = irFunc.paramCount + upvalueCount;
      body.push(WASM_OP.local_get, thisLocal);
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }
    case "LoadProperty": {
      // obj.name → i32.load(obj + propOffset * 4)
      const offset = propOffsets.get(op.globalName!);
      if (offset !== undefined) {
        emitLoadValue(op.args[0], body, opToLocal, opById, false); // base addr is always i32
        const byteOffset = offset * 4;
        if (byteOffset > 0) {
          body.push(WASM_OP.i32_const, ...i32ToLEB128(byteOffset));
          body.push(WASM_OP.i32_add);
        }
        body.push(WASM_OP.i32_load, 0x02, 0x00); // alignment=4, offset=0
        if (forceF64) {
          body.push(WASM_OP.f64_convert_i32_s);
        }
      }
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }
    case "StoreProperty": {
      // obj.name = value → i32.store(obj + propOffset * 4, value)
      const offset = propOffsets.get(op.globalName!);
      if (offset !== undefined) {
        emitLoadValue(op.args[0], body, opToLocal, opById, false); // base addr
        const byteOffset = offset * 4;
        if (byteOffset > 0) {
          body.push(WASM_OP.i32_const, ...i32ToLEB128(byteOffset));
          body.push(WASM_OP.i32_add);
        }
        emitLoadValue(op.args[1], body, opToLocal, opById, false); // value as i32
        body.push(WASM_OP.i32_store, 0x02, 0x00);
      }
      break;
    }

    case "Alloc": {
      // bump allocator: base = global.get $heapPtr; global.set $heapPtr (base + size)
      const objectSize = propOffsets.size * 4 || 32; // プロパティ数 × 4 bytes
      body.push(WASM_OP.global_get, 0); // heapPtr global index 0
      // heapPtr += objectSize
      body.push(WASM_OP.global_get, 0);
      body.push(WASM_OP.i32_const, ...i32ToLEB128(objectSize));
      body.push(WASM_OP.i32_add);
      body.push(WASM_OP.global_set, 0);
      // スタックに base address が残る
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    case "TypeGuard": {
      // 型ガード: 現在は型が合ってる前提で passthrough
      // 将来: 型チェック → 失敗で deopt (unreachable or special return)
      emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    // 2引数算術
    case "Add": case "Sub": case "Mul": case "Div": case "Mod":
    case "BitAnd": case "BitOr": case "BitXor":
    case "ShiftLeft": case "ShiftRight": {
      if (forceF64 && (op.opcode === "ShiftLeft" || op.opcode === "ShiftRight")) {
        // f64 にビットシフトは存在しない → Mul/Div に戻す
        // ShiftLeft(x, n) → Mul(x, 2^n), ShiftRight(x, n) → Div(x, 2^n)
        const shiftArg = opById?.get(op.args[1]);
        const shiftAmount = shiftArg?.opcode === "Const" && typeof shiftArg.value === "number" ? shiftArg.value : 1;
        const multiplier = 2 ** shiftAmount;
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
        body.push(WASM_OP.f64_const, ...f64ToBytes(multiplier));
        body.push(op.opcode === "ShiftLeft" ? WASM_OP.f64_mul : WASM_OP.f64_div);
      } else if (forceF64 && (op.opcode === "BitAnd" || op.opcode === "BitOr" || op.opcode === "BitXor"
          || op.opcode === "Mod")) {
        // f64 にビット演算/剰余がない → i32 に変換して計算し f64 に戻す
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
        body.push(WASM_OP.i32_trunc_f64_s);
        emitLoadValue(op.args[1], body, opToLocal, opById, forceF64);
        body.push(WASM_OP.i32_trunc_f64_s);
        body.push(getWasmBinOp(op.opcode, "i32"));
        body.push(WASM_OP.f64_convert_i32_s);
      } else {
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
        emitLoadValue(op.args[1], body, opToLocal, opById, forceF64);
        body.push(getWasmBinOp(op.opcode, effectiveType));
      }
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    // 比較
    case "LessThan": case "LessEqual":
    case "GreaterThan": case "GreaterEqual":
    case "Equal": case "StrictEqual":
    case "NotEqual": case "StrictNotEqual": {
      emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
      emitLoadValue(op.args[1], body, opToLocal, opById, forceF64);
      body.push(getWasmCmpOp(op.opcode, forceF64 ? "f64" : (opById.get(op.args[0])?.type ?? "i32")));
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    // 単項
    case "Negate": {
      if (forceF64 || opById.get(op.args[0])?.type === "f64") {
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
        body.push(WASM_OP.f64_neg);
      } else {
        body.push(WASM_OP.i32_const, ...i32ToLEB128(0));
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
        body.push(WASM_OP.i32_sub);
      }
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }
    case "BitNot": {
      // ~x = x ^ -1
      emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
      body.push(WASM_OP.i32_const, ...i32ToLEB128(-1));
      body.push(0x73); // i32.xor
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }
    case "Not": {
      // !x = x == 0
      emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
      body.push(WASM_OP.i32_eqz);
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    // 制御フロー
    case "Return": {
      emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
      body.push(WASM_OP.return);
      break;
    }

    case "Branch": {
      // 条件分岐: 条件値をスタックに積んで br_if
      emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
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

// body のバイト列変化から WAT テキストを簡易生成
function watFromBytes(
  body: number[], startIdx: number, op: Op,
  opToLocal: Map<number, number>, opById: Map<number, Op>,
  opNames: Record<number, string>, wat: (line: string) => void,
): void {
  const comment = op.opcode === "Const" ? ` ;; ${op.value}`
    : op.opcode === "Param" ? ` ;; param ${op.index}`
    : op.opcode === "LoadGlobal" ? ` ;; ${op.globalName}`
    : op.opcode === "StoreGlobal" ? ` ;; ${op.globalName}`
    : ` ;; v${op.id}`;
  let i = startIdx;
  while (i < body.length) {
    const byte = body[i];
    const name = opNames[byte];
    if (byte === WASM_OP.i32_const) {
      // LEB128 encoded value follows
      let val = 0, shift = 0, b;
      let j = i + 1;
      do { b = body[j]; val |= (b & 0x7f) << shift; shift += 7; j++; } while (b & 0x80);
      if (shift < 32 && (b & 0x40)) val |= (-1 << shift);
      wat(`i32.const ${val}${comment}`);
      i = j;
    } else if (byte === WASM_OP.f64_const) {
      wat(`f64.const ...${comment}`);
      i += 9;
    } else if (byte === WASM_OP.local_get || byte === WASM_OP.local_set || byte === WASM_OP.local_tee) {
      wat(`${name} ${body[i + 1]}${comment}`);
      i += 2;
    } else if (name) {
      wat(`${name}${comment}`);
      i++;
    } else {
      i++;
    }
  }
}

// Op の値を Wasm スタックにロード
function emitLoadValue(opId: number, body: number[], opToLocal: Map<number, number>, opById?: Map<number, Op>, forceF64 = false): void {
  const local = opToLocal.get(opId);
  if (local !== undefined) {
    body.push(WASM_OP.local_get, local);
    return;
  }
  // local がない場合: Const なら直接出力
  if (opById) {
    const op = opById.get(opId);
    if (op?.opcode === "Const" && typeof op.value === "number") {
      if (forceF64) {
        body.push(WASM_OP.f64_const, ...f64ToBytes(op.value));
      } else {
        body.push(WASM_OP.i32_const, ...i32ToLEB128(op.value));
      }
      return;
    }
    if (op?.opcode === "Const" && typeof op.value === "boolean") {
      body.push(WASM_OP.i32_const, ...i32ToLEB128(op.value ? 1 : 0));
      return;
    }
  }
  // fallback: 直前の命令でスタックに載ってるはず
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

export function compileIRToWasm(irFunc: IRFunction): { instance: WebAssembly.Instance; funcName: string; hasArrayOps?: boolean; arrayParams?: number[]; upvalueCount?: number; hasThis?: boolean; memory?: WebAssembly.Memory } | null {
  try {
    // IR に Wasm 化できない Op が含まれてたらスキップ
    let hasArrayOps = false;
    for (const block of irFunc.blocks) {
      for (const op of block.ops) {
        if (op.opcode === "Call") return null; // 未インライン化の Call
        // 配列 Op を検出 (WasmGC array 構築が必要)
        if (op.opcode === "ArrayGet" || op.opcode === "ArraySet" || op.opcode === "ArrayLength") {
          hasArrayOps = true;
        }
        if (op.opcode === "Const" && op.value !== undefined &&
            typeof op.value !== "number" && typeof op.value !== "boolean" &&
            op.value !== null) return null; // 非数値 Const (関数オブジェクト等)
      }
    }

    const builder = new WasmBuilder();

    // Range Analysis: i32 で overflow するなら全体を f64 に昇格
    const useF64 = functionNeedsF64(irFunc);
    const wasmType = useF64 ? WASM_TYPE.f64 : WASM_TYPE.i32;

    // WasmGC array 型定義
    let arrayTypeIdx = -1;
    if (hasArrayOps) {
      arrayTypeIdx = builder.addArray(wasmType);
    }

    // 配列パラメータの特定: IR の ArrayGet/ArraySet の args[0] が Param なら配列パラメータ
    const arrayParams = new Set<number>(); // Param index
    if (hasArrayOps) {
      for (const block of irFunc.blocks) {
        for (const op of block.ops) {
          if ((op.opcode === "ArrayGet" || op.opcode === "ArraySet" || op.opcode === "ArrayLength") && op.args[0] !== undefined) {
            // args[0] が Param かどうか
            for (const b of irFunc.blocks) {
              for (const o of b.ops) {
                if (o.opcode === "Param" && o.id === op.args[0] && o.index !== undefined) {
                  arrayParams.add(o.index);
                }
              }
            }
          }
        }
      }
    }

    // upvalue の数を検出
    let upvalueCount = 0;
    for (const block of irFunc.blocks) {
      for (const op of block.ops) {
        if ((op.opcode === "LoadUpvalue" || op.opcode === "StoreUpvalue") && op.index !== undefined) {
          upvalueCount = Math.max(upvalueCount, op.index + 1);
        }
      }
    }

    // this / property ops の検出
    let hasThis = false;
    let hasPropertyOps = false;
    for (const block of irFunc.blocks) {
      for (const op of block.ops) {
        if (op.opcode === "LoadThis") hasThis = true;
        if (op.opcode === "LoadProperty" || op.opcode === "StoreProperty") hasPropertyOps = true;
      }
    }

    // Alloc の検出
    let hasAlloc = false;
    for (const block of irFunc.blocks) {
      for (const op of block.ops) {
        if (op.opcode === "Alloc") hasAlloc = true;
      }
    }

    // プロパティアクセスまたは Alloc がある場合は linear memory が必要
    if (hasPropertyOps || hasAlloc) {
      builder.enableMemory(1); // 1 page = 64KB
    }

    // Alloc がある場合は heapPtr global が必要
    if (hasAlloc) {
      builder.addGlobal(WASM_TYPE.i32, true, 0); // global 0 = heapPtr, mutable, init=0
    }

    // パラメータ: 配列は ref $array、他は i32/f64、upvalue も追加
    const params: number[] = [];
    for (let i = 0; i < irFunc.paramCount; i++) {
      if (arrayParams.has(i)) {
        params.push(...refType(arrayTypeIdx));
      } else {
        params.push(wasmType);
      }
    }
    // upvalue 追加パラメータ
    for (let i = 0; i < upvalueCount; i++) {
      params.push(wasmType);
    }
    // this 追加パラメータ (i32: メモリ上のベースアドレス)
    if (hasThis) {
      params.push(WASM_TYPE.i32);
    }
    const results = [wasmType];

    const { body: bodyCode, extraLocals } = codegenIR(irFunc, useF64, arrayTypeIdx);

    const totalParamCount = irFunc.paramCount + upvalueCount + (hasThis ? 1 : 0);
    const localType = useF64 ? [WASM_TYPE.f64] : [wasmType];
    const extraLocalGroups = extraLocals > 0 ? [{ count: extraLocals, type: localType }] : undefined;
    builder.addFunction(irFunc.name, params, results, bodyCode,
      extraLocals > 0 ? extraLocals : 0,
      totalParamCount, 1, extraLocalGroups);
    // WasmGC 配列ヘルパー関数
    if (hasArrayOps && arrayTypeIdx >= 0) {
      // __create_array(len) → ref $array
      const initValue = useF64
        ? [WASM_OP.f64_const, ...f64ToBytes(0)]
        : [WASM_OP.i32_const, ...i32ToLEB128(0)];
      const createBody = [
        ...initValue,
        WASM_OP.local_get, 0,
        0xfb, WASM_GC_OP.array_new, arrayTypeIdx,
        WASM_OP.end,
      ];
      builder.addFunction("__create_array", [WASM_TYPE.i32], refType(arrayTypeIdx), createBody, 0, 1, 1);

      // __get_array(arr, idx) → i32/f64
      const getBody = [
        WASM_OP.local_get, 0,
        WASM_OP.local_get, 1,
        0xfb, WASM_GC_OP.array_get, arrayTypeIdx,
        WASM_OP.end,
      ];
      builder.addFunction("__get_array", [...refType(arrayTypeIdx), WASM_TYPE.i32], [wasmType], getBody, 0, 2, 1);

      // __set_array(arr, idx, val) → void
      const setBody = [
        WASM_OP.local_get, 0,
        WASM_OP.local_get, 1,
        WASM_OP.local_get, 2,
        0xfb, WASM_GC_OP.array_set, arrayTypeIdx,
        WASM_OP.end,
      ];
      builder.addFunction("__set_array", [...refType(arrayTypeIdx), WASM_TYPE.i32, wasmType], [], setBody, 0, 3, 0);
    }

    const wasmBytes = builder.build();

    const module = new WebAssembly.Module(wasmBytes);
    const instance = new WebAssembly.Instance(module);
    const memory = hasPropertyOps ? (instance.exports as any).memory as WebAssembly.Memory : undefined;
    return {
      instance,
      funcName: irFunc.name,
      hasArrayOps,
      arrayParams: [...arrayParams],
      upvalueCount: upvalueCount > 0 ? upvalueCount : undefined,
      hasThis: hasThis || undefined,
      memory,
    };
  } catch (e: any) {
    // Wasm コンパイルエラー → null (フォールバック)
    // Wasm コンパイルエラー → フォールバック
    return null;
  }
}
