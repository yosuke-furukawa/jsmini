import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vmEvaluate } from "../vm/index.js";

describe("JIT - Step 5-4: 型特殊化", () => {
  it("整数関数が i32 特殊化されて正しい結果を返す", () => {
    // 整数のみで呼ぶ → i32 で JIT されるべき
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      var last = 0;
      for (var i = 0; i < 20; i = i + 1) {
        last = add(i, 1);
      }
      last;
    `, { jit: true, jitThreshold: 10 });
    assert.equal(result, 20); // add(19, 1)
  });

  it("小数関数が f64 のまま正しい結果を返す", () => {
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      var last = 0;
      for (var i = 0; i < 20; i = i + 1) {
        last = add(0.5, 0.5);
      }
      last;
    `, { jit: true, jitThreshold: 10 });
    assert.equal(result, 1);
  });

  it("i32 特殊化で乗算が動く", () => {
    const result = vmEvaluate(`
      function mul(a, b) { return a * b; }
      var last = 0;
      for (var i = 0; i < 20; i = i + 1) {
        last = mul(3, 4);
      }
      last;
    `, { jit: true, jitThreshold: 10 });
    assert.equal(result, 12);
  });
});
