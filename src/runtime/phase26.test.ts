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

describe("Phase 26 - JIT で Math.X が動く (host import + native ops)", () => {
  it("hot loop の Math.sqrt: JIT 結果と VM 結果が一致", async () => {
    const src = `
      function f(n) {
        var s = 0;
        for (var i = 1; i <= n; i = i + 1) s = s + Math.sqrt(i);
        return s;
      }
      f(50);
    `;
    const noJit = vmEvaluate(src);
    const withJit = await vmEvaluate(src, { jit: true, jitThreshold: 1, useIR: true });
    assert.equal(withJit, noJit);
  });

  it("hot loop の Math.sin: host import 経由で JIT", async () => {
    const src = `
      function f(n) {
        var s = 0;
        for (var i = 0; i < n; i = i + 1) s = s + Math.sin(i);
        return s;
      }
      f(50);
    `;
    const noJit = vmEvaluate(src);
    const withJit = await vmEvaluate(src, { jit: true, jitThreshold: 1, useIR: true });
    // 浮動小数点演算の累積誤差を許容
    assert.ok(Math.abs((withJit as number) - (noJit as number)) < 1e-10);
  });

  it("Math.atan2 (2 引数 host import)", async () => {
    const src = `
      function f(n) {
        var s = 0;
        for (var i = 1; i <= n; i = i + 1) s = s + Math.atan2(i, n);
        return s;
      }
      f(20);
    `;
    const noJit = vmEvaluate(src);
    const withJit = await vmEvaluate(src, { jit: true, jitThreshold: 1, useIR: true });
    assert.ok(Math.abs((withJit as number) - (noJit as number)) < 1e-10);
  });

  it("Math.floor (Wasm native f64.floor)", async () => {
    const src = `
      function f(n) {
        var s = 0;
        for (var i = 1; i <= n; i = i + 1) s = s + Math.floor(i / 2);
        return s;
      }
      f(20);
    `;
    const noJit = vmEvaluate(src);
    const withJit = await vmEvaluate(src, { jit: true, jitThreshold: 1, useIR: true });
    assert.equal(withJit, noJit);
  });

  it("複数 Math 関数の組み合わせ", async () => {
    const src = `
      function f(n) {
        var s = 0;
        for (var i = 1; i <= n; i = i + 1) s = s + Math.sqrt(Math.abs(Math.sin(i)));
        return s;
      }
      f(30);
    `;
    const noJit = vmEvaluate(src);
    const withJit = await vmEvaluate(src, { jit: true, jitThreshold: 1, useIR: true });
    assert.ok(Math.abs((withJit as number) - (noJit as number)) < 1e-10);
  });

  it("tier log: Math.sin を含む関数が Wasm 化される", () => {
    const result = vmEvaluate(`
      function f(x) { return Math.sin(x) + Math.cos(x); }
      var s = 0;
      for (var i = 0; i < 50; i = i + 1) s = s + f(i);
      s;
    `, { jit: true, jitThreshold: 1, traceTier: true, useIR: true });
    const r = result as { tierLog?: string[] };
    const log = r.tierLog ?? [];
    // f が Wasm 化された痕跡を確認
    assert.ok(log.some(l => l.includes("f:") && l.toLowerCase().includes("wasm")),
              `expected tierLog to contain Wasm tier-up for f, got: ${JSON.stringify(log)}`);
  });
});

describe("Phase 26 - Date", () => {
  it("Date.now() returns a number", () => {
    const [tw, vm] = both(`typeof Date.now() === "number";`);
    assert.equal(tw, true);
    assert.equal(vm, true);
  });

  it("new Date(0).getTime() === 0", () => {
    const [tw, vm] = both(`new Date(0).getTime();`);
    assert.equal(tw, 0);
    assert.equal(vm, 0);
  });

  it("new Date(0).getUTCFullYear() === 1970", () => {
    const [tw, vm] = both(`new Date(0).getUTCFullYear();`);
    assert.equal(tw, 1970);
    assert.equal(vm, 1970);
  });

  it("new Date(2024, 0, 15) field accessors", () => {
    const [tw, vm] = both(`
      var d = new Date(2024, 0, 15);
      d.getFullYear() === 2024 && d.getMonth() === 0 && d.getDate() === 15;
    `);
    assert.equal(tw, true);
    assert.equal(vm, true);
  });

  it("Date.parse round-trip via toISOString", () => {
    const [tw, vm] = both(`
      var ms = Date.parse("2024-01-15T00:00:00.000Z");
      var d = new Date(ms);
      d.toISOString();
    `);
    assert.equal(tw, "2024-01-15T00:00:00.000Z");
    assert.equal(vm, "2024-01-15T00:00:00.000Z");
  });

  it("Date.UTC(2024, 0, 1) returns expected ms", () => {
    const [tw, vm] = both(`Date.UTC(2024, 0, 1);`);
    const expected = Date.UTC(2024, 0, 1);
    assert.equal(tw, expected);
    assert.equal(vm, expected);
  });

  it("Date.now() can be used to time work", () => {
    const [tw, vm] = both(`
      var start = Date.now();
      var s = 0;
      for (var i = 0; i < 100; i = i + 1) s = s + i;
      var elapsed = Date.now() - start;
      typeof elapsed === "number" && elapsed >= 0;
    `);
    assert.equal(tw, true);
    assert.equal(vm, true);
  });
});
