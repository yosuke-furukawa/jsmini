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
  private deoptimized: Set<BytecodeFunction> = new Set();

  deoptLog: string[] = [];
  tierLog: string[] = [];
  traceTier = false;

  constructor(feedback: FeedbackCollector, options: JitOptions) {
    this.feedback = feedback;
    this.threshold = options.threshold;
  }

  private logTier(func: BytecodeFunction, tier: string, callCount?: number): void {
    if (!this.traceTier) return;
    const count = callCount ?? this.feedback.get(func)?.callCount ?? 0;
    this.tierLog.push(`[TIER] ${func.name}: ${tier} (call #${count})`);
  }

  tryCall(func: BytecodeFunction, args: unknown[]): { result: number } | null {
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

      // 型ガード
      if (!args.every(a => typeof a === "number")) {
        this.deoptimize(func, args);
        this.logTier(func, "Bytecode VM (after deopt)", callCount);
        return null;
      }

      this.logTier(func, "Wasm", callCount);
      return { result: cached(...(args as number[])) };
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

    // 型特殊化 + コンパイル
    const allSame = wasmArgTypes.every(t => t === wasmArgTypes[0]);
    const spec: WasmNumericType = allSame && wasmArgTypes[0] === "i32" ? "i32" : "f64";

    const wasmFn = compileToWasmSync(func, spec);
    this.wasmCache.set(func, wasmFn);

    if (wasmFn) {
      this.logTier(func, `→ Wasm compiled (${spec}, monomorphic: [${wasmArgTypes.join(", ")}])`, callCount);
      if (args.every(a => typeof a === "number")) {
        this.logTier(func, "Wasm", callCount);
        return { result: wasmFn(...(args as number[])) };
      }
    }

    this.logTier(func, "Bytecode VM", callCount);
    return null;
  }

  private deoptimize(func: BytecodeFunction, args: unknown[]): void {
    const argTypes = args.map(a => typeof a).join(", ");
    const msg = `[DEOPT] ${func.name}: expected number args but got (${argTypes})`;
    this.deoptLog.push(msg);
    if (this.traceTier) {
      this.tierLog.push(msg);
    }
    this.wasmCache.delete(func);
    this.deoptimized.add(func);
  }
}
