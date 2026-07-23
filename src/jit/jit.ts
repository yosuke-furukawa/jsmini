import type { BytecodeFunction } from "../vm/bytecode.js";
import { FeedbackCollector, classifyType, isArrayType } from "./feedback.js";
import { compileToWasmSync, compileMultiSync } from "./wasm-compiler.js";
import type { WasmNumericType } from "./feedback.js";
import { getElementKind, isTrackedArray } from "../vm/js-array.js";
import { isJSString, getInternId, getStringById } from "../vm/js-string.js";
import { isJSObject, getSlots, getHiddenClass, setProperty as jsObjSet } from "../vm/js-object.js";
import { buildIR } from "../ir/builder.js";
import { optimize, type InlineOptions } from "../ir/optimize.js";
import { compileIRToWasm, type ClusterInfo, type ClusterUpvalueSource } from "../ir/codegen.js";
import type { IRFunction } from "../ir/types.js";

// ブラウザ (playground) には process が無いので安全にガード
const DEBUG_WASM = typeof process !== "undefined" && !!process.env?.DEBUG_WASM;

// 関数の Return が boolean を返すかの保守的判定 (bytecode ベース)。
// JIT は bool を i32 0/1 で表現するため、そのまま返すと false が number 0 に
// 化ける。全 Return が bool 由来なら "bool" (呼び出し境界でデコード)、
// bool と非 bool が混在なら "mixed" (誤デコードを避けて compile しない)。
// bool 由来 = true/false リテラル・比較・論理否定の直後、または
// 「bool 由来しか代入されない local」の読み出し (線形近似の保守判定)
const BOOL_PRODUCERS = new Set([
  "LdaTrue", "LdaFalse", "LogicalNot",
  "LessThan", "GreaterThan", "LessEqual", "GreaterEqual",
  "Equal", "NotEqual", "StrictEqual", "StrictNotEqual",
]);
// -0 を生みうる Mul を bytecode に含むか (direct パスの spec 昇格用)。
// `x * 正の整数定数` は 0*正=+0 で -0 にならないので i32 のまま安全。
// それ以外の Mul (変数×変数, x×負定数) は i32.mul だと -0 が 0 に化けるため
// f64 spec に昇格させる (f64.mul は -0 を保持)。
function bytecodeHasRiskyMul(func: BytecodeFunction): boolean {
  const bc = func.bytecode;
  for (let i = 0; i < bc.length; i++) {
    if (bc[i].op !== "Mul") continue;
    const prev = bc[i - 1];
    if (prev && prev.op === "LdaConst" && prev.operand !== undefined) {
      const v = func.constants[prev.operand];
      if (typeof v === "number" && Number.isInteger(v) && v > 0) continue; // x * 正定数 は安全
    }
    return true;
  }
  return false;
}
function classifyBoolReturns(func: BytecodeFunction): "none" | "bool" | "mixed" {
  const bc = func.bytecode;
  const boolSlots = new Set<number>();
  const nonBoolSlots = new Set<number>();
  for (let i = 0; i < bc.length; i++) {
    if ((bc[i].op === "StaLocal" || bc[i].op === "StaLocalTDZ") && bc[i].operand !== undefined) {
      if (i > 0 && BOOL_PRODUCERS.has(bc[i - 1].op)) boolSlots.add(bc[i].operand!);
      else nonBoolSlots.add(bc[i].operand!);
    }
  }
  let sawBool = false, sawOther = false;
  for (let i = 0; i < bc.length; i++) {
    if (bc[i].op !== "Return") continue;
    const prev = i > 0 ? bc[i - 1] : undefined;
    // 関数末尾の暗黙エピローグ (LdaUndefined; Return) は分類から除外。
    // fall-through 経路の undefined は数値モデルでは元々 0 で表現されており
    // (bool デコードでも falsy のまま)、これを数えると全関数が混在判定になる
    if (i === bc.length - 1 && prev?.op === "LdaUndefined") continue;
    const isBool = prev !== undefined && (BOOL_PRODUCERS.has(prev.op) ||
      ((prev.op === "LdaLocal" || prev.op === "LdaLocalTDZ") && prev.operand !== undefined && boolSlots.has(prev.operand) && !nonBoolSlots.has(prev.operand)));
    if (isBool) sawBool = true; else sawOther = true;
  }
  return sawBool ? (sawOther ? "mixed" : "bool") : "none";
}
// ネストアクセス import が「VM に返すべき状況」(数値の deref 等) を検出した
// ときに投げる sentinel。executeWasm が捕まえて deopt → VM 再実行する
// (ネスト load は純粋読みで write-back 前なので再実行は安全)
const DEOPT_SENTINEL = new Error("__jsmini_jit_deopt__");
// デバッグ用: JIT_SKIP=name1,name2 で特定関数の JIT を無効化 (犯人の二分探索用)
const JIT_SKIP = new Set((typeof process !== "undefined" && process.env?.JIT_SKIP ? process.env.JIT_SKIP.split(",") : []));

export type JitOptions = {
  threshold: number;
  useIR?: boolean;
};

type CachedWasm = {
  fn: (...args: number[]) => number;
  memory: WebAssembly.Memory | null;
  arrayArgIndices: number[];
  stringArgIndices: number[];  // 文字列引数の位置
  spec: WasmNumericType;       // i32 or f64
  resultBool?: boolean;        // 全 Return が bool (リテラル/比較結果) → i32 0/1 を boolean にデコード
  // WasmGC 配列ヘルパー関数
  createArray: ((len: number) => unknown) | null;
  getArray: ((arr: unknown, idx: number) => number) | null;
  setArray: ((arr: unknown, idx: number, val: number) => void) | null;
  jspiWrapped?: (...args: number[]) => Promise<number>;  // JSPI promising 済み
  // this-model (IR パス): 関数が使うプロパティ名 (index = linear memory offset) と
  // StoreProperty されるプロパティ名 (実行後に write-back)
  propNames?: string[];
  writtenProps?: string[];
  // 読み取り専用グローバル (呼び出しごとに VM の値を追加パラメータで渡す)
  globalNames?: string[];
  // コンパイル済みモジュールが this パラメータを取るか (IR 基準)。
  // bytecode に LoadThis があっても最適化で消えていれば false — 
  // bytecode スキャンで判定すると「this を渡そうとして memory が無い」
  // ミスマッチで毎回 null になる (deltablue で 33k 回/走)
  hasThis?: boolean;
  // クラスタコンパイル (Phase 32): callee 解決の identity guard と
  // callee 専用 upvalue box (値を毎呼び出し追加パラメータで渡す)。
  // guard は box 参照で検査 (深さ 2+ の callee 内 box にも効く)。
  // idx は main の upvalue slot の場合のみ (ダミー 0 push 用)
  calleeGuards?: Array<{ idx?: number; box: { value: unknown }; expected: unknown }>;
  extraBoxes?: Array<{ value: unknown }>;
  // tagged スロット (Phase 33): V8 Smi 流の 1bit タグ (偶数=数値<<1,
  // 奇数=object table index)。null=1, undefined=3。参照は table で dedup
  taggedProps?: Set<string>;
  resultTagged?: boolean;
  objTable?: unknown[];
  objMap?: Map<unknown, number>;
  // Wasm 関数が実際に受け取る upvalue param 数 (IR 基準)。callee ref の
  // LoadUpvalue 除去で縮み得るので、これちょうどを push しないと
  // 後続の globals/extraBoxes が位置ズレする
  upvalueCount?: number;
  // 呼び出しオーバーヘッド削減用キャッシュ (小メソッドでは view 生成と
  // HC 名前引きが支配的になる)
  i32view?: Int32Array;                     // memory.buffer の共有 view (grow しない前提)
  hcSlotCache?: Map<unknown, (number | undefined)[]>; // HiddenClass → propNames の slot index 列
};

export class JitManager {
  private feedback: FeedbackCollector;
  private wasmCache: Map<BytecodeFunction, CachedWasm | null> = new Map();
  private threshold: number;
  private deoptimized: Set<BytecodeFunction> = new Set();

  // 関連関数グループ (同じ Wasm モジュールにコンパイルされた関数群)
  private funcGroups: Map<BytecodeFunction, BytecodeFunction[]> = new Map();
  // 関数名 → BytecodeFunction のマッピング (関連関数の解決用)
  private knownFuncs: Map<string, BytecodeFunction> = new Map();

  deoptLog: string[] = [];
  tierLog: string[] = [];
  // VM の globals (読み取り専用グローバルのパラメータ渡し用に VM 側から注入)
  globalsMap: Map<string, unknown> | null = null;
  traceTier = false;
  useIR = false;

  constructor(feedback: FeedbackCollector, options: JitOptions) {
    this.feedback = feedback;
    this.threshold = options.threshold;
    this.useIR = options.useIR ?? false;
  }

  // VM から関数を登録 (グローバル関数の追跡)
  registerFunc(name: string, func: BytecodeFunction): void {
    this.knownFuncs.set(name, func);
  }

  private logTier(func: BytecodeFunction, tier: string, callCount?: number): void {
    if (!this.traceTier) return;
    const count = callCount ?? this.feedback.get(func)?.callCount ?? 0;
    this.tierLog.push(`[TIER] ${func.name}: ${tier} (call #${count})`);
    if (DEBUG_WASM) console.error(`[TIER] ${func.name}: ${tier} (call #${count})`);
  }

  tryCall(func: BytecodeFunction, args: unknown[], upvalueValues: unknown[] = [], thisObj?: unknown, upvalueBoxes?: Array<{ value: unknown }>): { result: unknown } | null {
    // fast path: JIT の運命が決定済みの関数は簿記を全部スキップ
    // (VM 行きなら 1 プロパティ読みで抜ける。OO ベンチではこの簿記が
    //  JIT ≈ VM の主因だった)
    const decided = (func as { __jitCached?: CachedWasm | null }).__jitCached;
    if (decided === null) return null;
    if (decided !== undefined) {
      return this.executeWasm(func, decided, args, 0, upvalueValues, thisObj);
    }
    if (JIT_SKIP.size > 0 && JIT_SKIP.has(func.name)) return null;
    const fb = this.feedback.get(func);
    const callCount = fb?.callCount ?? 0;

    // 脱最適化済み → VM
    if (this.deoptimized.has(func)) {
      this.logTier(func, "Bytecode VM (deoptimized)", callCount);
      return null;
    }

    // キャッシュ確認
    if (this.wasmCache.has(func)) {
      const cached = this.wasmCache.get(func)!;
      if (!cached) {
        this.logTier(func, "Bytecode VM", callCount);
        return null;
      }
      return this.executeWasm(func, cached, args, callCount, upvalueValues, thisObj);
    }

    // しきい値チェック。ループを含む関数は「呼び出し回数は少ないが
    // 1 呼び出しの中で時間を食う」(NS のカーネル等) ので初回から
    // コンパイルを試す (V8 の loopy eager optimization 相当)
    const fobj = func as { __hasLoop?: boolean };
    if (fobj.__hasLoop === undefined) {
      fobj.__hasLoop = func.bytecode.some((ins, idx) =>
        (ins.op === "Jump" || ins.op === "JumpIfFalse" || ins.op === "JumpIfTrue") &&
        ins.operand !== undefined && ins.operand <= idx);
    }
    const effThreshold = fobj.__hasLoop ? 1 : this.threshold;
    if (!fb || callCount < effThreshold) {
      this.logTier(func, "Bytecode VM", callCount);
      return null;
    }

    // monomorphic チェック
    if (!fb.isMonomorphic) {
      this.wasmCache.set(func, null);
      (func as { __jitCached?: CachedWasm | null }).__jitCached = null;
      this.logTier(func, "Bytecode VM (polymorphic)", callCount);
      return null;
    }

    // class 継承 / spread 呼び出しオペコードは JIT 未対応。IR builder の未知
    // opcode は silent skip なので、誤コンパイルする前にここで VM 行きを確定する
    if (func.bytecode.some(i => i.op === "CallSuper" || i.op === "CallSuperArray"
        || i.op === "GetSuperProp" || i.op === "ClassLink"
        || i.op === "CallSpread" || i.op === "CallMethodSpread"
        || i.op === "ConstructSpread" || i.op === "CopyDataProps")) {
      this.wasmCache.set(func, null);
      (func as { __jitCached?: CachedWasm | null }).__jitCached = null;
      this.logTier(func, "Bytecode VM (super/spread)", callCount);
      return null;
    }

    const wasmArgTypes = this.feedback.getWasmArgTypes(func);
    if (!wasmArgTypes) {
      this.wasmCache.set(func, null);
      (func as { __jitCached?: CachedWasm | null }).__jitCached = null;
      this.logTier(func, "Bytecode VM (non-numeric)", callCount);
      return null;
    }

    // 配列引数の位置を特定
    const detailedTypes = fb.argTypes[0];
    const arrayArgIndices: number[] = [];
    const stringArgIndices: number[] = [];
    for (let i = 0; i < detailedTypes.length; i++) {
      if (isArrayType(detailedTypes[i])) arrayArgIndices.push(i);
      if (detailedTypes[i] === "interned_string") stringArgIndices.push(i);
    }

    // 型特殊化 (引数なしの場合はデフォルト i32)
    const allSame = wasmArgTypes.length === 0 || wasmArgTypes.every(t => t === wasmArgTypes[0]);
    let spec: WasmNumericType = allSame && (wasmArgTypes.length === 0 || wasmArgTypes[0] === "i32") ? "i32" : "f64";
    // -0 を生みうる Mul を含む i32 関数は f64 に昇格する。i32.mul は -0 を 0 に
    // 潰すが f64.mul は -0 を保持する (`1 / (0 * -1)` が -Infinity になる)。
    // Negate は direct パスが元々 i32 で bail して f64 リトライするので対象外。
    // IR パスは functionNeedsF64 が range 分析で別途 f64 化する
    if (spec === "i32" && bytecodeHasRiskyMul(func)) spec = "f64";

    // Return が bool の関数: 全 bool なら境界デコード、混在なら compile しない
    const boolRet = classifyBoolReturns(func);
    if (boolRet === "mixed") {
      this.wasmCache.set(func, null);
      (func as { __jitCached?: CachedWasm | null }).__jitCached = null;
      this.logTier(func, "Bytecode VM (bool/非bool 混在 return)", callCount);
      return null;
    }

    // IR パスを優先 (配列対応含む)
    let compiled: CachedWasm | null = null;
    if (this.useIR) {
      compiled = this.compileViaIR(func, spec, stringArgIndices, upvalueBoxes);
    }
    // IR パスが失敗 or useIR=false → direct パス。
    // ただし upvalue 持ちは direct パスの呼び出し規約に無く誤コンパイル
    // するので IR 専用 (lin_solve 形で実害があった)
    if (!compiled && func.upvalues.length === 0) {
      if (arrayArgIndices.length > 0) {
        compiled = this.compileWithRelatedFuncs(func, spec, arrayArgIndices);
        if (compiled) compiled.stringArgIndices = stringArgIndices;
      } else if (!func.bytecode.some(i => i.op === "LoadThis")) {
        // direct パスの this-model は memory を CachedWasm に渡せず実行できない
        // (旧実装は「compiled ログを出すが !memory で毎回 VM」という見せかけ
        //  JIT になっていた)。this 関数は IR パス専用にする
        // i32 で失敗したら f64 でリトライ (引数は i32 でも本体に 1e10 のような
        // i32 非表現定数があると i32 spec ではコンパイルできない)
        let usedSpec = spec;
        let wasmFn = compileToWasmSync(func, spec);
        if (!wasmFn && spec === "i32") {
          usedSpec = "f64";
          wasmFn = compileToWasmSync(func, "f64");
        }
        if (wasmFn) {
          compiled = { fn: wasmFn, memory: null, arrayArgIndices: [], stringArgIndices, spec: usedSpec, createArray: null, getArray: null, setArray: null };
        }
      }
    }

    if (compiled && boolRet === "bool") compiled.resultBool = true;
    this.wasmCache.set(func, compiled);
    (func as { __jitCached?: CachedWasm | null }).__jitCached = compiled;

    if (compiled) {
      this.logTier(func, `→ Wasm compiled (${compiled.spec}, arrays: [${arrayArgIndices}])`, callCount);
      return this.executeWasm(func, compiled, args, callCount, upvalueValues, thisObj);
    }

    this.logTier(func, "Bytecode VM", callCount);
    return null;
  }

  // クラスタ解決 (Phase 32): IR 内の「LoadUpvalue を callee とする Call」を
  // コンパイル時の box の値 (兄弟クロージャ) に解決し、同一モジュール内の
  // 直接 call に変換する。callee が更に兄弟を呼ぶ場合も再帰的に解決する
  // (深さ 2+: project → lin_solve → set_bnd)。
  // guard: 解決に使った box の中身が差し替わったら deopt (box 参照で検査)
  private resolveCluster(ir: IRFunction, upvalueBoxes: Array<{ value: unknown }>):
    { cluster: ClusterInfo; guards: Array<{ idx?: number; box: { value: unknown }; expected: unknown }>; extraBoxes: Array<{ value: unknown }> } | null {
    const callees: ClusterInfo["callees"] = [];
    const calleeBoxesList: Array<Array<{ value: unknown }>> = [];
    const calleeIndexByClosure = new Map<unknown, number>();
    const deadCallees = new Set<number>();
    const guards: Array<{ idx?: number; box: { value: unknown }; expected: unknown }> = [];
    const guardedBoxes = new Set<unknown>();
    const extraBoxes: Array<{ value: unknown }> = [];
    let resolvedAny = false;
    const MAX_CALLEES = 8;

    // fn の IR 内の upvalue-callee Call を解決する。
    // fnBoxes = fn 自身の box 列 (main: caller boxes / callee: capturedBoxes)。
    // isMain なら供給元に extraBox pool を使える (callee は自 box 限定)
    const resolveCallsIn = (fnIr: IRFunction, fnBoxes: Array<{ value: unknown }>, isMain: boolean): void => {
      const opById = new Map<number, { opcode: string; index?: number; id: number }>();
      for (const b of fnIr.blocks) for (const o of b.ops) opById.set(o.id, o);
      const removedRefIds: number[] = [];
      for (const block of fnIr.blocks) {
        for (const op of block.ops) {
          if (op.opcode !== "Call" || op.calleeName || op.clusterCallee !== undefined) continue;
          const calleeRef = opById.get(op.args[0]);
          if (!calleeRef || calleeRef.opcode !== "LoadUpvalue" || calleeRef.index === undefined) continue;
          const k = calleeRef.index;
          const box = fnBoxes[k];
          const v = box?.value;
          if (!v || typeof v !== "object") continue;
          const calleeIdx = this.ensureCalleeInCluster(v, callees, calleeBoxesList, calleeIndexByClosure, deadCallees, MAX_CALLEES, resolveCallsIn);
          if (calleeIdx === null) continue;
          // callee の upvalue 供給元を fn のパラメータ空間で解決
          const cBoxes = calleeBoxesList[calleeIdx];
          const cIr = callees[calleeIdx].ir;
          let cUpvalueMax = -1;
          for (const cb of cIr.blocks) for (const co of cb.ops) {
            if (co.opcode === "LoadUpvalue" && co.index !== undefined) cUpvalueMax = Math.max(cUpvalueMax, co.index);
            if (co.clusterSrcs) for (const src of co.clusterSrcs) if (src.kind === "own") cUpvalueMax = Math.max(cUpvalueMax, src.i);
          }
          const srcs: Array<{ kind: "own" | "extra"; i: number }> = [];
          let ok = true;
          for (let j = 0; j <= cUpvalueMax; j++) {
            const need = cBoxes[j];
            if (!need) { ok = false; break; }
            const ownIdx = fnBoxes.indexOf(need);
            if (ownIdx >= 0) { srcs.push({ kind: "own", i: ownIdx }); continue; }
            if (!isMain) { ok = false; break; } // callee は自 box 以外を供給できない (保守的に bail)
            let ei = extraBoxes.indexOf(need);
            if (ei < 0) { ei = extraBoxes.length; extraBoxes.push(need); }
            srcs.push({ kind: "extra", i: ei });
          }
          if (!ok) continue;
          op.clusterCallee = calleeIdx;
          op.clusterSrcs = srcs;
          op.args = op.args.slice(1);
          removedRefIds.push(calleeRef.id);
          if (!guardedBoxes.has(box)) {
            guardedBoxes.add(box);
            guards.push({ idx: isMain ? k : undefined, box, expected: v });
          }
          resolvedAny = true;
        }
      }
      // callee ref (LoadUpvalue) が他で使われていなければ除去
      if (removedRefIds.length > 0) {
        const stillUsed = new Set<number>();
        for (const b of fnIr.blocks) {
          for (const o of b.ops) for (const a of o.args) stillUsed.add(a);
          for (const ph of b.phis) for (const [, vid] of ph.inputs) stillUsed.add(vid);
        }
        for (const b of fnIr.blocks) {
          b.ops = b.ops.filter(o => !(removedRefIds.includes(o.id) && !stillUsed.has(o.id)));
        }
      }
    };

    resolveCallsIn(ir, upvalueBoxes, true);
    if (!resolvedAny) return null;
    return { cluster: { callees, extraBoxCount: extraBoxes.length, deadCallees }, guards, extraBoxes };
  }

  // closure をクラスタに登録し idx を返す (登録済みなら再利用)。
  // 登録時に callee IR を構築し、その中の兄弟呼び出しも再帰解決する。
  // 純度チェックに落ちたら null (呼び出し元は unknown call として reject される)
  private ensureCalleeInCluster(
    v: object,
    callees: ClusterInfo["callees"],
    calleeBoxesList: Array<Array<{ value: unknown }>>,
    calleeIndexByClosure: Map<unknown, number>,
    deadCallees: Set<number>,
    maxCallees: number,
    resolveCallsIn: (fnIr: IRFunction, fnBoxes: Array<{ value: unknown }>, isMain: boolean) => void,
  ): number | null {
    const existing = calleeIndexByClosure.get(v);
    if (existing !== undefined) return deadCallees.has(existing) ? null : existing;
    if (callees.length >= maxCallees) return null;
    const calleeBC = ("bytecode" in v ? v : (v as { func?: BytecodeFunction }).func) as BytecodeFunction | undefined;
    if (!calleeBC || !("bytecode" in calleeBC)) return null;
    const calleeBoxes = ((v as { capturedBoxes?: Array<{ value: unknown }> }).capturedBoxes) ?? [];
    const cir = buildIR(calleeBC, { feedback: this.feedback, knownFuncs: this.knownFuncs });
    optimize(cir, { knownFuncs: this.knownFuncs, buildIROptions: { feedback: this.feedback, knownFuncs: this.knownFuncs } });
    if ((cir as { stackMismatch?: boolean }).stackMismatch) return null;
    // 先に登録してから中身を解決する (自己再帰の兄弟呼び出しは自分に解決される)
    const idx = callees.length;
    callees.push({ ir: cir });
    calleeBoxesList.push(calleeBoxes);
    calleeIndexByClosure.set(v, idx);
    // callee 内の兄弟呼び出しを再帰解決 (callee の自 box 空間で)
    resolveCallsIn(cir, calleeBoxes, false);
    // 純度チェック: 解決されずに残った Call / 非対応 op があれば登録を取り消す
    let pure = true;
    for (const cb of cir.blocks) {
      for (const co of cb.ops) {
        if (co.opcode === "Call" && co.clusterCallee === undefined && !co.calleeName?.startsWith("Math.")) pure = false;
        if (co.opcode === "LoadThis" || co.opcode === "StoreUpvalue" || co.opcode === "StoreGlobal") pure = false;
        if (co.opcode === "Alloc" || co.opcode === "AllocArray" || co.opcode === "AllocGrowableArray" || co.opcode === "ArrayPush") pure = false;
        if (co.opcode === "LoadGlobal" && co.globalName && !["Math", "Array", "undefined"].includes(co.globalName) && co.globalName !== cir.name) pure = false;
      }
    }
    if (!pure) {
      // dead マーク (pop すると再帰で後続に積まれた callee の index がずれる)。
      // dead な slot は compileIRToWasm がスタブ関数で埋めて index を保つ
      deadCallees.add(idx);
      if (DEBUG_WASM) console.error(`[resolveCluster] callee "${calleeBC.name || "anon"}" is impure — dead slot ${idx}`);
      return null;
    }
    if (DEBUG_WASM) console.error(`[resolveCluster] resolved callee "${calleeBC.name || "anon"}" as cluster fn ${idx}`);
    return idx;
  }

  private compileViaIR(func: BytecodeFunction, spec: WasmNumericType, stringArgIndices: number[], upvalueBoxes?: Array<{ value: unknown }>): CachedWasm | null {
    try {
      const ir = buildIR(func, { feedback: this.feedback, knownFuncs: this.knownFuncs });
      optimize(ir, {
        knownFuncs: this.knownFuncs,
        buildIROptions: { feedback: this.feedback, knownFuncs: this.knownFuncs },
      });
      // クラスタ解決: upvalue 経由の兄弟クロージャ呼び出しをコンパイル時の
      // box の値で特殊化 (実行時は identity guard で守り、外れたら deopt)
      const resolved = upvalueBoxes && upvalueBoxes.length > 0
        ? this.resolveCluster(ir, upvalueBoxes) : null;
      const result = compileIRToWasm(ir, undefined, resolved?.cluster ?? null);
      if (!result) { if (DEBUG_WASM) console.error("[compileViaIR] compileIRToWasm returned null for", ir.name); return null; }
      const wasmFn = (result.instance.exports as any)[ir.name] as (...args: number[]) => number;
      if (!wasmFn) return null;

      // 配列ヘルパー
      const arrayArgIndices = result.arrayParams ?? [];
      const createArray = result.hasArrayOps ? (result.instance.exports as any).__create_array as ((len: number) => unknown) ?? null : null;
      const getArray = result.hasArrayOps ? (result.instance.exports as any).__get_array as ((arr: unknown, idx: number) => number) ?? null : null;
      const setArray = result.hasArrayOps ? (result.instance.exports as any).__set_array as ((arr: unknown, idx: number, val: number) => void) ?? null : null;

      const cached: CachedWasm = { fn: wasmFn, memory: result.memory ?? null, arrayArgIndices, stringArgIndices, spec, createArray, getArray, setArray };
      if (result.jspiWrapped) cached.jspiWrapped = result.jspiWrapped;
      if (DEBUG_WASM) console.error("[compileViaIR] compiled", JSON.stringify({ name: func.name, params: func.paramCount, props: result.propNames, written: result.writtenProps, globals: result.globalNames }));
      if (result.propNames) cached.propNames = result.propNames;
      if (result.writtenProps) cached.writtenProps = result.writtenProps;
      if (result.globalNames) cached.globalNames = result.globalNames;
      cached.hasThis = result.hasThis ?? false;
      cached.upvalueCount = result.upvalueCount ?? 0;
      if (result.taggedProps) {
        cached.taggedProps = new Set(result.taggedProps);
        cached.resultTagged = result.resultTagged ?? false;
        cached.objTable = [];
        cached.objMap = new Map();
        if (result.slotHolder && result.nestedPropNames) {
          // ネストアクセス (this.cur.link 等): tagged 参照の 1 段先を VM の
          // HiddenClass から読み、同じタグ規則で返す。own プロパティ以外
          // (プロトタイプ上のメソッド等) や数値の deref は deopt に倒す
          const table = cached.objTable;
          const map = cached.objMap;
          const names = result.nestedPropNames;
          result.slotHolder.fn = (tagged: number, propId: number): number => {
            // 9 未満の奇数はタグ (null/undefined/false/true) — オブジェクトではない
            if (!(tagged & 1) || tagged < 9) throw DEOPT_SENTINEL;
            const obj = table[tagged >> 1];
            if (!isJSObject(obj)) throw DEOPT_SENTINEL;
            const hcN = getHiddenClass(obj as any);
            const si = hcN.properties.get(names[propId]);
            if (si === undefined) throw DEOPT_SENTINEL;
            const v = getSlots(obj as any)[si];
            if (typeof v === "number" && Number.isInteger(v) && v < 536870912 && v > -536870912) return v << 1;
            if (v === null) return 1;
            if (v === undefined) return 3;
            if (typeof v === "boolean") return v ? 7 : 5;
            if (typeof v === "object") {
              let idx = map.get(v);
              if (idx === undefined) { idx = table.length; table.push(v); map.set(v, idx); }
              return (idx << 1) | 1;
            }
            throw DEOPT_SENTINEL;
          };
        }
      }
      if (resolved) {
        cached.calleeGuards = resolved.guards;
        cached.extraBoxes = resolved.extraBoxes;
      }
      return cached;
    } catch (e: any) {
      if (DEBUG_WASM) console.error("[compileViaIR] threw", e.message || e, e.stack);
      return null;
    }
  }

  // OSR から IR パスで Wasm コンパイル
  tryOSRViaIR(func: BytecodeFunction, relatedFuncs: BytecodeFunction[]): ((...args: number[]) => number) | null {
    try {
      // <script> (トップレベル) も LoadGlobal/StoreGlobal で対応
      // 関連関数を knownFuncs に登録
      const funcsMap = new Map<string, BytecodeFunction>();
      for (const f of relatedFuncs) funcsMap.set(f.name, f);
      // IR 構築 + 最適化 (Inlining で関連関数を展開)
      const ir = buildIR(func, { feedback: this.feedback, knownFuncs: funcsMap });
      optimize(ir, {
        knownFuncs: funcsMap,
        buildIROptions: { feedback: this.feedback, knownFuncs: this.knownFuncs },
      });
      // Proper OSR: 全 locals をパラメータとして受け取る Wasm 関数を生成
      const result = compileIRToWasm(ir, func.localCount);
      if (!result) return null;
      const wasmFn = (result.instance.exports as any)[ir.name] as (...args: number[]) => number;
      return wasmFn ?? null;
    } catch {
      return null;
    }
  }

  private compileWithRelatedFuncs(
    func: BytecodeFunction,
    spec: WasmNumericType,
    arrayArgIndices: number[],
  ): CachedWasm | null {
    // 関連関数を収集 (bytecode 内の LdaGlobal + Call から参照される関数)
    const funcsToCompile = this.collectRelatedFuncs(func);
    const result = compileMultiSync(funcsToCompile, spec);
    if (!result) return null;

    const wasmFn = result.get(func.name);
    if (!wasmFn) return null;

    const memory = (result as any).__memory as WebAssembly.Memory | undefined;
    const createArray = (result as any).__create_array as ((len: number) => unknown) | undefined;
    const getArray = (result as any).__get_array as ((arr: unknown, idx: number) => number) | undefined;
    const setArray = (result as any).__set_array as ((arr: unknown, idx: number, val: number) => void) | undefined;
    const cached: CachedWasm = {
      fn: wasmFn, memory: memory ?? null, arrayArgIndices, stringArgIndices: [], spec,
      createArray: createArray ?? null,
      getArray: getArray ?? null,
      setArray: setArray ?? null,
    };

    // 関連関数もキャッシュに登録
    for (const f of funcsToCompile) {
      if (f !== func) {
        const relFn = result.get(f.name);
        if (relFn) {
          this.wasmCache.set(f, {
            fn: relFn, memory: memory ?? null, arrayArgIndices: [], stringArgIndices: [], spec,
            createArray: createArray ?? null,
            getArray: getArray ?? null,
            setArray: setArray ?? null,
          });
        }
      }
    }

    return cached;
  }

  private collectRelatedFuncs(func: BytecodeFunction): BytecodeFunction[] {
    const seen = new Set<string>();
    const result: BytecodeFunction[] = [];
    const queue = [func];

    while (queue.length > 0) {
      const f = queue.shift()!;
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      result.push(f);

      // bytecode 内の LdaGlobal + Call パターンから参照される関数を探す
      for (let pc = 0; pc < f.bytecode.length; pc++) {
        if (f.bytecode[pc].op === "LdaGlobal" && pc + 1 < f.bytecode.length && f.bytecode[pc + 1].op === "Call") {
          const name = f.constants[f.bytecode[pc].operand!] as string;
          const related = this.knownFuncs.get(name);
          if (related && !seen.has(name)) {
            queue.push(related);
          }
        }
      }
    }

    return result;
  }

  private executeWasm(
    func: BytecodeFunction,
    cached: CachedWasm,
    args: unknown[],
    callCount: number,
    upvalueValues: unknown[] = [],
    thisObj?: unknown,
  ): { result: unknown } | null {
    const { fn, arrayArgIndices, memory } = cached;

    if (arrayArgIndices.length > 0 && cached.createArray) {
      // 配列引数がある: WasmGC 配列で in/out コピー
      // クラスタの callee identity guard (配列経路もここで確認)
      if (cached.calleeGuards) {
        for (const g of cached.calleeGuards) {
          if (g.box.value !== g.expected) {
            this.deoptimize(func, args);
            this.logTier(func, "Bytecode VM (after deopt: cluster callee changed)", callCount);
            return null;
          }
        }
      }
      return this.executeWithArrayArgs(func, cached, args, arrayArgIndices, callCount, upvalueValues);
    }

    // 引数の型チェック + 変換
    const { stringArgIndices } = cached;
    const wasmArgs: number[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (stringArgIndices.includes(i)) {
        // 文字列引数: intern id に変換
        if (!isJSString(a)) { this.deoptimize(func, args); return null; }
        const id = getInternId(a);
        if (id < 0) { this.deoptimize(func, args); return null; }
        wasmArgs.push(id);
      } else if (typeof a === "number") {
        // i32 特殊化のとき、小数または -0 が渡されたら deopt。
        // -0 は i32 の copy-in で 0 に潰れるため (`id(-0)` が +0 を返す)。
        // 実 JS では引数の -0 は保持されるので VM 実行に落とす (稀なので実害小)
        if (cached.spec === "i32" && (!Number.isInteger(a) || Object.is(a, -0))) {
          this.deoptimize(func, args);
          this.logTier(func, "Bytecode VM (after deopt: float/-0 to i32)", callCount);
          return null;
        }
        wasmArgs.push(a);
      } else {
        this.deoptimize(func, args);
        this.logTier(func, "Bytecode VM (after deopt)", callCount);
        return null;
      }
    }

    // upvalue の値を追加引数として渡す。
    // クラスタで callee 解決済みのスロット (関数参照) は Wasm 内で読まれない
    // (LoadUpvalue が除去済み) のでダミー 0 を渡す
    const guardedSlots = cached.calleeGuards ? new Set(cached.calleeGuards.filter(g => g.idx !== undefined).map(g => g.idx)) : null;
    const uvCount = cached.upvalueCount ?? upvalueValues.length;
    for (let uvi = 0; uvi < uvCount; uvi++) {
      const uv = upvalueValues[uvi];
      if (guardedSlots?.has(uvi)) {
        wasmArgs.push(0);
      } else if (typeof uv === "number") {
        wasmArgs.push(uv);
      } else if (isJSString(uv)) {
        const id = getInternId(uv);
        if (id < 0) { this.deoptimize(func, args); return null; }
        wasmArgs.push(id);
      } else {
        // upvalue が数値/文字列でない → JIT 不可
        return null;
      }
    }

    // this パラメータ: LoadThis がある関数で thisObj が JSObject の場合
    // slots をメモリにコピーしてベースアドレスを渡す
    // compile 結果基準 (undefined = legacy direct パスは this 関数を弾くので false 扱い)
    const hasThis = cached.hasThis === true;
    if (hasThis && thisObj !== undefined) {
      if (!isJSObject(thisObj)) {
        // thisObj が JSObject でない → JIT 不可 (フラグ化して以後 VM 直行)
        this.deoptimize(func, args);
        return null;
      }
      if (!memory) {
        // メモリがない → JIT 不可 (同上)
        this.deoptimize(func, args);
        return null;
      }
      const slots = getSlots(thisObj);
      const hc = getHiddenClass(thisObj as any);
      const view = cached.i32view ?? (cached.i32view = new Int32Array(memory.buffer));
      const base = 0;
      if (cached.propNames) {
        // used-props モデル (IR パス): 関数が実際に使うプロパティだけを
        // 名前で HC から引いて、codegen の propOffsets と同じ順序で
        // linear memory に copy-in する。
        // - 使わないプロパティは参照 (オブジェクト/null) でも無視できる
        //   → richards の TCB.link 等があっても state だけ使うメソッドは JIT 可
        // - 使うプロパティが非数値/非整数なら i32 モデルに乗らないので deopt
        // (旧実装は HC 挿入順で全コピーしており、IR 出現順の propOffsets と
        //  順序がずれうる + 非数値が 1 つでもあると deopt だった)
        // HC ごとの slot index 列をキャッシュ (名前引きは HC につき 1 回)
        let slotIdxs = cached.hcSlotCache?.get(hc);
        if (!slotIdxs) {
          slotIdxs = cached.propNames.map(n => hc.properties.get(n));
          (cached.hcSlotCache ?? (cached.hcSlotCache = new Map())).set(hc, slotIdxs);
        }
        // tagged スロット準備 (object table は呼び出しごとにリセットして再利用)
        const tagged = cached.taggedProps;
        // index 0..3 はタグ予約 (null=1, undefined=3, false=5, true=7) — 最初のオブジェクトは tag 9
        if (tagged) { cached.objTable!.length = 4; cached.objMap!.clear(); }
        for (let i = 0; i < cached.propNames.length; i++) {
          const slotIdx = slotIdxs[i];
          const v = slotIdx !== undefined ? slots[slotIdx] : undefined;
          if (tagged?.has(cached.propNames[i])) {
            // tagged: 数値 (30bit 整数) は v<<1、null=1、undefined=3、
            // 参照は table index を (idx<<1)|1 で (同一オブジェクト → 同一 index)
            if (typeof v === "number" && Number.isInteger(v) && v < 536870912 && v > -536870912) {
              view[i] = v << 1;
            } else if (v === null) {
              view[i] = 1;
            } else if (v === undefined) {
              view[i] = 3;
            } else if (typeof v === "boolean") {
              view[i] = v ? 7 : 5;
            } else if (typeof v === "object") {
              let idx = cached.objMap!.get(v);
              if (idx === undefined) { idx = cached.objTable!.length; cached.objTable!.push(v); cached.objMap!.set(v, idx); }
              view[i] = (idx << 1) | 1;
            } else {
              this.deoptimize(func, args);
              this.logTier(func, "Bytecode VM (after deopt: untaggable prop)", callCount);
              return null;
            }
            continue;
          }
          if (typeof v !== "number" || !Number.isInteger(v) || v > 2147483647 || v < -2147483648) {
            this.deoptimize(func, args);
            this.logTier(func, "Bytecode VM (after deopt: non-i32 used prop)", callCount);
            return null;
          }
          view[i] = v;
        }
      } else {
        // legacy (propNames 無し = 非 IR パス): HC 挿入順で全コピー。
        // 非数値があれば deopt (Phase 30 のガード)
        let dst = 0;
        for (const [name, slotIdx] of hc.properties) {
          if (name === "__proto__") continue;
          const v = slots[slotIdx];
          if (typeof v !== "number") {
            this.deoptimize(func, args);
            this.logTier(func, "Bytecode VM (after deopt: non-numeric this slot)", callCount);
            return null;
          }
          view[dst] = v;
          dst++;
        }
      }
      wasmArgs.push(base);
    }

    // 読み取り専用グローバル: VM の現在値を追加パラメータで渡す。
    // 非数値/非整数なら i32 モデルに乗らないので deopt
    if (cached.globalNames && cached.globalNames.length > 0) {
      if (!this.globalsMap) { this.deoptimize(func, args); return null; }
      for (const gname of cached.globalNames) {
        const v = this.globalsMap.get(gname);
        // -0 は i32 copy-in で 0 に潰れるので引数と同様に deopt
        if (typeof v !== "number" || (cached.spec === "i32" && (!Number.isInteger(v) || Object.is(v, -0)))) {
          this.deoptimize(func, args);
          this.logTier(func, "Bytecode VM (after deopt: non-numeric global " + gname + ")", callCount);
          return null;
        }
        wasmArgs.push(v);
      }
    }

    // クラスタ: callee identity guard (コンパイル時に特殊化した兄弟クロージャが
    // 差し替わっていたら deopt) + callee 専用 box の現在値を追加パラメータで渡す
    if (cached.calleeGuards) {
      for (const g of cached.calleeGuards) {
        if (g.box.value !== g.expected) {
          this.deoptimize(func, args);
          this.logTier(func, "Bytecode VM (after deopt: cluster callee changed)", callCount);
          return null;
        }
      }
    }
    if (cached.extraBoxes) {
      for (const b of cached.extraBoxes) {
        const v = b.value;
        if (typeof v !== "number") { this.deoptimize(func, args); return null; }
        wasmArgs.push(v);
      }
    }

    // JSPI: async 関数は promising ラップ済み関数を呼ぶ → Promise を返す
    if (cached.jspiWrapped) {
      this.logTier(func, "Wasm (JSPI)", callCount);
      return { result: cached.jspiWrapped(...wasmArgs) };
    }

    this.logTier(func, "Wasm", callCount);
    try {
      let result: unknown = fn(...wasmArgs);
      // 戻り値が tagged (return this.currentTcb 等) ならデコード
      if (cached.resultTagged && typeof result === "number") {
        const t = result;
        if (t === 1) result = null;
        else if (t === 3) result = undefined;
        else if (t === 5) result = false;
        else if (t === 7) result = true;
        else if (t & 1) result = cached.objTable![t >> 1];
        else result = t >> 1;
      } else if (cached.resultBool && typeof result === "number") {
        // 全 Return が bool の関数: i32 0/1 を boolean に戻す
        result = result !== 0;
      }
      // this の StoreProperty write-back: JIT 内で書き換えたプロパティを
      // linear memory から VM の HiddenClass オブジェクトへ反映する。
      // (これが無いと this.state = x 等の変更が VM 側から見えない)
      if (hasThis && thisObj !== undefined && memory && cached.propNames && cached.writtenProps && cached.writtenProps.length > 0) {
        // copy-in で存在と数値性は確認済みなので slot 直書きでよい
        const view = cached.i32view ?? (cached.i32view = new Int32Array(memory.buffer));
        const hc = getHiddenClass(thisObj as any);
        const slots = getSlots(thisObj);
        const slotIdxs = cached.hcSlotCache?.get(hc);
        for (const name of cached.writtenProps) {
          const off = cached.propNames.indexOf(name);
          if (off < 0) continue;
          let val: unknown = view[off];
          if (cached.taggedProps?.has(name)) {
            const t = view[off];
            if (t === 1) val = null;
            else if (t === 3) val = undefined;
            else if (t === 5) val = false;
            else if (t === 7) val = true;
            else if (t & 1) val = cached.objTable![t >> 1];
            else val = t >> 1;
          }
          const slotIdx = slotIdxs ? slotIdxs[off] : hc.properties.get(name);
          if (slotIdx !== undefined) slots[slotIdx] = val;
          else jsObjSet(thisObj as any, name, val);
        }
      }
      return { result };
    } catch (e) {
      // ネストアクセス import からの deopt 要求 (数値 deref / own に無い
      // プロパティ等)。副作用 (write-back) 前なので VM 再実行で正しい
      if (e === DEOPT_SENTINEL) {
        this.deoptimize(func, args);
        this.logTier(func, "Bytecode VM (after deopt: nested slot access)", callCount);
        return null;
      }
      // Wasm 自己再帰が深くなると実行スタックが溢れる
      // (RangeError: Maximum call stack size exceeded)。VM はヒープ上の
      // frames 配列なので同じ深さでも溢れない。deopt して VM で再実行する。
      // スタック溢れ時点で副作用 (配列書き戻し等) は未適用なので再実行は安全。
      if (e instanceof RangeError) {
        this.deoptimize(func, args);
        this.logTier(func, "Bytecode VM (after deopt: wasm stack overflow)", callCount);
        return null;
      }
      throw e;
    }
  }

  private executeWithArrayArgs(
    func: BytecodeFunction,
    cached: CachedWasm,
    args: unknown[],
    arrayArgIndices: number[],
    callCount: number,
    upvalueValues: unknown[] = [],
  ): { result: unknown } | null {
    const { fn, createArray, getArray, setArray } = cached;
    if (!createArray || !getArray || !setArray) return null;

    const wasmArgs: unknown[] = [];
    const arrayRefs: { jsArr: unknown[]; gcArr: unknown; length: number }[] = [];

    // WasmGC 配列を作成して要素をコピー
    for (let i = 0; i < args.length; i++) {
      if (arrayArgIndices.includes(i)) {
        const arr = args[i];
        if (!Array.isArray(arr)) {
          this.deoptimize(func, args);
          return null;
        }
        // Element Kind ガード (i32 spec は SMI のみ、f64 spec は DOUBLE も可)
        if (isTrackedArray(arr)) {
          const kind = getElementKind(arr);
          const kindOk = cached.spec === "f64" ? (kind === "SMI" || kind === "DOUBLE") : kind === "SMI";
          if (!kindOk) {
            this.deoptimize(func, args);
            return null;
          }
        }
        // WasmGC 配列を作成
        const gcArr = createArray(arr.length);
        for (let j = 0; j < arr.length; j++) {
          setArray(gcArr, j, arr[j] as number);
        }
        arrayRefs.push({ jsArr: arr, gcArr, length: arr.length });
        wasmArgs.push(gcArr);
      } else {
        if (typeof args[i] !== "number") {
          this.deoptimize(func, args);
          return null;
        }
        wasmArgs.push(args[i] as number);
      }
    }

    // upvalue / 読み取り専用グローバル / クラスタ extra box (params 順に追加)。
    // guard 済みスロット (callee 解決済みの関数参照) はダミー 0
    const guardedSlots2 = cached.calleeGuards ? new Set(cached.calleeGuards.filter(g => g.idx !== undefined).map(g => g.idx)) : null;
    const uvCount2 = cached.upvalueCount ?? upvalueValues.length;
    for (let uvi = 0; uvi < uvCount2; uvi++) {
      const uv = upvalueValues[uvi];
      if (guardedSlots2?.has(uvi)) wasmArgs.push(0);
      else if (typeof uv === "number") wasmArgs.push(uv);
      else { this.deoptimize(func, args); return null; }
    }
    if (cached.globalNames && cached.globalNames.length > 0) {
      if (!this.globalsMap) { this.deoptimize(func, args); return null; }
      for (const gname of cached.globalNames) {
        const v = this.globalsMap.get(gname);
        if (typeof v !== "number") { this.deoptimize(func, args); return null; }
        wasmArgs.push(v);
      }
    }
    if (cached.extraBoxes) {
      for (const b of cached.extraBoxes) {
        const v = b.value;
        if (typeof v !== "number") { this.deoptimize(func, args); return null; }
        wasmArgs.push(v);
      }
    }

    this.logTier(func, "Wasm (array)", callCount);
    let result: number;
    try {
      result = fn(...(wasmArgs as number[]));
    } catch (e) {
      // Wasm 自己再帰のスタック溢れ → deopt して VM 再実行。
      // 書き戻し前なので jsArr は未変更、VM 再実行は安全。
      if (e instanceof RangeError) {
        this.deoptimize(func, args);
        this.logTier(func, "Bytecode VM (after deopt: wasm stack overflow)", callCount);
        return null;
      }
      throw e;
    }

    // WasmGC 配列から JS 配列に書き戻し
    for (const { jsArr, gcArr, length } of arrayRefs) {
      for (let j = 0; j < length; j++) {
        jsArr[j] = getArray(gcArr, j);
      }
    }

    return { result };
  }

  private deoptimize(func: BytecodeFunction, args: unknown[]): void {
    (func as { __jitCached?: CachedWasm | null }).__jitCached = null; // 以後 fast path で VM 直行
    const argTypes = args.map(a => {
      if (Array.isArray(a)) return `array(${a.length})`;
      return typeof a;
    }).join(", ");
    const msg = `[DEOPT] ${func.name}: unexpected args (${argTypes})`;
    this.deoptLog.push(msg);
    if (this.traceTier) {
      this.tierLog.push(msg);
    }
    this.wasmCache.delete(func);
    this.deoptimized.add(func);
  }
}
