import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vmEvaluate } from "../vm/index.js";
import type { VMResult } from "../vm/index.js";

describe("JIT - Step 5-6: 多層実行の可視化", () => {
  it("--trace-tier で VM → Wasm の切り替えが記録される", () => {
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      for (var i = 0; i < 15; i = i + 1) { add(i, 1); }
    `, { jit: true, jitThreshold: 10, collectFeedback: true, traceTier: true }) as VMResult;

    assert.ok(result.tierLog);
    assert.ok(result.tierLog!.length > 0);
    // 最初は VM で実行
    assert.ok(result.tierLog!.some(l => l.includes("Bytecode VM")));
    // しきい値後に Wasm にコンパイル
    assert.ok(result.tierLog!.some(l => l.includes("Wasm compiled")));
    // コンパイル後は Wasm で実行
    assert.ok(result.tierLog!.some(l => l.includes("Wasm")));
  });

  it("脱最適化の切り替えも記録される", () => {
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      for (var i = 0; i < 15; i = i + 1) { add(i, 1); }
      add("a", "b");
    `, { jit: true, jitThreshold: 10, collectFeedback: true, traceTier: true }) as VMResult;

    assert.ok(result.tierLog);
    // 脱最適化ログ
    assert.ok(result.tierLog!.some(l => l.includes("DEOPT")));
    // 脱最適化後は VM に戻る
    const deoptIdx = result.tierLog!.findIndex(l => l.includes("DEOPT"));
    const afterDeopt = result.tierLog!.slice(deoptIdx + 1);
    if (afterDeopt.length > 0) {
      assert.ok(afterDeopt.some(l => l.includes("Bytecode VM")));
    }
  });

  it("JIT 非対象の関数は常に VM", () => {
    const result = vmEvaluate(`
      function greet(name) { return "hello " + name; }
      for (var i = 0; i < 15; i = i + 1) { greet("world"); }
    `, { jit: true, jitThreshold: 10, collectFeedback: true, traceTier: true }) as VMResult;

    assert.ok(result.tierLog);
    // 全て VM
    const greetLogs = result.tierLog!.filter(l => l.includes("greet"));
    assert.ok(greetLogs.every(l => l.includes("Bytecode VM")));
  });
});
