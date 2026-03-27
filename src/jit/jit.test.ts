import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vmEvaluate } from "../vm/index.js";

describe("JIT - Step 5-3: ホットコード検出 + 自動 JIT", () => {
  it("ホットな関数が Wasm に切り替わり正しい結果を返す", async () => {
    // しきい値 10 で JIT を有効化
    const result = await vmEvaluate(`
      function add(a, b) { return a + b; }
      var last = 0;
      for (var i = 0; i < 20; i = i + 1) {
        last = add(i, i);
      }
      last;
    `, { jit: true, jitThreshold: 10 });
    assert.equal(result, 38); // add(19, 19)
  });

  it("JIT なしと同じ結果を返す", async () => {
    const source = `
      function mul(a, b) { return a * b; }
      var sum = 0;
      for (var i = 1; i <= 10; i = i + 1) {
        sum = sum + mul(i, i);
      }
      sum;
    `;
    const withoutJit = vmEvaluate(source);
    const withJit = await vmEvaluate(source, { jit: true, jitThreshold: 5 });
    assert.equal(withJit, withoutJit);
  });

  it("文字列関数は JIT されない (VM で正常実行)", async () => {
    const result = await vmEvaluate(`
      function greet(name) { return "hello " + name; }
      var last = "";
      for (var i = 0; i < 20; i = i + 1) {
        last = greet("world");
      }
      last;
    `, { jit: true, jitThreshold: 10 });
    assert.equal(result, "hello world");
  });
});
