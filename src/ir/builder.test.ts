import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../vm/compiler.js";
import { buildIR } from "./builder.js";
import { printIR } from "./printer.js";

function getFirstFunction(source: string) {
  const script = compile(source);
  // 最初の BytecodeFunction を定数テーブルから探す
  for (const c of script.constants) {
    if (typeof c === "object" && c !== null && "bytecode" in (c as any)) {
      return c as any;
    }
  }
  return script; // スクリプト自体
}

describe("IR Builder — basic", () => {
  it("constant expression: 2 + 3", () => {
    // function f() { return 2 + 3; }
    const func = getFirstFunction("function f() { return 2 + 3; }");
    const ir = buildIR(func);
    const dump = printIR(ir);
    console.log(dump);
    assert.ok(dump.includes("Const(2)"));
    assert.ok(dump.includes("Const(3)"));
    assert.ok(dump.includes("Add("));
    assert.ok(dump.includes("Return("));
    assert.ok(ir.blocks.length >= 1);
  });

  it("parameter: function add(a, b) { return a + b; }", () => {
    const func = getFirstFunction("function add(a, b) { return a + b; }");
    const ir = buildIR(func);
    const dump = printIR(ir);
    console.log(dump);
    assert.ok(dump.includes("Param(0)"));
    assert.ok(dump.includes("Param(1)"));
    assert.ok(dump.includes("Add("));
    assert.ok(dump.includes("Return("));
  });

  it("if branch creates multiple blocks", () => {
    const func = getFirstFunction("function f(x) { if (x) { return 1; } return 2; }");
    const ir = buildIR(func);
    const dump = printIR(ir);
    console.log(dump);
    assert.ok(dump.includes("Branch("));
    assert.ok(ir.blocks.length >= 2, "should have multiple blocks");
  });

  it("for loop creates phi nodes", () => {
    const func = getFirstFunction(`
      function sumTo(n) {
        var sum = 0;
        for (var i = 0; i < n; i++) {
          sum = sum + i;
        }
        return sum;
      }
    `);
    const ir = buildIR(func);
    const dump = printIR(ir);
    console.log(dump);
    // ループがあるのでブロックが3つ以上
    assert.ok(ir.blocks.length >= 3, "loop should create 3+ blocks");
    // Phi ノードがあるはず (sum, i の合流)
    const hasPhis = ir.blocks.some(b => b.phis.length > 0);
    assert.ok(hasPhis, "loop should have phi nodes");
  });

  it("fibonacci", () => {
    const func = getFirstFunction(`
      function fib(n) {
        if (n <= 1) { return n; }
        return fib(n - 1) + fib(n - 2);
      }
    `);
    const ir = buildIR(func);
    const dump = printIR(ir);
    console.log(dump);
    assert.ok(dump.includes("LessEqual(") || dump.includes("LessThan(") || dump.includes("Branch("));
    assert.ok(dump.includes("Return("));
  });
});
