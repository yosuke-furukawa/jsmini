import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vmEvaluate } from "../vm/index.js";
import type { VMResult } from "../vm/index.js";

describe("JIT - Step 5-1: 型フィードバック", () => {
  it("関数の呼び出し回数を記録する", () => {
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      for (var i = 0; i < 10; i = i + 1) { add(i, i); }
    `, { collectFeedback: true }) as VMResult;

    const fb = result.feedback!.get(
      [...(result.feedback as any).feedbacks.keys()].find((f: any) => f.name === "add")!
    );
    assert.ok(fb);
    assert.equal(fb!.callCount, 10);
  });

  it("引数の型を記録する (monomorphic)", () => {
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      add(1, 2);
      add(3, 4);
    `, { collectFeedback: true }) as VMResult;

    const fb = result.feedback!.get(
      [...(result.feedback as any).feedbacks.keys()].find((f: any) => f.name === "add")!
    );
    assert.ok(fb);
    assert.equal(fb!.isMonomorphic, true);
    assert.deepEqual(fb!.argTypes[0], ["number", "number"]);
  });

  it("戻り値の型を記録する", () => {
    const result = vmEvaluate(`
      function double(x) { return x * 2; }
      double(5);
    `, { collectFeedback: true }) as VMResult;

    const fb = result.feedback!.get(
      [...(result.feedback as any).feedbacks.keys()].find((f: any) => f.name === "double")!
    );
    assert.ok(fb);
    assert.ok(fb!.returnTypes.includes("number"));
  });

  it("dump() が人間が読める形式を返す", () => {
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      add(1, 2);
    `, { collectFeedback: true }) as VMResult;

    const dump = result.feedback!.dump();
    assert.ok(dump.includes("Feedback for add"));
    assert.ok(dump.includes("callCount: 1"));
    assert.ok(dump.includes("monomorphic"));
  });
});
