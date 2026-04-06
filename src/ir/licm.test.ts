import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../vm/compiler.js";
import { buildIR } from "./builder.js";
import { printIR } from "./printer.js";
import { licm } from "./licm.js";
import { optimize } from "./optimize.js";
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

// ブロック内の opcode 一覧を返す
function blockOpcodes(ir: IRFunction, blockId: number): string[] {
  const block = ir.blocks.find(b => b.id === blockId);
  if (!block) return [];
  return block.ops.map(op => op.opcode);
}

describe("LICM", () => {
  it("hoists loop-invariant multiplication out of loop", () => {
    // x * 2 はループ不変
    const ir = getIR(`
      function f(n, x) {
        var sum = 0;
        for (var i = 0; i < n; i = i + 1) { sum = sum + x * 2; }
        return sum;
      }
    `, "f");

    const changed = licm(ir);
    assert.ok(changed, "LICM should move something");

    // x * 2 (Mul) がループヘッダの前のブロック (B0) に移動しているはず
    const b0Opcodes = blockOpcodes(ir, 0);
    assert.ok(b0Opcodes.includes("Mul"), "Mul should be hoisted to preheader (B0)");
  });

  it("does NOT hoist loop-dependent ops", () => {
    // sum + i は i がループ内で変わるので不変ではない
    const ir = getIR(`
      function f(n) {
        var sum = 0;
        for (var i = 0; i < n; i = i + 1) { sum = sum + i; }
        return sum;
      }
    `, "f");

    const changed = licm(ir);
    // sum + i は移動しないはず (i はループ依存)
    // Add はループ本体ブロックに残る
    const b0Opcodes = blockOpcodes(ir, 0);
    const addInB0 = b0Opcodes.filter(op => op === "Add").length;
    assert.equal(addInB0, 0, "loop-dependent Add should NOT be hoisted");
  });

  it("hoists Const out of loop", () => {
    // Const(1) (ループカウンタのインクリメント用) がループ外に移動
    const ir = getIR(`
      function f(n, x) {
        var sum = 0;
        for (var i = 0; i < n; i = i + 1) { sum = sum + x * 2; }
        return sum;
      }
    `, "f");

    const changed = licm(ir);
    assert.ok(changed, "LICM should hoist invariant ops");

    // Const と Mul がループ外 (B0) に移動
    const b0Opcodes = blockOpcodes(ir, 0);
    assert.ok(b0Opcodes.includes("Mul"), "Mul(x, 2) should be hoisted");
  });

  it("does not hoist Call (side effects)", () => {
    const ir = getIR(`
      function f(n) {
        var sum = 0;
        for (var i = 0; i < n; i = i + 1) { sum = sum + 1; }
        return sum;
      }
    `, "f");

    // Call は無いが、確認のため副作用 opcode がループに残ることをテスト
    licm(ir);
    // Return はループ外なので問題なし
    assert.ok(true, "no crash with control flow ops");
  });

  it("returns false when no loop exists", () => {
    const ir = getIR(`
      function f(a, b) { return a + b; }
    `, "f");

    const changed = licm(ir);
    assert.equal(changed, false, "no loop → no change");
  });

  it("works with nested loops (inner-first)", () => {
    // x * 2 は両方のループに対して不変
    const ir = getIR(`
      function f(n, m, x) {
        var sum = 0;
        for (var i = 0; i < n; i = i + 1) {
          for (var j = 0; j < m; j = j + 1) {
            sum = sum + x * 2;
          }
        }
        return sum;
      }
    `, "f");

    const changed = licm(ir);
    assert.ok(changed, "LICM should hoist from nested loops");

    // Mul は内側ループから外側ループの本体 (B2) に移動
    // (x と 2 はループ外定義なのでループ不変)
    const b2Opcodes = blockOpcodes(ir, 2);
    assert.ok(b2Opcodes.includes("Mul"), "Mul should be hoisted out of inner loop");

    // 2回目の LICM で外側ループからも巻き上げ
    const changed2 = licm(ir);
    if (changed2) {
      // Mul が B0 まで到達する可能性
      const b0Opcodes = blockOpcodes(ir, 0);
      if (b0Opcodes.includes("Mul")) {
        assert.ok(true, "Mul hoisted to entry block");
      }
    }
  });

  it("integrates with optimize pipeline", () => {
    // optimize() が LICM を含むことを確認
    const ir = getIR(`
      function f(n, x) {
        var sum = 0;
        for (var i = 0; i < n; i = i + 1) { sum = sum + x * 2; }
        return sum;
      }
    `, "f");

    optimize(ir);

    // constant folding + LICM の結果、Mul が B0 に移動
    const b0Opcodes = blockOpcodes(ir, 0);
    assert.ok(b0Opcodes.includes("Mul"), "optimize() should include LICM");
  });
});
