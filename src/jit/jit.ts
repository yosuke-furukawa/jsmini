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
  // 脱最適化された関数 (再 JIT しない)
  private deoptimized: Set<BytecodeFunction> = new Set();
  // 脱最適化ログ
  deoptLog: string[] = [];

  constructor(feedback: FeedbackCollector, options: JitOptions) {
    this.feedback = feedback;
    this.threshold = options.threshold;
  }

  // 関数呼び出し前に Wasm で実行できるか試みる
  // 成功: { result } を返す
  // 失敗/非対象: null を返す (VM で実行)
  tryCall(func: BytecodeFunction, args: unknown[]): { result: number } | null {
    // 脱最適化済みの関数は VM で実行
    if (this.deoptimized.has(func)) return null;

    // キャッシュ確認
    if (this.wasmCache.has(func)) {
      const cached = this.wasmCache.get(func)!;
      if (!cached) return null; // コンパイル失敗済み

      // 型ガード: 全引数が number か確認
      if (!args.every(a => typeof a === "number")) {
        // 脱最適化！
        this.deoptimize(func, args);
        return null;
      }

      return { result: cached(...(args as number[])) };
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

    // 型特殊化
    const allSame = wasmArgTypes.every(t => t === wasmArgTypes[0]);
    const spec: WasmNumericType = allSame && wasmArgTypes[0] === "i32" ? "i32" : "f64";

    const wasmFn = compileToWasmSync(func, spec);
    this.wasmCache.set(func, wasmFn);

    if (wasmFn && args.every(a => typeof a === "number")) {
      return { result: wasmFn(...(args as number[])) };
    }

    return null;
  }

  // 脱最適化: Wasm キャッシュを無効化し、以降は VM で実行
  private deoptimize(func: BytecodeFunction, args: unknown[]): void {
    const argTypes = args.map(a => typeof a).join(", ");
    const msg = `[DEOPT] ${func.name}: expected number args but got (${argTypes})`;
    this.deoptLog.push(msg);
    this.wasmCache.delete(func);
    this.deoptimized.add(func);
  }
}
