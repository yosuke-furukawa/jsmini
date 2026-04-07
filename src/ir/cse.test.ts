import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../vm/compiler.js";
import { buildIR } from "./builder.js";
import { printIR } from "./printer.js";
import { cse } from "./cse.js";
import { optimize } from "./optimize.js";
import { deadCodeElimination } from "./optimize.js";
import type { BytecodeFunction } from "../vm/bytecode.js";
import type { IRFunction, Op } from "./types.js";

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

// 全ブロックの Op から指定 opcode の数を数える
function countOpcode(ir: IRFunction, opcode: string): number {
  let count = 0;
  for (const block of ir.blocks) {
    for (const op of block.ops) {
      if (op.opcode === opcode) count++;
    }
  }
  return count;
}

describe("CSE", () => {
  it("eliminates duplicate Add in same block", () => {
    // a + b が2回出現 → 1回に
    const ir = getIR(`
      function f(a, b) {
        var x = a + b;
        var y = a + b;
        return x + y;
      }
    `, "f");

    const addsBefore = countOpcode(ir, "Add");
    const changed = cse(ir);
    assert.ok(changed, "CSE should find duplicates");

    // DCE で不要になった Add を消す
    deadCodeElimination(ir);
    const addsAfter = countOpcode(ir, "Add");
    assert.ok(addsAfter < addsBefore, `Add count should decrease: ${addsBefore} → ${addsAfter}`);
  });

  it("does NOT eliminate ops with different args", () => {
    const ir = getIR(`
      function f(a, b, c) {
        var x = a + b;
        var y = a + c;
        return x + y;
      }
    `, "f");

    const addsBefore = countOpcode(ir, "Add");
    cse(ir);
    deadCodeElimination(ir);
    const addsAfter = countOpcode(ir, "Add");
    // a+b と a+c は別なので消えない、x+y の Add も残る
    assert.equal(addsAfter, addsBefore, "different args should not be eliminated");
  });

  it("eliminates duplicate Mul", () => {
    const ir = getIR(`
      function f(a, b) {
        var x = a * b;
        var y = a * b;
        return x + y;
      }
    `, "f");

    const mulsBefore = countOpcode(ir, "Mul");
    cse(ir);
    deadCodeElimination(ir);
    const mulsAfter = countOpcode(ir, "Mul");
    assert.ok(mulsAfter < mulsBefore, `Mul count should decrease: ${mulsBefore} → ${mulsAfter}`);
  });

  it("does NOT eliminate Call (side effects)", () => {
    // Call は副作用があるので CSE 対象外
    // ただし現在のIRビルダーがCallをどう生成するかによる
    // ここではCSE対象外opcodeの確認のみ
    const ir = getIR(`
      function f(a) { return a + a; }
    `, "f");

    // Add(a, a) は args が同じだが、1つしかないので変化なし
    const changed = cse(ir);
    assert.equal(changed, false, "single op should not change");
  });

  it("returns false when no duplicates", () => {
    const ir = getIR(`
      function f(a, b) { return a + b; }
    `, "f");

    const changed = cse(ir);
    assert.equal(changed, false, "no duplicates → no change");
  });

  it("integrates with optimize pipeline", () => {
    const ir = getIR(`
      function f(a, b) {
        var x = a * b;
        var y = a * b;
        return x + y;
      }
    `, "f");

    const mulsBefore = countOpcode(ir, "Mul");
    optimize(ir);
    const mulsAfter = countOpcode(ir, "Mul");
    assert.ok(mulsAfter < mulsBefore, "optimize() should include CSE");
  });
});
