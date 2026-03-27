import type { BytecodeFunction } from "../vm/bytecode.js";

export type TypeFeedback = {
  callCount: number;
  argTypes: string[][];    // 呼び出しごとの引数型 (最新 N 件)
  returnTypes: string[];   // 戻り値の型 (最新 N 件)
  isMonomorphic: boolean;  // 常に同じ型パターンか
};

const MAX_SAMPLES = 10; // 型履歴の最大保持数

export class FeedbackCollector {
  private feedbacks: Map<BytecodeFunction, TypeFeedback> = new Map();

  // 関数呼び出し時に引数の型を記録
  recordCall(func: BytecodeFunction, args: unknown[]): void {
    let fb = this.feedbacks.get(func);
    if (!fb) {
      fb = { callCount: 0, argTypes: [], returnTypes: [], isMonomorphic: true };
      this.feedbacks.set(func, fb);
    }
    fb.callCount++;

    const types = args.map(typeOf);
    if (fb.argTypes.length < MAX_SAMPLES) {
      fb.argTypes.push(types);
    }

    // monomorphic 判定: 新しい型パターンが既存と異なれば polymorphic
    if (fb.isMonomorphic && fb.argTypes.length > 0) {
      const first = fb.argTypes[0].join(",");
      if (types.join(",") !== first) {
        fb.isMonomorphic = false;
      }
    }
  }

  // 関数の戻り値の型を記録
  recordReturn(func: BytecodeFunction, value: unknown): void {
    const fb = this.feedbacks.get(func);
    if (!fb) return;

    const t = typeOf(value);
    if (fb.returnTypes.length < MAX_SAMPLES) {
      fb.returnTypes.push(t);
    }
  }

  // フィードバック情報を取得
  get(func: BytecodeFunction): TypeFeedback | undefined {
    return this.feedbacks.get(func);
  }

  // 全フィードバックをダンプ
  dump(): string {
    const lines: string[] = [];
    for (const [func, fb] of this.feedbacks) {
      lines.push(`Feedback for ${func.name}:`);
      lines.push(`  callCount: ${fb.callCount}`);
      if (fb.argTypes.length > 0) {
        const representative = fb.argTypes[0].join(", ");
        const status = fb.isMonomorphic ? "monomorphic" : "polymorphic";
        lines.push(`  argTypes: [${representative}] (${status})`);
      }
      if (fb.returnTypes.length > 0) {
        const unique = [...new Set(fb.returnTypes)];
        lines.push(`  returnType: ${unique.join(" | ")}`);
      }
    }
    return lines.join("\n");
  }
}

function typeOf(val: unknown): string {
  if (val === null) return "null";
  return typeof val;
}
