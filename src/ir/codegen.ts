// IR → Wasm コード生成
//
// 最適化済み SSA IR を Wasm バイナリ (function body) に変換する。
// CFG → Wasm の structured control flow 変換を行う。

import type { IRFunction, Block, Op, PhiOp, IRType } from "./types.js";
import { isPhi } from "./types.js";
import { WasmBuilder, WASM_OP, WASM_TYPE, i32ToLEB128, u32ToLEB128, f64ToBytes, type LocalGroup, WASM_GC_OP, refType } from "../jit/wasm-builder.js";

const WASM_VOID = 0x40; // void block type

// クラスタコンパイル (Phase 32): main と同一モジュールに入る callee と、
// callee の upvalue の供給元 (caller の upvalue param か追加 box param)
export type ClusterUpvalueSource = { kind: "own" | "extra"; i: number };
export type ClusterCallee = { ir: IRFunction };
export type ClusterInfo = { callees: ClusterCallee[]; extraBoxCount: number; deadCallees?: Set<number> };
type ClusterCtx = { funcIndexBase: number; srcToParam: (src: ClusterUpvalueSource) => number };
// ブラウザ (playground) には process が無いので安全にガード
const DEBUG_WASM = typeof process !== "undefined" && !!process.env?.DEBUG_WASM;
import { analyzeCFG, type CFGAnalysis, type LoopInfo } from "./loop-analysis.js";
import { functionNeedsF64 } from "./range.js";

// ========== Wasm Codegen ==========

export interface IRCodegenResult {
  wasmBytes: Uint8Array;
  funcIndex: number;
}

// Math.X → Wasm native f64 op (1 引数)
const MATH_NATIVE_UNARY: Record<string, number> = {
  "Math.sqrt": WASM_OP.f64_sqrt,
  "Math.abs": WASM_OP.f64_abs,
  "Math.floor": WASM_OP.f64_floor,
  "Math.ceil": WASM_OP.f64_ceil,
  "Math.trunc": WASM_OP.f64_trunc,
  // 注: Math.round は half-up、f64.nearest は half-to-even (≠ JS spec)。host import に回す
};
// Math.X → Wasm native f64 op (2 引数)
const MATH_NATIVE_BINARY: Record<string, number> = {
  // 注: 2 引数の Math.min / max のみネイティブで対応。可変長引数は host へ回す
  "Math.min": WASM_OP.f64_min,
  "Math.max": WASM_OP.f64_max,
};
// host import が必要な Math.X (引数数も併記)
const MATH_HOST_IMPORTS: Record<string, number> = {
  "Math.sin": 1, "Math.cos": 1, "Math.tan": 1,
  "Math.asin": 1, "Math.acos": 1, "Math.atan": 1,
  "Math.sinh": 1, "Math.cosh": 1, "Math.tanh": 1,
  "Math.asinh": 1, "Math.acosh": 1, "Math.atanh": 1,
  "Math.exp": 1, "Math.log": 1, "Math.log2": 1, "Math.log10": 1,
  "Math.log1p": 1, "Math.expm1": 1, "Math.cbrt": 1,
  "Math.round": 1, "Math.sign": 1,
  "Math.atan2": 2, "Math.pow": 2, "Math.hypot": 2,
};

function classifyMathCall(name: string, argc: number): "native_unary" | "native_binary" | "host" | "unsupported" {
  if (MATH_NATIVE_UNARY[name] !== undefined && argc === 1) return "native_unary";
  if (MATH_NATIVE_BINARY[name] !== undefined && argc === 2) return "native_binary";
  if (MATH_HOST_IMPORTS[name] !== undefined && MATH_HOST_IMPORTS[name] === argc) return "host";
  return "unsupported";
}

export function codegenIR(irFunc: IRFunction, forceF64 = false, arrayTypeIdx = -1, importIndices?: Map<string, number>, importCount = 0, arrayRefValues: Set<number> = new Set(), growableArrayValues: Set<number> = new Set(), growFnIndex = -1, globalsAsParams = false, cluster: ClusterInfo | null = null, clusterFuncIndexBase = -1): { body: number[]; extraLocals: number; lenLocals: number; refLocals: number; wat: string; propNames: string[]; writtenProps: string[]; globalNames: string[]; hasStoreGlobal: boolean } {
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
      // クラスタ呼び出しが転送する own upvalue (LoadUpvalue が無くても param が要る)
      if (op.clusterSrcs) {
        for (const src of op.clusterSrcs) {
          if (src.kind === "own") upvalueCount = Math.max(upvalueCount, src.i + 1);
        }
      }
    }
  }
  // this (オブジェクトプロパティアクセス) の検出。
  // propOffsets: この関数が使うプロパティ名 → linear memory の offset (IR 出現順)。
  // writtenProps: StoreProperty されるプロパティ名 (実行後に VM へ write-back が必要)
  let hasThis = false;
  const propOffsets = new Map<string, number>();
  const writtenProps = new Set<string>();
  let propCounter = 0;
  for (const block of irFunc.blocks) {
    for (const op of block.ops) {
      if (op.opcode === "LoadThis") hasThis = true;
      if ((op.opcode === "LoadProperty" || op.opcode === "StoreProperty") && op.globalName) {
        if (op.opcode === "LoadProperty" && op.calleeName?.startsWith("Math.")) continue;
        if (!propOffsets.has(op.globalName)) {
          propOffsets.set(op.globalName, propCounter++);
        }
        if (op.opcode === "StoreProperty") writtenProps.add(op.globalName);
      }
    }
  }

  // グローバル参照の収集 (skip: 自己再帰 callee / Math / Array / undefined)。
  // tryCall 経路 (globalsAsParams=true) では読み取り専用の追加パラメータとして
  // 呼び出し時に実際の値を渡す。OSR 経路では従来通り zero-init local
  // (スクリプト全体が Wasm 内で完結し内部整合するため)。
  const globalNames: string[] = [];
  let hasStoreGlobal = false;
  for (const block of irFunc.blocks) {
    for (const op of block.ops) {
      if ((op.opcode === "LoadGlobal" || op.opcode === "StoreGlobal") && op.globalName) {
        if (op.globalName === irFunc.name) continue;
        if (op.globalName === "Math" || op.globalName === "Array" || op.globalName === "undefined") continue;
        if (op.opcode === "StoreGlobal") hasStoreGlobal = true;
        if (!globalNames.includes(op.globalName)) globalNames.push(op.globalName);
      }
    }
  }

  const totalParamCount = irFunc.paramCount + upvalueCount + (hasThis ? 1 : 0)
    + (globalsAsParams ? globalNames.length : 0)
    + (cluster ? cluster.extraBoxCount : 0);

  // Op ID → Wasm local index のマッピング
  // Wasm locals: [params..., upvalue params..., this param..., global params...,
  //               phi locals..., temp locals...]
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
  // (配列 ref を運ぶ Phi は ref 型 local が要るので後でまとめて割り当てる)
  for (const block of irFunc.blocks) {
    for (const phi of block.phis) {
      if (arrayRefValues.has(phi.id)) continue;
      opToLocal.set(phi.id, nextLocal++);
    }
  }

  // グローバル変数 → Wasm local に割り当て。
  // params-mode: [user params][upvalues][this] の直後の param index に固定。
  // locals-mode (OSR): 従来通り locals 領域に割当 (zero-init)
  const globalToLocal = new Map<string, number>();
  const globalParamBase = irFunc.paramCount + upvalueCount + (hasThis ? 1 : 0);
  for (let i = 0; i < globalNames.length; i++) {
    globalToLocal.set(globalNames[i], globalsAsParams ? globalParamBase + i : nextLocal++);
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
    if (arrayRefValues.has(id)) continue; // 配列 ref は ref 型 local で後割り当て
    const defBlock = opDefBlock.get(id);
    const useBlocks = opUseBlocks.get(id);
    // 複数回使用 or 別ブロックで使用 → local に格納
    if (count > 1 || (defBlock !== undefined && useBlocks && [...useBlocks].some(b => b !== defBlock))) {
      needsLocal.add(id);
      opToLocal.set(id, nextLocal++);
    }
  }

  // 計算値 (Const/Param 以外) を local に入れず「スタックに残したまま」消費する
  // 最適化は、次の 2 条件が両方成り立つときだけ正しい:
  //   (a) 消費する op が定義の *直後* にある (間に別の push が挟まらない)。
  //       挟まると埋もれて、消費側が別の値を読んでしまう。
  //         例: k3 = k*k*k; sk = Math.sin(k); k3*sk*sk
  //             → k3 の上に sk が積まれ、k3*sk が sk*sk になる
  //   (b) その計算値が消費側で「最初に push されるオペランド」(スタック最下位)。
  //       後続オペランドに来て手前に leaf (Const/Param: emitLoadValue が消費時に
  //       push) があると、leaf が上に積まれてオペランド順が反転する。
  //         例: 1/(n*2) → [n*2] の上に const 1 → (n*2)/1
  // どちらかでも崩れる計算値は local に退避して順序を固定する。
  {
    const opByIdEarly = new Map<number, Op>();
    for (const block of irFunc.blocks) {
      for (const phi of block.phis) opByIdEarly.set(phi.id, phi);
      for (const op of block.ops) opByIdEarly.set(op.id, op);
    }
    const isRematerializable = (id: number): boolean => {
      // local を持つ (Param 含む) か Const なら emitLoadValue が正しい位置で再生成できる
      if (opToLocal.has(id)) return true;
      const o = opByIdEarly.get(id);
      return !o || o.opcode === "Const";
    };
    for (const block of irFunc.blocks) {
      for (let pos = 0; pos < block.ops.length; pos++) {
        const op = block.ops[pos];
        const firstOperand = op.opcode === "Call" ? 1 : 0;
        let sawLeafBefore = false;
        for (let i = firstOperand; i < op.args.length; i++) {
          const argId = op.args[i];
          if (arrayRefValues.has(argId)) {
            // 配列 ref は ref 型 local で後割り当て。ただし emitLoadValue が
            // 消費時に push する leaf である点は同じなので、後続の計算値の
            // 順序判定 (b) には「leaf を見た」として効かせる
            // (これを忘れると ArrayGet(x, i-1) で i-1 が inline のまま
            //  x が上に積まれ、arr と index が逆転する)
            sawLeafBefore = true;
            continue;
          }
          const rematerializable = isRematerializable(argId);
          if (!rematerializable && !opToLocal.has(argId)) {
            // (a) この計算値の定義が直前の op か?
            const defImmediatelyBefore = pos > 0 && block.ops[pos - 1].id === argId;
            // (b) 先頭オペランドか? (手前に leaf があると反転)
            const orderBroken = i > firstOperand && sawLeafBefore;
            if (!defImmediatelyBefore || orderBroken) {
              needsLocal.add(argId);
              opToLocal.set(argId, nextLocal++);
            }
          }
          if (rematerializable) sawLeafBefore = true;
        }
      }
    }
  }

  // growable 配列 op (ArrayPush / growable ArrayGet) は args[0] (配列) を
  // 通常フローで emit しない (backing/len local で別処理) ため、value/index
  // が計算値だとインラインでスタック底に埋もれて順序が壊れる。これらの
  // 非配列オペランドが計算値なら local に退避する。
  if (growableArrayValues.size > 0) {
    const opLookup = new Map<number, Op>();
    for (const block of irFunc.blocks) {
      for (const phi of block.phis) opLookup.set(phi.id, phi);
      for (const op of block.ops) opLookup.set(op.id, op);
    }
    for (const block of irFunc.blocks) {
      for (const op of block.ops) {
        const isGrowableOp =
          op.opcode === "ArrayPush" ||
          ((op.opcode === "ArrayGet" || op.opcode === "ArraySet" || op.opcode === "ArrayLength")
            && growableArrayValues.has(op.args[0]));
        if (!isGrowableOp) continue;
        for (let i = 1; i < op.args.length; i++) {
          const argId = op.args[i];
          if (opToLocal.has(argId) || arrayRefValues.has(argId)) continue;
          const o = opLookup.get(argId);
          if (o && o.opcode !== "Const") { // 計算値のみ (Const は再生成される)
            needsLocal.add(argId);
            opToLocal.set(argId, nextLocal++);
          }
        }
      }
    }
  }

  // Phi の入力値も local に格納する必要がある (back edge の local.set で使うため)
  for (const block of irFunc.blocks) {
    for (const phi of block.phis) {
      for (const [, valueId] of phi.inputs) {
        if (arrayRefValues.has(valueId)) continue; // 配列 ref は ref 型 local で後割り当て
        if (!opToLocal.has(valueId)) {
          needsLocal.add(valueId);
          opToLocal.set(valueId, nextLocal++);
        }
      }
    }
  }

  const extraLocals = nextLocal - irFunc.paramCount;

  // local 群の順序: [scalar, len(i32), backing/ref]。
  // growable 配列は len local (i32) と backing local (ref) の 2 本で表現する。
  //   growableLenLocal: 配列 id → length を持つ i32 local
  //   growableBackingLocal: 配列 id → backing array を持つ ref local
  const growableLenLocal = new Map<number, number>();
  const growableBackingLocal = new Map<number, number>();

  // (1) len local (i32 group): growable 配列ごとに 1 本
  const scalarLocalEnd = nextLocal;
  for (const block of irFunc.blocks) {
    for (const op of block.ops) {
      if (op.opcode === "AllocGrowableArray" && !growableLenLocal.has(op.id)) {
        growableLenLocal.set(op.id, nextLocal++);
      }
    }
  }
  const lenLocals = nextLocal - scalarLocalEnd;

  // (2) ref group: 固定配列 (AllocArray) + 配列 Phi + growable の backing
  const refLocalStart = nextLocal;
  for (const block of irFunc.blocks) {
    for (const phi of block.phis) {
      if (arrayRefValues.has(phi.id) && !opToLocal.has(phi.id)) opToLocal.set(phi.id, nextLocal++);
    }
    for (const op of block.ops) {
      if (op.opcode === "AllocArray" && !opToLocal.has(op.id)) opToLocal.set(op.id, nextLocal++);
      if (op.opcode === "AllocGrowableArray" && !growableBackingLocal.has(op.id)) {
        growableBackingLocal.set(op.id, nextLocal++);
      }
    }
  }
  const refLocals = nextLocal - refLocalStart;

  // クラスタ呼び出しの emit 用コンテキスト。
  // own = この関数自身の upvalue param / extra = main の extraBox pool param
  let clusterCtx: ClusterCtx | null = null;
  if (cluster && clusterFuncIndexBase >= 0) {
    const extraBoxBase = irFunc.paramCount + upvalueCount + (hasThis ? 1 : 0)
      + (globalsAsParams ? globalNames.length : 0);
    clusterCtx = {
      funcIndexBase: clusterFuncIndexBase,
      srcToParam: (src) => src.kind === "own" ? irFunc.paramCount + src.i : extraBoxBase + src.i,
    };
  }

  // 未使用の Call 結果は drop する必要がある (スタック残骸防止)
  const usedIds = new Set<number>();
  for (const block of irFunc.blocks) {
    for (const op of block.ops) for (const a of op.args) usedIds.add(a);
    for (const phi of block.phis) for (const [, vid] of phi.inputs) usedIds.add(vid);
  }

  // growable 配列の emit 用コンテキスト (emitOp に渡す)
  const growCtx: GrowCtx = {
    growableArrayValues,
    growableLenLocal,
    growableBackingLocal,
    growFnIndex,
    arrayTypeIdx,
  };

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

  // topoOrder 上の次ブロック (= fall-through 先) の逆引き
  const topoNext = new Map<number, number>();
  for (let i = 0; i + 1 < cfg.topoOrder.length; i++) topoNext.set(cfg.topoOrder[i], cfg.topoOrder[i + 1]);

  // トポロジカル順にブロックを処理
  for (const blockId of cfg.topoOrder) {
    const block = blockMap.get(blockId);
    if (!block) continue;

    // if-else の block end: false 分岐ブロックの前に end を出す
    while (controlStack.length > 0) {
      const top = controlStack[controlStack.length - 1];
      if (top.kind === "block" && top.targetBlockId === blockId && !cfg.loopHeaders.has(blockId)) {
        watIndent--;
        body.push(WASM_OP.end);
        wat("end ;; block (if-else)");
        controlStack.pop();
      } else break;
    }

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
    } else if (block.ops.some(op => op.opcode === "Branch") && !loopInfo) {
      // 非ループの Branch: topo order では true (B1) → false (B2) の順に来る
      // block 内に B1 (true分岐) を入れ、条件を反転して false のとき B1 を実行
      // cond false → B1 のコードを実行 → return/end → B2 に落ちる
      // cond true → br_if で block end に飛ぶ → B2 のコードを実行
      // ※ ただし fib では true=B1(return n), false=B2(recursive) なので:
      //   block内=B1, 条件反転: true(n<=1)→br_if(skip B1)→B2... ダメ
      // → block 内=B1, 条件反転なし: false→B1実行, true→skip B1→B2... 逆
      //
      // 正しくは: successors[1] (false=B2) のブロックを block の外に、
      //           successors[0] (true=B1) を block の中に入れる
      // br_if で条件 false のとき B1 を実行 → eqz + br_if で「cond=false → skip」
      // ダイヤモンドの向き:
      // - if/else (JumpIfFalse 由来): true 辺が fall-through → block end = falseTarget,
      //   条件を反転して false なら skip
      // - || / && / 三項 (JumpIfTrue 由来): false 辺が fall-through → block end =
      //   trueTarget, 条件そのままで true なら skip (inverted diamond)
      const trueTarget = block.successors[0];
      const falseTarget = block.successors[1];
      const nextEmit = topoNext.get(blockId);
      const invertedDiamond = falseTarget === nextEmit && trueTarget !== nextEmit;
      const wrapTarget = invertedDiamond ? trueTarget : falseTarget;
      // 完全ダイヤモンド (三項 / if-else 合流): then 側が join へ Jump で
      // 飛び越える場合は、join で閉じる外側 block も開く (then の Jump が
      // br できる先を作る)。then が Return で終わる形 (fib 等) は不要。
      // then 腕は複数ブロックのことがある (中にループ等) ので、topo 順で
      // [trueTarget, falseTarget) にある全ブロックから「falseTarget 以降へ
      // 飛ぶ前方 Jump」を探し、その先を join とする
      if (!invertedDiamond) {
        const topoIdx = new Map<number, number>();
        cfg.topoOrder.forEach((b, i) => topoIdx.set(b, i));
        const tFalse = topoIdx.get(falseTarget) ?? Infinity;
        const tTrue = topoIdx.get(trueTarget) ?? Infinity;
        let join: number | undefined;
        for (const [bid, ti] of topoIdx) {
          if (ti < tTrue || ti >= tFalse) continue; // then 腕の範囲外
          const bb = blockMap.get(bid);
          const last = bb?.ops[bb.ops.length - 1];
          if (last?.opcode === "Jump") {
            const tgt = bb!.successors[0];
            if (tgt !== undefined && (topoIdx.get(tgt) ?? -1) >= tFalse && !cfg.backEdges.has(`${bid}→${tgt}`)) {
              join = tgt;
              break;
            }
          }
        }
        if (join !== undefined && join !== falseTarget) {
          body.push(WASM_OP.block, WASM_VOID);
          controlStack.push({ kind: "block", targetBlockId: join });
          wat(`block $join_${join}`);
          watIndent++;
        }
      }
      body.push(WASM_OP.block, WASM_VOID);
      controlStack.push({ kind: "block", targetBlockId: wrapTarget });
      wat(`;; B${blockId} (if-else${invertedDiamond ? ", inverted" : ""})`);
      wat(`block $else_${wrapTarget}`);
      watIndent++;
    } else if (block.ops.length > 0) {
      wat(`;; B${blockId}`);
    }

    // 通常の命令を出力
    for (const op of block.ops) {
      if (op.opcode === "Branch") {
        // Branch 経由のエッジにも Phi 書き込みが要る (|| / && / 三項の
        // スタック Phi は Branch の true 側から値を受ける)。同じ Phi が
        // 両 successor から異なる値を貰うことは無い (Phi は 1 ブロックに
        // 属する) ので、br_if の前に無条件で書いてよい
        const bwrites = phiWrites.get(blockId);
        if (bwrites) {
          for (const { phiLocal, valueId } of bwrites) {
            emitValueOrConst(valueId, body, opToLocal, opById);
            wat(`;; phi write (branch): local ${phiLocal} = v${valueId}`);
            body.push(WASM_OP.local_set, ...u32ToLEB128(phiLocal));
            wat(`local.set ${phiLocal}`);
          }
        }
        // 条件分岐: Branch の条件を出力
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
        // Phi の値を書き込み (fall-through = body 方向の場合)
        // Branch は条件が true → successors[0], false → successors[1] (builder の規約に依存)
        // ループヘッダの Branch: false → exit (block 脱出)
        if (loopInfo) {
          if (forceF64) {
            body.push(WASM_OP.f64_const, ...f64ToBytes(0));
            body.push(0x61); // f64.eq (= eqz 相当)
            wat("f64.const 0 / f64.eq");
          } else {
            body.push(WASM_OP.i32_eqz);
            wat("i32.eqz");
          }
          const exitDepth = controlStack.length - 1 - controlStack.findLastIndex(
            e => e.kind === "block" && e.targetBlockId === loopInfo.exitBlock
          );
          body.push(WASM_OP.br_if, exitDepth);
          wat(`br_if ${exitDepth} ;; → exit`);
        } else {
          // 非ループ: ダイヤモンドの向きに合わせて br。
          // 通常 (true 辺が fall-through): 条件反転して false なら skip
          // inverted (false 辺が fall-through, || / && 等): true なら skip
          const nextEmit2 = topoNext.get(blockId);
          const inverted2 = block.successors[1] === nextEmit2 && block.successors[0] !== nextEmit2;
          if (!inverted2) {
            if (forceF64) {
              body.push(WASM_OP.f64_const, ...f64ToBytes(0));
              body.push(0x61); // f64.eq (= eqz 相当)
              wat("f64.const 0 / f64.eq");
            } else {
              body.push(WASM_OP.i32_eqz);
              wat("i32.eqz");
            }
          } else if (forceF64) {
            // inverted: 真値でジャンプ。f64 の truthiness を i32 に
            body.push(WASM_OP.f64_const, ...f64ToBytes(0));
            body.push(0x62); // f64.ne
            wat("f64.const 0 / f64.ne");
          }
          const skipDepth = controlStack.length - 1 - controlStack.findLastIndex(
            e => e.kind === "block"
          );
          body.push(WASM_OP.br_if, skipDepth);
          wat(`br_if ${skipDepth} ;; → ${inverted2 ? "join (skip false branch)" : "else (skip true branch)"}`);
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
            body.push(WASM_OP.local_set, ...u32ToLEB128(phiLocal));
            wat(`local.set ${phiLocal}`);
          }
        }
        if (jumpTarget !== undefined && cfg.backEdges.has(`${blockId}→${jumpTarget}`)) {
          const loopDepth = controlStack.length - 1 - controlStack.findLastIndex(
            e => e.kind === "loop" && e.targetBlockId === jumpTarget
          );
          body.push(WASM_OP.br, loopDepth);
          wat(`br ${loopDepth} ;; → loop`);
        } else if (jumpTarget !== undefined && jumpTarget !== topoNext.get(blockId)) {
          // forward jump が fall-through でない (then → join の飛び越え等):
          // 対応する block end があれば br で抜ける
          const idx = controlStack.findLastIndex(e => e.kind === "block" && e.targetBlockId === jumpTarget);
          if (idx >= 0) {
            const depth = controlStack.length - 1 - idx;
            body.push(WASM_OP.br, depth);
            wat(`br ${depth} ;; → join B${jumpTarget}`);
          }
        }
        // それ以外の forward jump は fall-through
      } else if (op.opcode === "Return") {
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
        wat(`local.get ${opToLocal.get(op.args[0]) ?? "?"} ;; v${op.args[0]}`);
        body.push(WASM_OP.return);
        wat("return");
      } else {
        const beforeLen = body.length;
        emitOp(op, body, opToLocal, irFunc, needsLocal, [], [], new Set(), opById, globalToLocal, forceF64, arrayTypeIdx, upvalueCount, propOffsets, importIndices, importCount, growCtx, clusterCtx, usedIds);
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

    // (if-else の block end はブロック処理の前に移動済み)
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
        initCode.push(WASM_OP.local_set, ...u32ToLEB128(phiLocal));
      }
    }
  }

  const paramStr = Array.from({length: irFunc.paramCount}, (_, i) => `(param $p${i} i32)`).join(" ");
  const header = `(func $${irFunc.name} ${paramStr} (result i32)`;
  const localDecls = nextLocal > irFunc.paramCount
    ? `  (local ${Array(nextLocal - irFunc.paramCount).fill("i32").join(" ")})`
    : "";
  const fullWat = [header, localDecls, ";; phi init", ...watLines, ")"].filter(Boolean).join("\n");

  // extraLocals は scalar group の数 (ref local は別グループ)。
  // propNames[offset] = プロパティ名 (executeWasm の copy-in/out 用)
  const propNames: string[] = [];
  for (const [name, off] of propOffsets) propNames[off] = name;
  return { body: [...initCode, ...body], extraLocals, lenLocals, refLocals, wat: fullWat, propNames, writtenProps: [...writtenProps], globalNames, hasStoreGlobal };
}

// ========== Op → Wasm 命令 ==========

// growable 配列の codegen コンテキスト
type GrowCtx = {
  growableArrayValues: Set<number>;
  growableLenLocal: Map<number, number>;    // 配列 id → length local (i32)
  growableBackingLocal: Map<number, number>; // 配列 id → backing local (ref)
  growFnIndex: number;                        // __grow ヘルパの関数 index
  arrayTypeIdx: number;
};

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
  importIndices: Map<string, number> = new Map(),
  importCount = 0,
  growCtx?: GrowCtx,
  clusterCtx?: ClusterCtx | null,
  usedIds?: Set<number>,
): void {
  // forceF64 なら全演算を f64 として扱う
  const effectiveType = forceF64 ? "f64" : op.type;
  // growable 配列かどうか
  const isGrowable = (id: number) => growCtx?.growableArrayValues.has(id) ?? false;
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
      // undefined → 数値モデルでは 0 (f64 モードでは f64 の 0)
      if (forceF64) body.push(WASM_OP.f64_const, ...f64ToBytes(0));
      else body.push(WASM_OP.i32_const, ...i32ToLEB128(0));
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }

    case "LoadGlobal": {
      // 自己再帰の callee 参照は skip (Call で直接 call 0 する)
      if (op.globalName === irFunc.name) break;
      // "Math" / "Array" の参照は dispatch / AllocArray で消費されるので emit 不要
      if (op.globalName === "Math" || op.globalName === "Array") break;
      // undefined は数値モデルでは 0 (Undefined op と同じ扱い)
      if (op.globalName === "undefined") {
        if (forceF64) body.push(WASM_OP.f64_const, ...f64ToBytes(0));
        else body.push(WASM_OP.i32_const, ...i32ToLEB128(0));
        maybeStoreLocal(op.id, body, opToLocal, needsLocal);
        break;
      }
      const gLocal = globalToLocal.get(op.globalName!);
      if (gLocal !== undefined) {
        body.push(WASM_OP.local_get, ...u32ToLEB128(gLocal));
        maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      }
      break;
    }
    // 配列操作 (WasmGC array)
    case "ArrayGet": {
      if (arrayTypeIdx >= 0) {
        if (isGrowable(op.args[0])) {
          body.push(WASM_OP.local_get, ...u32ToLEB128(growCtx!.growableBackingLocal.get(op.args[0])!)); // backing
        } else {
          emitLoadValue(op.args[0], body, opToLocal, opById, forceF64); // arr ref
        }
        emitLoadValue(op.args[1], body, opToLocal, opById, forceF64); // index
        if (forceF64) body.push(0xab); // i32.trunc_f64_s (index must be i32 for array.get)
        body.push(0xfb, WASM_GC_OP.array_get, arrayTypeIdx);
        // f64 array → result is already f64, no conversion needed
        maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      }
      break;
    }
    case "ArraySet": {
      if (isGrowable(op.args[0]) && growCtx && growCtx.growFnIndex >= 0) {
        // a[i] = x (動的成長)。i >= cap なら grow、backing[i]=x、len=max(len,i+1)。
        // index は複数回使うので emitLoadValue で都度ロード (local 化済み or const)。
        const lenL = growCtx.growableLenLocal.get(op.args[0])!;
        const backL = growCtx.growableBackingLocal.get(op.args[0])!;
        const emitIdx = () => {
          emitLoadValue(op.args[1], body, opToLocal, opById, forceF64);
          if (forceF64) body.push(0xab); // i32.trunc_f64_s
        };
        // if (array.len(backing) <= i) backing = __grow(backing, i+1)
        body.push(WASM_OP.local_get, ...u32ToLEB128(backL), 0xfb, WASM_GC_OP.array_len);
        emitIdx();
        body.push(0x4c); // i32.le_s
        body.push(WASM_OP.if, 0x40);
        body.push(WASM_OP.local_get, ...u32ToLEB128(backL));
        emitIdx(); body.push(WASM_OP.i32_const, 1, WASM_OP.i32_add); // mincap = i+1
        body.push(WASM_OP.call, ...u32ToLEB128(growCtx.growFnIndex));
        body.push(WASM_OP.local_set, ...u32ToLEB128(backL));
        body.push(WASM_OP.end);
        // backing[i] = value
        body.push(WASM_OP.local_get, ...u32ToLEB128(backL));
        emitIdx();
        emitLoadValue(op.args[2], body, opToLocal, opById, forceF64);
        body.push(0xfb, WASM_GC_OP.array_set, arrayTypeIdx);
        // len = max(len, i+1)
        emitIdx(); body.push(WASM_OP.i32_const, 1, WASM_OP.i32_add); // i+1
        body.push(WASM_OP.local_get, ...u32ToLEB128(lenL));
        body.push(0x4a); // i32.gt_s : (i+1) > len
        body.push(WASM_OP.if, 0x40);
        emitIdx(); body.push(WASM_OP.i32_const, 1, WASM_OP.i32_add, WASM_OP.local_set, ...u32ToLEB128(lenL));
        body.push(WASM_OP.end);
      } else if (arrayTypeIdx >= 0) {
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64); // arr ref
        emitLoadValue(op.args[1], body, opToLocal, opById, forceF64); // index
        if (forceF64) body.push(0xab); // i32.trunc_f64_s
        emitLoadValue(op.args[2], body, opToLocal, opById, forceF64); // value (f64 array takes f64)
        body.push(0xfb, WASM_GC_OP.array_set, arrayTypeIdx);
      }
      break;
    }
    case "ArrayLength": {
      if (isGrowable(op.args[0])) {
        body.push(WASM_OP.local_get, ...u32ToLEB128(growCtx!.growableLenLocal.get(op.args[0])!)); // length (i32)
        if (forceF64) body.push(0xb7); // f64.convert_i32_s
      } else if (arrayTypeIdx >= 0) {
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64); // arr ref
        body.push(0xfb, WASM_GC_OP.array_len);
        if (forceF64) body.push(0xb7); // f64.convert_i32_s
      }
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }
    case "AllocGrowableArray": {
      // [] → len=0, backing=array.new_default(初期容量 4)
      if (growCtx && arrayTypeIdx >= 0) {
        const lenL = growCtx.growableLenLocal.get(op.id)!;
        const backL = growCtx.growableBackingLocal.get(op.id)!;
        body.push(WASM_OP.i32_const, 0, WASM_OP.local_set, ...u32ToLEB128(lenL));
        body.push(WASM_OP.i32_const, 4, 0xfb, WASM_GC_OP.array_new_default, arrayTypeIdx, WASM_OP.local_set, ...u32ToLEB128(backL));
      }
      break;
    }
    case "ArrayPush": {
      // 末尾追加: 容量超過なら __grow で 2 倍に再確保コピーしてから set、len++
      if (growCtx && arrayTypeIdx >= 0 && growCtx.growFnIndex >= 0) {
        const lenL = growCtx.growableLenLocal.get(op.args[0])!;
        const backL = growCtx.growableBackingLocal.get(op.args[0])!;
        // if (array.len(backing) <= len) backing = __grow(backing, len+1)
        body.push(WASM_OP.local_get, ...u32ToLEB128(backL), 0xfb, WASM_GC_OP.array_len);
        body.push(WASM_OP.local_get, ...u32ToLEB128(lenL));
        body.push(0x4c); // i32.le_s
        body.push(WASM_OP.if, 0x40); // if (void)
        body.push(WASM_OP.local_get, ...u32ToLEB128(backL));
        body.push(WASM_OP.local_get, ...u32ToLEB128(lenL), WASM_OP.i32_const, 1, WASM_OP.i32_add); // mincap = len+1
        body.push(WASM_OP.call, ...u32ToLEB128(growCtx.growFnIndex));
        body.push(WASM_OP.local_set, ...u32ToLEB128(backL));
        body.push(WASM_OP.end);
        // backing[len] = value
        body.push(WASM_OP.local_get, ...u32ToLEB128(backL));
        body.push(WASM_OP.local_get, ...u32ToLEB128(lenL));
        emitLoadValue(op.args[1], body, opToLocal, opById, forceF64);
        body.push(0xfb, WASM_GC_OP.array_set, arrayTypeIdx);
        // len = len + 1
        body.push(WASM_OP.local_get, ...u32ToLEB128(lenL), WASM_OP.i32_const, 1, WASM_OP.i32_add, WASM_OP.local_set, ...u32ToLEB128(lenL));
      }
      break;
    }
    case "AllocArray": {
      // new Array(n) → array.new_default $arr (要素は 0 / 0.0 で初期化)。
      // 結果の ref は専用 ref 型 local に格納し、以降の ArrayGet/Set は
      // emitLoadValue(args[0]) で local.get する。
      if (arrayTypeIdx >= 0) {
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64); // length
        if (forceF64) body.push(0xab); // i32.trunc_f64_s (length は i32)
        body.push(0xfb, WASM_GC_OP.array_new_default, arrayTypeIdx);
        const refLocal = opToLocal.get(op.id);
        if (refLocal !== undefined) body.push(WASM_OP.local_set, ...u32ToLEB128(refLocal));
      }
      break;
    }

    case "StoreGlobal": {
      const gLocal = globalToLocal.get(op.globalName!);
      if (gLocal !== undefined) {
        emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
        body.push(WASM_OP.local_set, ...u32ToLEB128(gLocal));
      }
      break;
    }

    case "LoadUpvalue": {
      // upvalue は追加パラメータ: local index = irFunc.paramCount + upvalue index
      const uvLocal = irFunc.paramCount + op.index!;
      body.push(WASM_OP.local_get, ...u32ToLEB128(uvLocal));
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }
    case "StoreUpvalue": {
      const uvLocal = irFunc.paramCount + op.index!;
      emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
      body.push(WASM_OP.local_set, ...u32ToLEB128(uvLocal));
      break;
    }

    case "LoadThis": {
      // this は upvalue の後の追加パラメータ
      const thisLocal = irFunc.paramCount + upvalueCount;
      body.push(WASM_OP.local_get, ...u32ToLEB128(thisLocal));
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
      break;
    }
    case "LoadProperty": {
      // Math.X の参照: Call dispatch で消費されるので emit 不要
      if (op.calleeName?.startsWith("Math.")) break;
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
        emitLoadValue(op.args[1], body, opToLocal, opById, forceF64); // value
        if (forceF64) body.push(0xaa); // i32.trunc_f64_s (プロパティは i32 セル)
        body.push(WASM_OP.i32_store, 0x02, 0x00);
      }
      break;
    }

    case "Call": {
      // クラスタ呼び出し: 同一モジュール内の callee へ直接 call。
      // args は実引数のみ (callee ref は jit.ts が除去済み)。
      // 実引数 → callee の upvalue 供給 param の順に積む
      if (op.clusterCallee !== undefined && clusterCtx) {
        for (const a of op.args) emitLoadValue(a, body, opToLocal, opById, forceF64);
        for (const src of op.clusterSrcs ?? []) {
          body.push(WASM_OP.local_get, ...u32ToLEB128(clusterCtx.srcToParam(src)));
        }
        body.push(WASM_OP.call, ...u32ToLEB128(clusterCtx.funcIndexBase + op.clusterCallee));
        if (usedIds && !usedIds.has(op.id) && !needsLocal.has(op.id)) {
          body.push(0x1a); // drop (結果未使用: set_bnd(b,x); 等の文)
        } else {
          maybeStoreLocal(op.id, body, opToLocal, needsLocal);
        }
        break;
      }
      const cname = op.calleeName;
      if (cname === "__await") {
        // JSPI: call import $__await(value) → suspend/resume
        // args: [value] (Await は IR builder で calleeRef を持たず単一引数)
        for (const argId of op.args) {
          emitLoadValue(argId, body, opToLocal, opById, forceF64);
        }
        const idx = importIndices?.get("__await") ?? 0;
        body.push(WASM_OP.call, ...u32ToLEB128(idx));
      } else if (cname && cname.startsWith("Math.")) {
        // op.args = [calleeRef, arg0, arg1, ...]
        const argc = op.args.length - 1;
        const cls = classifyMathCall(cname, argc);
        for (let i = 1; i < op.args.length; i++) {
          emitLoadValue(op.args[i], body, opToLocal, opById, /* forceF64 */ true);
        }
        if (cls === "native_unary") {
          body.push(MATH_NATIVE_UNARY[cname]);
        } else if (cls === "native_binary") {
          body.push(MATH_NATIVE_BINARY[cname]);
        } else if (cls === "host") {
          const idx = importIndices?.get(cname);
          if (idx === undefined) throw new Error(`Math import not registered: ${cname}`);
          body.push(WASM_OP.call, ...u32ToLEB128(idx));
        } else {
          throw new Error(`Unsupported Math call: ${cname}/${argc}`);
        }
      } else {
        // 自己再帰: func index = importCount + 0 (自分自身は最初に追加された関数)
        // args: [calleeRef, arg0, arg1, ...]
        for (let i = 1; i < op.args.length; i++) {
          emitLoadValue(op.args[i], body, opToLocal, opById, forceF64);
        }
        body.push(WASM_OP.call, ...u32ToLEB128(importCount));
      }
      maybeStoreLocal(op.id, body, opToLocal, needsLocal);
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
      // forceF64 では bool も f64 (0/1) に正規化する。比較結果 (i32) が
      // f64 local/Phi を通ると型崩れするため (|| の stack Phi で顕在化)
      if (forceF64) body.push(WASM_OP.f64_convert_i32_s);
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
      // !x = x == 0 (forceF64 では f64 比較で受けて f64 0/1 を返す)
      emitLoadValue(op.args[0], body, opToLocal, opById, forceF64);
      if (forceF64) {
        body.push(WASM_OP.f64_const, ...f64ToBytes(0));
        body.push(0x61); // f64.eq → i32
        body.push(WASM_OP.f64_convert_i32_s);
      } else {
        body.push(WASM_OP.i32_eqz);
      }
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
    body.push(WASM_OP.local_get, ...u32ToLEB128(local));
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
    body.push(WASM_OP.local_get, ...u32ToLEB128(local));
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
    body.push(WASM_OP.local_get, ...u32ToLEB128(op.index));
    return;
  }
  // fallback: i32.const 0
  body.push(WASM_OP.i32_const, 0);
}

// local を持つ値を local に保存。
// 消費側は emitLoadValue/emitValueOrConst で必ず local.get するので、ここは
// local.set でスタックから降ろす (local.tee で残すと誰も消費せず stray になり、
// ループ back-edge でスタック不一致を起こす。return 前なら frame 巻き取りで
// 無害だが two-loop 等のループ内で詰む)。
function maybeStoreLocal(opId: number, body: number[], opToLocal: Map<number, number>, needsLocal: Set<number>): void {
  if (needsLocal.has(opId)) {
    const local = opToLocal.get(opId)!;
    body.push(WASM_OP.local_set, ...u32ToLEB128(local));
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

export function compileIRToWasm(irFunc: IRFunction, osrLocalCount?: number, cluster?: ClusterInfo | null): { instance: WebAssembly.Instance; funcName: string; hasArrayOps?: boolean; arrayParams?: number[]; upvalueCount?: number; hasThis?: boolean; propNames?: string[]; writtenProps?: string[]; globalNames?: string[]; memory?: WebAssembly.Memory; hasAwait?: boolean; jspiWrapped?: (...args: number[]) => Promise<number> } | null {
  try {
    // builder がスタック合流の深さ不一致を検出した関数は表現不能 → 拒否
    if ((irFunc as { stackMismatch?: boolean }).stackMismatch) {
      if (DEBUG_WASM) console.error("[compileIRToWasm] reject: stack depth mismatch at merge (unstructured stack flow)");
      return null;
    }
    // IR に Wasm 化できない Op が含まれてたらスキップ
    let hasArrayOps = false;
    let hasSelfRecursion = false;
    let hasAwait = false;
    const mathHostImports = new Set<string>(); // 必要な Math host import (Math.sin など)
    for (const block of irFunc.blocks) {
      for (const op of block.ops) {
        if (op.opcode === "Call") {
          if (op.calleeName === "__await") {
            hasAwait = true; // JSPI await → import call
          } else if (op.calleeName === irFunc.name && !hasArrayOps) {
            hasSelfRecursion = true;
          } else if (op.calleeName?.startsWith("Math.")) {
            const argc = op.args.length - 1;
            const cls = classifyMathCall(op.calleeName, argc);
            if (cls === "unsupported") {
              if (DEBUG_WASM) console.error("[compileIRToWasm] reject: unsupported Math call", op.calleeName, "argc=", argc);
              return null;
            }
            if (cls === "host") mathHostImports.add(op.calleeName);
            // native_unary / native_binary は import 不要
          } else if (op.clusterCallee !== undefined) {
            // クラスタ解決済み: 同一モジュール内 call になるので OK
          } else {
            if (DEBUG_WASM) console.error("[compileIRToWasm] reject: unknown call", op.calleeName, "args=", op.args.length);
            return null; // 他の関数 or 自己再帰+配列 → 未対応
          }
        }
        // 配列 Op を検出 (WasmGC array 構築が必要)
        if (op.opcode === "ArrayGet" || op.opcode === "ArraySet" || op.opcode === "ArrayLength"
            || op.opcode === "AllocArray" || op.opcode === "AllocGrowableArray" || op.opcode === "ArrayPush") {
          hasArrayOps = true;
        }
        if (op.opcode === "Const" && op.value !== undefined &&
            typeof op.value !== "number" && typeof op.value !== "boolean" &&
            op.value !== null) return null; // 非数値 Const (関数オブジェクト等)
      }
    }

    // クラスタ callee 側の配列 op / Math import も module 全体の要件に含める
    if (cluster) {
      for (const c of cluster.callees) {
        for (const block of c.ir.blocks) {
          for (const op of block.ops) {
            if (op.opcode === "ArrayGet" || op.opcode === "ArraySet" || op.opcode === "ArrayLength") hasArrayOps = true;
            if (op.opcode === "Call" && op.calleeName?.startsWith("Math.")) {
              const cls = classifyMathCall(op.calleeName, op.args.length - 1);
              if (cls === "unsupported") return null;
              if (cls === "host") mathHostImports.add(op.calleeName);
            }
          }
        }
      }
    }

    const builder = new WasmBuilder();
    const importIndices = new Map<string, number>();

    // JSPI: __await import を追加 (型は wasmType に合わせる)
    if (hasAwait) {
      // Range Analysis の結果に合わせて f64 or i32
      const awaitType = functionNeedsF64(irFunc) ? WASM_TYPE.f64 : WASM_TYPE.i32;
      const idx = builder.addImport("env", "__await", [awaitType], [awaitType]);
      importIndices.set("__await", idx);
    }

    // Math host import を追加 (全て f64 in / f64 out)
    for (const name of mathHostImports) {
      const arity = MATH_HOST_IMPORTS[name];
      const params = arity === 2 ? [WASM_TYPE.f64, WASM_TYPE.f64] : [WASM_TYPE.f64];
      const idx = builder.addImport("env", name, params, [WASM_TYPE.f64]);
      importIndices.set(name, idx);
    }

    // Range Analysis: i32 で overflow するなら全体を f64 に昇格。
    // クラスタは呼び出し規約を揃えるため 1 つでも f64 なら全員 f64
    const useF64 = functionNeedsF64(irFunc) || (cluster?.callees.some(c => functionNeedsF64(c.ir)) ?? false);
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

    // 配列 ref を運ぶ値の集合 (AllocArray/AllocGrowableArray 結果 + 配列
    // オペランド + それらを合流する Phi)。local 割り当てに使う。
    const arrayRefValues = new Set<number>();
    const growableArrayValues = new Set<number>(); // [] 由来の動的成長配列
    if (hasArrayOps) {
      for (const block of irFunc.blocks) {
        for (const op of block.ops) {
          if (op.opcode === "AllocArray") arrayRefValues.add(op.id);
          if (op.opcode === "AllocGrowableArray") { arrayRefValues.add(op.id); growableArrayValues.add(op.id); }
          if ((op.opcode === "ArrayGet" || op.opcode === "ArraySet" || op.opcode === "ArrayLength" || op.opcode === "ArrayPush") && op.args[0] !== undefined) {
            arrayRefValues.add(op.args[0]);
          }
        }
      }
      // Phi 経由で伝播 (双方向):
      // 下り: 配列を運ぶ Phi の入力も配列 ref
      // 上り: 入力に配列があれば Phi 自身も配列 ref (スタック Phi が配列を
      //       乗せて合流し、使用が cluster call 引数だけのケースで必要)
      let changed = true;
      while (changed) {
        changed = false;
        for (const block of irFunc.blocks) {
          for (const phi of block.phis) {
            if (!arrayRefValues.has(phi.id) && phi.inputs.some(([, vid]) => arrayRefValues.has(vid))) {
              arrayRefValues.add(phi.id);
              changed = true;
            }
            if (arrayRefValues.has(phi.id)) {
              for (const [, vid] of phi.inputs) {
                if (!arrayRefValues.has(vid)) { arrayRefValues.add(vid); changed = true; }
                if (growableArrayValues.has(phi.id) && !growableArrayValues.has(vid)) { growableArrayValues.add(vid); changed = true; }
              }
            }
          }
        }
      }
      // growable 配列が Phi で他の配列と合流すると len/backing local の併合が
      // 必要になり複雑。SSA collapse 後は単一代入なら Phi にならないので、
      // growable 値が Phi になっていたら (= 再代入された) VM フォールバック。
      for (const block of irFunc.blocks) {
        for (const phi of block.phis) {
          if (growableArrayValues.has(phi.id) && phi.inputs.length > 0) {
            if (DEBUG_WASM) console.error("[compileIRToWasm] reject: growable array carried by phi (reassigned)");
            return null;
          }
        }
      }
      // escape 解析: 配列 ref が 配列オペランド (args[0]) か Phi 入力以外で
      // 使われたら (Return / Call 引数 / ArraySet の value 等) VM フォールバック。
      // growable は ArrayPush の args[0] も許可。
      for (const block of irFunc.blocks) {
        for (const op of block.ops) {
          for (let i = 0; i < op.args.length; i++) {
            const argId = op.args[i];
            if (!arrayRefValues.has(argId)) continue;
            const isArrayOperand =
              ((op.opcode === "ArrayGet" || op.opcode === "ArraySet" || op.opcode === "ArrayLength" || op.opcode === "ArrayPush") && i === 0)
              // クラスタ呼び出しの引数は同一モジュール内の WasmGC ref 渡し (escape しない)
              || (op.opcode === "Call" && op.clusterCallee !== undefined);
            if (!isArrayOperand) {
              if (DEBUG_WASM) console.error("[compileIRToWasm] reject: array ref escapes via", op.opcode, "arg", i);
              return null;
            }
          }
        }
      }
      // 要素の型チェック: WasmGC array は i32/f64 のみ。配列に格納する値が
      // object (Alloc — base address は i32 だが意味的には非数値) だと、
      // 数値配列として誤コンパイルされる (a[0]+a[1] が文字列連結でなく
      // アドレスの加算になる)。Alloc を格納する配列は VM フォールバック。
      const opByIdForElem = new Map<number, Op>();
      for (const block of irFunc.blocks) {
        for (const phi of block.phis) opByIdForElem.set(phi.id, phi);
        for (const op of block.ops) opByIdForElem.set(op.id, op);
      }
      // 数値を生む opcode のホワイトリスト (これ以外を配列に格納したら bail)。
      // LoadGlobal("undefined") / Alloc(object) / LoadProperty 等は非数値。
      const NUMERIC_OPCODES = new Set<string>([
        "Param", "Add", "Sub", "Mul", "Div", "Mod", "Negate",
        "BitAnd", "BitOr", "BitXor", "BitNot", "ShiftLeft", "ShiftRight",
        "LessThan", "LessEqual", "GreaterThan", "GreaterEqual",
        "Equal", "StrictEqual", "NotEqual", "StrictNotEqual", "Not",
        "ArrayGet", "ArrayLength", "Call", "TypeGuard", "LoadUpvalue", "LoadThis",
      ]);
      const isNumericValue = (id: number | undefined): boolean => {
        if (id === undefined) return false; // 引数欠落 (object リテラル等を落とした)
        const o = opByIdForElem.get(id);
        if (!o) return false;
        if (o.opcode === "Const") return typeof o.value === "number" || typeof o.value === "boolean";
        if (o.opcode === "Phi") return (o as PhiOp).inputs.every(([, vid]) => isNumericValue(vid));
        return NUMERIC_OPCODES.has(o.opcode);
      };
      for (const block of irFunc.blocks) {
        for (const op of block.ops) {
          // ArrayPush(arr, value) の value、ArraySet(arr, idx, value) の value
          const isPush = op.opcode === "ArrayPush";
          const isSet = op.opcode === "ArraySet";
          if (!isPush && !isSet) continue;
          const valId = isPush ? op.args[1] : op.args[2];
          if (!isNumericValue(valId)) {
            if (DEBUG_WASM) console.error("[compileIRToWasm] reject: non-numeric value stored in array");
            return null;
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
    // Math.X の LoadProperty / "Math" の LoadGlobal は dead code 扱いなので除外
    let hasThis = false;
    let hasPropertyOps = false;
    for (const block of irFunc.blocks) {
      for (const op of block.ops) {
        if (op.opcode === "LoadThis") hasThis = true;
        if (op.opcode === "StoreProperty") hasPropertyOps = true;
        if (op.opcode === "LoadProperty" && !op.calleeName?.startsWith("Math.")) hasPropertyOps = true;
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

    // パラメータ: 配列は ref $array、他は i32/f64、upvalue も追加。
    // params はエンコード済みバイト列。ref 型は 2 バイトなので、Wasm の型
    // セクションが要求する「値型の個数」は別途 paramValTypeCount で数える。
    const params: number[] = [];
    let paramValTypeCount = 0;
    for (let i = 0; i < irFunc.paramCount; i++) {
      if (arrayParams.has(i)) {
        params.push(...refType(arrayTypeIdx));
      } else {
        params.push(wasmType);
      }
      paramValTypeCount++;
    }
    // upvalue 追加パラメータ
    for (let i = 0; i < upvalueCount; i++) {
      params.push(wasmType);
      paramValTypeCount++;
    }
    // this 追加パラメータ (i32: メモリ上のベースアドレス)
    if (hasThis) {
      params.push(WASM_TYPE.i32);
      paramValTypeCount++;
    }
    const results = [wasmType];

    // growable 配列があれば __grow ヘルパを main の直後 (index importCount+1) に置く
    const hasGrowable = growableArrayValues.size > 0;
    const growFnIndex = hasGrowable ? builder.importCount + 1 + (cluster?.callees.length ?? 0) : -1;
    // tryCall 経路 (osrLocalCount 無し) ではグローバルを読み取り専用の追加
    // パラメータとして渡す。StoreGlobal を含む関数は VM 側へ書き戻す術が
    // 無いので reject (OSR は従来通り zero-init local で自己完結)
    const globalsAsParams = osrLocalCount === undefined;
    const { body: bodyCode, extraLocals, lenLocals, refLocals, propNames, writtenProps, globalNames, hasStoreGlobal, wat: mainWat } = codegenIR(irFunc, useF64, arrayTypeIdx, importIndices, builder.importCount, arrayRefValues, growableArrayValues, growFnIndex, globalsAsParams, cluster ?? null, builder.importCount + 1);
    if (globalsAsParams && hasStoreGlobal) {
      if (DEBUG_WASM) console.error("[compileIRToWasm] reject: StoreGlobal in tryCall path (no write-back for globals)");
      return null;
    }
    if (globalsAsParams) {
      for (let i = 0; i < globalNames.length; i++) { params.push(wasmType); paramValTypeCount++; }
    }
    if (cluster) {
      // callee 専用 upvalue box の値を受け取る追加パラメータ
      for (let i = 0; i < cluster.extraBoxCount; i++) { params.push(wasmType); paramValTypeCount++; }
    }

    // OSR モード: extra locals もパラメータに含める (VM から全 locals を受け取る)
    if (osrLocalCount !== undefined && osrLocalCount > irFunc.paramCount) {
      const osrExtraParams = osrLocalCount - irFunc.paramCount;
      for (let i = 0; i < osrExtraParams; i++) {
        params.push(wasmType);
        paramValTypeCount++;
      }
    }

    const totalParamCount = paramValTypeCount;
    const localType = useF64 ? [WASM_TYPE.f64] : [wasmType];
    // OSR: extra locals をパラメータで渡すので Wasm locals を減らす
    const wasmExtraLocals = (osrLocalCount !== undefined) ? Math.max(0, extraLocals - (osrLocalCount - irFunc.paramCount)) : extraLocals;
    // local 宣言: [scalar group, len group (i32, growable 用), ref group]。
    // codegenIR の index 割り当て (scalar → len → ref の順) と一致させる。
    const groups: LocalGroup[] = [];
    if (wasmExtraLocals > 0) groups.push({ count: wasmExtraLocals, type: localType });
    if (lenLocals > 0) groups.push({ count: lenLocals, type: [WASM_TYPE.i32] });
    if (refLocals > 0 && arrayTypeIdx >= 0) groups.push({ count: refLocals, type: refType(arrayTypeIdx) });
    const extraLocalGroups = groups.length > 0 ? groups : undefined;
    if (typeof process !== "undefined" && process.env?.DEBUG_WAT) console.error(mainWat);
    builder.addFunction(irFunc.name, params, results, bodyCode,
      wasmExtraLocals + lenLocals + refLocals > 0 ? wasmExtraLocals + lenLocals + refLocals : 0,
      totalParamCount, 1, extraLocalGroups);

    // クラスタ callee を main の直後 (importCount+1 から) に配置。
    // callee の呼び出し規約: [params (配列は ref)..., upvalues (数値)...]
    if (cluster) {
      for (let ci = 0; ci < cluster.callees.length; ci++) {
        const callee = cluster.callees[ci];
        // dead slot (純度チェックで取り消された callee): index を保つため
        // 何もしないスタブ関数で埋める (どこからも呼ばれない)
        if (cluster.deadCallees?.has(ci)) {
          const stubBody = useF64
            ? [WASM_OP.f64_const, ...f64ToBytes(0), WASM_OP.end]
            : [WASM_OP.i32_const, 0, WASM_OP.end];
          builder.addFunction("__dead", [], results, stubBody, 0, 0, 1);
          continue;
        }
        const cir = callee.ir;
        // callee の配列 param 検出 (main と同じ規則)
        const cArrayParams = new Set<number>();
        const cParamIdToIndex = new Map<number, number>();
        for (const b of cir.blocks) {
          for (const o of b.ops) {
            if (o.opcode === "Param" && o.index !== undefined) cParamIdToIndex.set(o.id, o.index);
          }
        }
        const cArrayRefValues = new Set<number>();
        for (const b of cir.blocks) {
          for (const o of b.ops) {
            if ((o.opcode === "ArrayGet" || o.opcode === "ArraySet" || o.opcode === "ArrayLength") && o.args[0] !== undefined) {
              const pIdx = cParamIdToIndex.get(o.args[0]);
              if (pIdx === undefined) {
                // 配列が param 以外から来る callee は jit 側で除外済みのはずだが安全側で bail
                if (DEBUG_WASM) console.error("[compileIRToWasm] reject: cluster callee has non-param array");
                return null;
              }
              cArrayParams.add(pIdx);
              cArrayRefValues.add(o.args[0]);
            }
          }
        }
        let cUpvalueCount = 0;
        for (const b of cir.blocks) {
          for (const o of b.ops) {
            if ((o.opcode === "LoadUpvalue" || o.opcode === "StoreUpvalue") && o.index !== undefined) {
              cUpvalueCount = Math.max(cUpvalueCount, o.index + 1);
            }
            if (o.clusterSrcs) {
              for (const src of o.clusterSrcs) {
                if (src.kind === "own") cUpvalueCount = Math.max(cUpvalueCount, src.i + 1);
              }
            }
          }
        }
        // callee 自身も兄弟を呼びうる (深さ 2+) ので cluster ctx を渡す
        const cg = codegenIR(cir, useF64, arrayTypeIdx, importIndices, builder.importCount, cArrayRefValues, new Set(), growFnIndex, false, cluster, builder.importCount + 1);
        const cParams: number[] = [];
        let cParamValCount = 0;
        for (let i = 0; i < cir.paramCount; i++) {
          if (cArrayParams.has(i)) cParams.push(...refType(arrayTypeIdx));
          else cParams.push(wasmType);
          cParamValCount++;
        }
        for (let i = 0; i < cUpvalueCount; i++) { cParams.push(wasmType); cParamValCount++; }
        const cGroups: LocalGroup[] = [];
        const cLocalType = useF64 ? [WASM_TYPE.f64] : [wasmType];
        if (cg.extraLocals > 0) cGroups.push({ count: cg.extraLocals, type: cLocalType });
        if (cg.lenLocals > 0) cGroups.push({ count: cg.lenLocals, type: [WASM_TYPE.i32] });
        if (cg.refLocals > 0 && arrayTypeIdx >= 0) cGroups.push({ count: cg.refLocals, type: refType(arrayTypeIdx) });
        builder.addFunction(cir.name || "__cluster_callee", cParams, results, cg.body,
          cg.extraLocals + cg.lenLocals + cg.refLocals,
          cParamValCount, 1, cGroups.length > 0 ? cGroups : undefined);
      }
    }
    // __grow(old, mincap) → ref: 容量を max(mincap, oldcap*2) に拡張して
    // 旧要素をコピーした新しい backing array を返す (main の直後 = importCount+1)
    if (hasGrowable && arrayTypeIdx >= 0) {
      const growBody = [
        WASM_OP.local_get, 0, 0xfb, WASM_GC_OP.array_len,       // oldcap
        WASM_OP.i32_const, 1, 0x74,                              // << 1 → oldcap*2
        WASM_OP.local_set, 2,                                    // newcap = oldcap*2
        WASM_OP.local_get, 2, WASM_OP.local_get, 1, 0x48,        // newcap < mincap (i32.lt_s)
        WASM_OP.if, 0x40,
          WASM_OP.local_get, 1, WASM_OP.local_set, 2,            // newcap = mincap
        WASM_OP.end,
        WASM_OP.local_get, 2, 0xfb, WASM_GC_OP.array_new_default, arrayTypeIdx, WASM_OP.local_set, 3, // new
        // array.copy(new, 0, old, 0, array.len(old))
        WASM_OP.local_get, 3, WASM_OP.i32_const, 0,
        WASM_OP.local_get, 0, WASM_OP.i32_const, 0,
        WASM_OP.local_get, 0, 0xfb, WASM_GC_OP.array_len,
        0xfb, WASM_GC_OP.array_copy, arrayTypeIdx, arrayTypeIdx,
        WASM_OP.local_get, 3,
        WASM_OP.end,
      ];
      builder.addFunction("__grow", [...refType(arrayTypeIdx), WASM_TYPE.i32], refType(arrayTypeIdx),
        growBody, 0, 2, 1,
        [{ count: 1, type: [WASM_TYPE.i32] }, { count: 1, type: refType(arrayTypeIdx) }]);
    }
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

    // imports: JSPI __await + Math host imports
    const importObject: Record<string, Record<string, unknown>> = {};
    const env: Record<string, unknown> = {};
    if (hasAwait && typeof (WebAssembly as any).Suspending === "function") {
      env.__await = new (WebAssembly as any).Suspending(async (v: unknown) => {
        const resolved = await Promise.resolve(v);
        return resolved;
      });
    }
    for (const name of mathHostImports) {
      // "Math.sin" → Math.sin
      const methodName = name.slice(5); // strip "Math."
      env[name] = (Math as any)[methodName];
    }
    if (hasAwait || mathHostImports.size > 0) {
      importObject.env = env;
    }

    const instance = new WebAssembly.Instance(module, (hasAwait || mathHostImports.size > 0) ? importObject : undefined);
    const memory = hasPropertyOps ? (instance.exports as any).memory as WebAssembly.Memory : undefined;

    // JSPI: export を promising でラップ
    let jspiWrapped: ((...args: number[]) => Promise<number>) | undefined;
    if (hasAwait && typeof (WebAssembly as any).promising === "function") {
      jspiWrapped = (WebAssembly as any).promising(instance.exports[irFunc.name]) as any;
    }

    return {
      instance,
      funcName: irFunc.name,
      hasArrayOps,
      arrayParams: [...arrayParams],
      upvalueCount: upvalueCount > 0 ? upvalueCount : undefined,
      hasThis: hasThis || undefined,
      propNames: propNames.length > 0 ? propNames : undefined,
      writtenProps: writtenProps.length > 0 ? writtenProps : undefined,
      globalNames: globalsAsParams && globalNames.length > 0 ? globalNames : undefined,
      memory,
      hasAwait: hasAwait || undefined,
      jspiWrapped,
    };
  } catch (e: any) {
    // Wasm コンパイルエラー → null (フォールバック)
    if (DEBUG_WASM) console.error("[compileIRToWasm error]", e.message || e, e.stack);
    return null;
  }
}
