import type { BytecodeFunction } from "../vm/bytecode.js";
import { FeedbackCollector, classifyType, isArrayType } from "./feedback.js";
import { compileToWasmSync, compileMultiSync } from "./wasm-compiler.js";
import type { WasmNumericType } from "./feedback.js";
import { getElementKind, isTrackedArray } from "../vm/js-array.js";
import { isJSString, getInternId, getStringById } from "../vm/js-string.js";
import { isJSObject, getSlots, getHiddenClass, setProperty as jsObjSet } from "../vm/js-object.js";
import { buildIR } from "../ir/builder.js";
import { optimize, type InlineOptions } from "../ir/optimize.js";
import { compileIRToWasm } from "../ir/codegen.js";

// ブラウザ (playground) には process が無いので安全にガード
const DEBUG_WASM = typeof process !== "undefined" && !!process.env?.DEBUG_WASM;
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

  tryCall(func: BytecodeFunction, args: unknown[], upvalueValues: unknown[] = [], thisObj?: unknown): { result: unknown } | null {
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

    // しきい値チェック
    if (!fb || callCount < this.threshold) {
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
    const spec: WasmNumericType = allSame && (wasmArgTypes.length === 0 || wasmArgTypes[0] === "i32") ? "i32" : "f64";

    // IR パスを優先 (配列対応含む)
    let compiled: CachedWasm | null = null;
    if (this.useIR) {
      compiled = this.compileViaIR(func, spec, stringArgIndices);
    }
    // IR パスが失敗 or useIR=false → direct パス
    if (!compiled) {
      if (arrayArgIndices.length > 0) {
        compiled = this.compileWithRelatedFuncs(func, spec, arrayArgIndices);
        if (compiled) compiled.stringArgIndices = stringArgIndices;
      } else {
        const wasmFn = compileToWasmSync(func, spec);
        if (wasmFn) {
          compiled = { fn: wasmFn, memory: null, arrayArgIndices: [], stringArgIndices, spec, createArray: null, getArray: null, setArray: null };
        }
      }
    }

    this.wasmCache.set(func, compiled);
    (func as { __jitCached?: CachedWasm | null }).__jitCached = compiled;

    if (compiled) {
      this.logTier(func, `→ Wasm compiled (${spec}, arrays: [${arrayArgIndices}])`, callCount);
      return this.executeWasm(func, compiled, args, callCount, upvalueValues, thisObj);
    }

    this.logTier(func, "Bytecode VM", callCount);
    return null;
  }

  private compileViaIR(func: BytecodeFunction, spec: WasmNumericType, stringArgIndices: number[]): CachedWasm | null {
    try {
      const ir = buildIR(func, { feedback: this.feedback, knownFuncs: this.knownFuncs });
      optimize(ir, {
        knownFuncs: this.knownFuncs,
        buildIROptions: { feedback: this.feedback, knownFuncs: this.knownFuncs },
      });
      const result = compileIRToWasm(ir);
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
      return this.executeWithArrayArgs(func, cached, args, arrayArgIndices, callCount);
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
        // i32 特殊化のとき、小数が渡されたら deopt
        if (cached.spec === "i32" && !Number.isInteger(a)) {
          this.deoptimize(func, args);
          this.logTier(func, "Bytecode VM (after deopt: float to i32)", callCount);
          return null;
        }
        wasmArgs.push(a);
      } else {
        this.deoptimize(func, args);
        this.logTier(func, "Bytecode VM (after deopt)", callCount);
        return null;
      }
    }

    // upvalue の値を追加引数として渡す
    for (const uv of upvalueValues) {
      if (typeof uv === "number") {
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
    const hasThis = func.bytecode.some(i => i.op === "LoadThis");
    if (hasThis && thisObj !== undefined) {
      if (!isJSObject(thisObj)) {
        // thisObj が JSObject でない → JIT 不可
        return null;
      }
      if (!memory) {
        // メモリがない → JIT 不可
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
        for (let i = 0; i < cached.propNames.length; i++) {
          const slotIdx = slotIdxs[i];
          const v = slotIdx !== undefined ? slots[slotIdx] : undefined;
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
        if (typeof v !== "number" || (cached.spec === "i32" && !Number.isInteger(v))) {
          this.deoptimize(func, args);
          this.logTier(func, "Bytecode VM (after deopt: non-numeric global " + gname + ")", callCount);
          return null;
        }
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
      const result = fn(...wasmArgs);
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
          const slotIdx = slotIdxs ? slotIdxs[off] : hc.properties.get(name);
          if (slotIdx !== undefined) slots[slotIdx] = view[off];
          else jsObjSet(thisObj as any, name, view[off]);
        }
      }
      return { result };
    } catch (e) {
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
        // Element Kind ガード
        if (isTrackedArray(arr) && getElementKind(arr) !== "SMI") {
          this.deoptimize(func, args);
          return null;
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
