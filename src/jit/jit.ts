import type { BytecodeFunction } from "../vm/bytecode.js";
import { FeedbackCollector } from "./feedback.js";
import { compileToWasmSync } from "./wasm-compiler.js";
import type { WasmNumericType } from "./feedback.js";

export type JitOptions = {
  threshold: number;
};

export class JitManager {
  private feedback: FeedbackCollector;
  private wasmCache: Map<BytecodeFunction, ((...args: number[]) => number) | null> = new Map();
  private threshold: number;

  constructor(feedback: FeedbackCollector, options: JitOptions) {
    this.feedback = feedback;
    this.threshold = options.threshold;
  }

  // 関数呼び出し前に Wasm があるか確認
  // Wasm 関数があり引数が全て number ならそれを返す
  tryCall(func: BytecodeFunction, args: unknown[]): { result: number } | null {
    // キャッシュ確認
    if (this.wasmCache.has(func)) {
      const cached = this.wasmCache.get(func)!;
      if (cached && args.every(a => typeof a === "number")) {
        return { result: cached(...(args as number[])) };
      }
      return null;
    }

    // しきい値チェック
    const fb = this.feedback.get(func);
    if (!fb || fb.callCount < this.threshold) return null;

    // monomorphic かつ数値型
    if (!fb.isMonomorphic) {
      this.wasmCache.set(func, null);
      return null;
    }

    const wasmArgTypes = this.feedback.getWasmArgTypes(func);
    if (!wasmArgTypes) {
      this.wasmCache.set(func, null);
      return null;
    }

    // 型特殊化: 全引数が同じ型なら特殊化、混在なら f64
    const allSame = wasmArgTypes.every(t => t === wasmArgTypes[0]);
    const spec: WasmNumericType = allSame && wasmArgTypes![0] === "i32" ? "i32" : "f64";

    // 同期コンパイル
    const wasmFn = compileToWasmSync(func, spec);
    this.wasmCache.set(func, wasmFn);

    if (wasmFn && args.every(a => typeof a === "number")) {
      return { result: wasmFn(...(args as number[])) };
    }

    return null;
  }
}
