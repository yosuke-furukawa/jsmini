import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vmEvaluate } from "../vm/index.js";
import type { VMResult } from "../vm/index.js";
import { classifyType } from "./feedback.js";

function getFeedbackFor(result: VMResult, name: string) {
  const fb = result.feedback!;
  const func = [...(fb as any).feedbacks.keys()].find((f: any) => f.name === name)!;
  return fb.get(func);
}

describe("JIT - classifyType", () => {
  it("整数を int32/uint32 に分類する", () => {
    assert.equal(classifyType(0), "uint32");
    assert.equal(classifyType(42), "uint32");
    assert.equal(classifyType(-1), "int32");
    assert.equal(classifyType(-2147483648), "int32"); // -2^31
    assert.equal(classifyType(4294967295), "uint32"); // 2^32 - 1
  });

  it("小数を f64 に分類する", () => {
    assert.equal(classifyType(3.14), "f64");
    assert.equal(classifyType(0.1), "f64");
  });

  it("巨大整数を f64 に分類する", () => {
    assert.equal(classifyType(2 ** 53), "f64");
  });

  it("非数値を正しく分類する", () => {
    assert.equal(classifyType("hello"), "string");
    assert.equal(classifyType(true), "boolean");
    assert.equal(classifyType(null), "null");
    assert.equal(classifyType(undefined), "undefined");
    assert.equal(classifyType({}), "object");
  });
});

describe("JIT - 型フィードバック", () => {
  it("関数の呼び出し回数を記録する", () => {
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      for (var i = 0; i < 10; i = i + 1) { add(i, i); }
    `, { collectFeedback: true }) as VMResult;

    const fb = getFeedbackFor(result, "add");
    assert.ok(fb);
    assert.equal(fb!.callCount, 10);
  });

  it("整数引数を uint32 として記録する", () => {
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      add(1, 2);
      add(3, 4);
    `, { collectFeedback: true }) as VMResult;

    const fb = getFeedbackFor(result, "add");
    assert.ok(fb);
    assert.equal(fb!.isMonomorphic, true);
    assert.deepEqual(fb!.argTypes[0], ["uint32", "uint32"]);
  });

  it("小数引数を f64 として記録する", () => {
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      add(1.5, 2.5);
    `, { collectFeedback: true }) as VMResult;

    const fb = getFeedbackFor(result, "add");
    assert.ok(fb);
    assert.deepEqual(fb!.argTypes[0], ["f64", "f64"]);
  });

  it("Wasm 型を推奨する (uint32 → i32)", () => {
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      add(1, 2);
    `, { collectFeedback: true }) as VMResult;

    const wasmTypes = result.feedback!.getWasmArgTypes(
      [...(result.feedback as any).feedbacks.keys()].find((f: any) => f.name === "add")!
    );
    assert.deepEqual(wasmTypes, ["i32", "i32"]);
  });

  it("dump() に wasmArgTypes が含まれる", () => {
    const result = vmEvaluate(`
      function add(a, b) { return a + b; }
      add(1, 2);
    `, { collectFeedback: true }) as VMResult;

    const dump = result.feedback!.dump();
    assert.ok(dump.includes("wasmArgTypes: [i32, i32]"));
  });

  it("戻り値の型を記録する", () => {
    const result = vmEvaluate(`
      function double(x) { return x * 2; }
      double(5);
    `, { collectFeedback: true }) as VMResult;

    const fb = getFeedbackFor(result, "double");
    assert.ok(fb);
    assert.ok(fb!.returnTypes.includes("uint32"));
  });
});
