import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

function both(source: string): [unknown, unknown] {
  return [evaluate(source), vmEvaluate(source)];
}

describe("Phase 26 - Math 三角関数", () => {
  it("Math.sin(0) === 0", () => {
    const [tw, vm] = both(`Math.sin(0);`);
    assert.equal(tw, 0);
    assert.equal(vm, 0);
  });

  it("Math.cos(0) === 1", () => {
    const [tw, vm] = both(`Math.cos(0);`);
    assert.equal(tw, 1);
    assert.equal(vm, 1);
  });

  it("Math.atan2(1, 1) === PI/4", () => {
    const [tw, vm] = both(`Math.atan2(1, 1) === Math.PI / 4;`);
    assert.equal(tw, true);
    assert.equal(vm, true);
  });

  it("Math.tan(PI/4) ≈ 1", () => {
    const [tw, vm] = both(`Math.abs(Math.tan(Math.PI / 4) - 1) < 1e-10;`);
    assert.equal(tw, true);
    assert.equal(vm, true);
  });

  it("Math.asin / acos / atan", () => {
    const [tw, vm] = both(`
      Math.asin(0) === 0 &&
      Math.acos(1) === 0 &&
      Math.atan(0) === 0;
    `);
    assert.equal(tw, true);
    assert.equal(vm, true);
  });
});

describe("Phase 26 - Math 対数 / 指数 / 双曲", () => {
  it("Math.log2(8) === 3", () => {
    const [tw, vm] = both(`Math.log2(8);`);
    assert.equal(tw, 3);
    assert.equal(vm, 3);
  });

  it("Math.log10(1000) === 3", () => {
    const [tw, vm] = both(`Math.log10(1000);`);
    assert.equal(tw, 3);
    assert.equal(vm, 3);
  });

  it("Math.exp(0) === 1", () => {
    const [tw, vm] = both(`Math.exp(0);`);
    assert.equal(tw, 1);
    assert.equal(vm, 1);
  });

  it("Math.hypot(3, 4) === 5", () => {
    const [tw, vm] = both(`Math.hypot(3, 4);`);
    assert.equal(tw, 5);
    assert.equal(vm, 5);
  });

  it("Math.cbrt(27) === 3", () => {
    const [tw, vm] = both(`Math.cbrt(27);`);
    assert.equal(tw, 3);
    assert.equal(vm, 3);
  });

  it("Math.sinh(0) === 0 / Math.tanh(0) === 0", () => {
    const [tw, vm] = both(`Math.sinh(0) === 0 && Math.cosh(0) === 1 && Math.tanh(0) === 0;`);
    assert.equal(tw, true);
    assert.equal(vm, true);
  });
});

describe("Phase 26 - Math 整数系", () => {
  it("Math.imul(3, 4) === 12", () => {
    const [tw, vm] = both(`Math.imul(3, 4);`);
    assert.equal(tw, 12);
    assert.equal(vm, 12);
  });

  it("Math.clz32(1) === 31", () => {
    const [tw, vm] = both(`Math.clz32(1);`);
    assert.equal(tw, 31);
    assert.equal(vm, 31);
  });

  it("Math.fround(1.1) is f32 representable", () => {
    const [tw, vm] = both(`Math.fround(1.1) !== 1.1;`);
    assert.equal(tw, true);
    assert.equal(vm, true);
  });
});

describe("Phase 26 - Math 定数", () => {
  it("LN2 / LN10 / LOG2E / LOG10E / SQRT2 / SQRT1_2", () => {
    const [tw, vm] = both(`
      Math.abs(Math.LN2 - 0.6931471805599453) < 1e-15 &&
      Math.abs(Math.LN10 - 2.302585092994046) < 1e-15 &&
      Math.abs(Math.LOG2E * Math.LN2 - 1) < 1e-15 &&
      Math.abs(Math.LOG10E * Math.LN10 - 1) < 1e-15 &&
      Math.abs(Math.SQRT2 * Math.SQRT1_2 - 1) < 1e-15;
    `);
    assert.equal(tw, true);
    assert.equal(vm, true);
  });
});
