import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vmEvaluate } from "../vm/index.js";
import type { VMResult } from "../vm/index.js";

describe("JIT - Step 5-5: 脱最適化", () => {
  it("整数で JIT された後に文字列を渡すと VM にフォールバックする", () => {
    // 最初に整数で呼んで JIT → その後文字列で呼ぶ → 脱最適化して VM で実行
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      for (var i = 0; i < 20; i = i + 1) { add(i, 1); }
      add("hello", " world");
    `, { jit: true, jitThreshold: 10, collectFeedback: true }) as VMResult;
    assert.equal(result.value, "hello world");
  });

  it("脱最適化後も正しく動作し続ける", () => {
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      for (var i = 0; i < 20; i = i + 1) { add(i, 1); }
      var r1 = add("a", "b");
      var r2 = add(10, 20);
      r1 + r2;
    `, { jit: true, jitThreshold: 10, collectFeedback: true }) as VMResult;
    // "ab" + 30 = "ab30"
    assert.equal(result.value, "ab30");
  });

  it("脱最適化ログが記録される", () => {
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      for (var i = 0; i < 20; i = i + 1) { add(i, 1); }
      add("x", "y");
    `, { jit: true, jitThreshold: 10, collectFeedback: true, collectDeopt: true }) as VMResult;
    assert.ok(result.deoptLog);
    assert.ok(result.deoptLog!.length > 0);
    assert.ok(result.deoptLog![0].includes("add"));
  });
});
