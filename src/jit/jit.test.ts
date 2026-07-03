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

  it("深い自己再帰が Wasm スタック溢れせず正しい結果を返す (VM フォールバック)", () => {
    // 自己再帰は Wasm 内 `call self` にコンパイルされ、深さ ~2万で Wasm
    // 実行スタックが溢れる (RangeError)。executeWasm が RangeError を catch
    // して deopt → VM 再実行することで、深い再帰でも正しい結果を返す。
    const src = `
      function sum(n) { if (n <= 0) { return 0; } return n + sum(n - 1); }
      var w = 0;
      for (var r = 0; r < 50; r = r + 1) { w = sum(100); }
      sum(50000);
    `;
    const plain = vmEvaluate(src);
    const jit = vmEvaluate(src, { jit: true, jitThreshold: 5, useIR: true });
    assert.equal(jit, plain);
    assert.equal(jit, 1250025000); // sum(1..50000)
  });
});
