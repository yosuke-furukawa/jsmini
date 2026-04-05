import type { BytecodeFunction } from "../vm/bytecode.js";
import { FeedbackCollector, classifyType, isArrayType } from "./feedback.js";
import { compileToWasmSync, compileMultiSync } from "./wasm-compiler.js";
import type { WasmNumericType } from "./feedback.js";
import { getElementKind, isTrackedArray } from "../vm/js-array.js";
import { isJSString, getInternId, getStringById } from "../vm/js-string.js";
import { isJSObject, getSlots } from "../vm/js-object.js";
import { buildIR } from "../ir/builder.js";
import { optimize, type InlineOptions } from "../ir/optimize.js";
import { compileIRToWasm } from "../ir/codegen.js";

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
  }

  tryCall(func: BytecodeFunction, args: unknown[], upvalueValues: unknown[] = [], thisObj?: unknown): { result: unknown } | null {
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
      this.logTier(func, "Bytecode VM (polymorphic)", callCount);
      return null;
    }

    const wasmArgTypes = this.feedback.getWasmArgTypes(func);
    if (!wasmArgTypes) {
      this.wasmCache.set(func, null);
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

    // 配列引数がある場合: 関連関数をまとめてコンパイル
    let compiled: CachedWasm | null = null;
    if (arrayArgIndices.length > 0) {
      compiled = this.compileWithRelatedFuncs(func, spec, arrayArgIndices);
      if (compiled) compiled.stringArgIndices = stringArgIndices;
    } else if (this.useIR) {
      // IR パス: bytecode → IR → optimize → Wasm
      compiled = this.compileViaIR(func, spec, stringArgIndices);
    }
    // IR パスが失敗 or useIR=false → direct パス
    if (!compiled && arrayArgIndices.length === 0) {
      const wasmFn = compileToWasmSync(func, spec);
      if (wasmFn) {
        compiled = { fn: wasmFn, memory: null, arrayArgIndices: [], stringArgIndices, spec, createArray: null, getArray: null, setArray: null };
      }
    }

    this.wasmCache.set(func, compiled);

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
        buildIROptions: { feedback: this.feedback },
      });
      const result = compileIRToWasm(ir);
      if (!result) return null;
      const wasmFn = (result.instance.exports as any)[ir.name] as (...args: number[]) => number;
      if (!wasmFn) return null;
      return { fn: wasmFn, memory: null, arrayArgIndices: [], stringArgIndices, spec, createArray: null, getArray: null, setArray: null };
    } catch {
      return null; // IR コンパイル失敗 → フォールバック
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
        buildIROptions: { feedback: this.feedback },
      });
      const result = compileIRToWasm(ir);
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
    const { fn, arrayArgIndices } = cached;

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
      const view = new Int32Array(memory.buffer);
      // slots をメモリの先頭にコピー
      const base = 0;
      for (let i = 0; i < slots.length; i++) {
        view[i] = slots[i] as number;
      }
      wasmArgs.push(base);
    }

    this.logTier(func, "Wasm", callCount);
    return { result: fn(...wasmArgs) };
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
    const result = fn(...(wasmArgs as number[]));

    // WasmGC 配列から JS 配列に書き戻し
    for (const { jsArr, gcArr, length } of arrayRefs) {
      for (let j = 0; j < length; j++) {
        jsArr[j] = getArray(gcArr, j);
      }
    }

    return { result };
  }

  private deoptimize(func: BytecodeFunction, args: unknown[]): void {
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
