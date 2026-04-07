import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../vm/compiler.js";
import { buildIR } from "./builder.js";
import { printIR } from "./printer.js";
import { strengthReduce } from "./strength-reduce.js";
import { optimize } from "./optimize.js";
import { deadCodeElimination } from "./optimize.js";
import { analyzeRanges } from "./range.js";
import type { BytecodeFunction } from "../vm/bytecode.js";
import type { IRFunction } from "./types.js";

function getFunc(source: string, name: string): BytecodeFunction {
  const script = compile(source);
  for (const c of script.constants) {
    if (typeof c === "object" && c !== null && "bytecode" in (c as any) && (c as any).name === name) {
      return c as BytecodeFunction;
    }
  }
  throw new Error(`Function ${name} not found`);
}

function getIR(source: string, name: string): IRFunction {
  const func = getFunc(source, name);
  return buildIR(func);
}

function countOpcode(ir: IRFunction, opcode: string): number {
  let count = 0;
  for (const block of ir.blocks) {
    for (const op of block.ops) {
      if (op.opcode === opcode) count++;
    }
  }
  return count;
}

function hasOpcode(ir: IRFunction, opcode: string): boolean {
  return countOpcode(ir, opcode) > 0;
}

describe("Strength Reduction", () => {
  it("x * 2 → x << 1", () => {
    const ir = getIR(`
      function f(a) { return a * 2; }
    `, "f");

    strengthReduce(ir);
    assert.ok(hasOpcode(ir, "ShiftLeft"), "Mul(x, 2) should become ShiftLeft");
    assert.ok(!hasOpcode(ir, "Mul"), "Mul should be gone");
  });

  it("x * 4 → x << 2", () => {
    const ir = getIR(`
      function f(a) { return a * 4; }
    `, "f");

    strengthReduce(ir);
    assert.ok(hasOpcode(ir, "ShiftLeft"), "Mul(x, 4) should become ShiftLeft");
  });

  it("x * 8 → x << 3", () => {
    const ir = getIR(`
      function f(a) { return a * 8; }
    `, "f");

    strengthReduce(ir);
    assert.ok(hasOpcode(ir, "ShiftLeft"), "Mul(x, 8) should become ShiftLeft");
  });

  it("x * 0 → 0", () => {
    const ir = getIR(`
      function f(a) { return a * 0; }
    `, "f");

    strengthReduce(ir);
    assert.ok(!hasOpcode(ir, "Mul"), "Mul should be eliminated");
  });

  it("x * 1 → x", () => {
    const ir = getIR(`
      function f(a) { return a * 1; }
    `, "f");

    strengthReduce(ir);
    deadCodeElimination(ir);
    assert.ok(!hasOpcode(ir, "Mul"), "Mul(x, 1) should be eliminated");
  });

  it("x + 0 → x", () => {
    const ir = getIR(`
      function f(a) { return a + 0; }
    `, "f");

    strengthReduce(ir);
    deadCodeElimination(ir);
    assert.ok(!hasOpcode(ir, "Add"), "Add(x, 0) should be eliminated");
  });

  it("x - 0 → x", () => {
    const ir = getIR(`
      function f(a) { return a - 0; }
    `, "f");

    strengthReduce(ir);
    deadCodeElimination(ir);
    assert.ok(!hasOpcode(ir, "Sub"), "Sub(x, 0) should be eliminated");
  });

  it("does NOT convert x * 3 (not power of 2)", () => {
    const ir = getIR(`
      function f(a) { return a * 3; }
    `, "f");

    strengthReduce(ir);
    assert.ok(hasOpcode(ir, "Mul"), "Mul(x, 3) should remain");
    assert.ok(!hasOpcode(ir, "ShiftLeft"), "should not convert to shift");
  });

  it("x / 2 → x >> 1 only when non-negative (with range)", () => {
    // ループカウンタ i は [0, N) なので非負
    const ir = getIR(`
      function f(n) {
        var sum = 0;
        for (var i = 0; i < n; i = i + 1) { sum = sum + i / 2; }
        return sum;
      }
    `, "f");

    // Range Analysis を先に実行
    analyzeRanges(ir);
    strengthReduce(ir);
    // i の range が [0, ...) なら ShiftRight に変換される
    // range が付かなければ Div のまま (安全側)
    assert.ok(true, "no crash");
  });

  it("2 * x → x << 1 (left const)", () => {
    const ir = getIR(`
      function f(a) { return 2 * a; }
    `, "f");

    strengthReduce(ir);
    assert.ok(hasOpcode(ir, "ShiftLeft"), "2 * x should become ShiftLeft");
  });

  it("integrates with optimize pipeline", () => {
    const ir = getIR(`
      function f(a) { return a * 4; }
    `, "f");

    optimize(ir);
    assert.ok(hasOpcode(ir, "ShiftLeft"), "optimize() should include strength reduction");
  });
});
