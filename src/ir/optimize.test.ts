import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../vm/compiler.js";
import { buildIR } from "./builder.js";
import { printIR } from "./printer.js";
import { constantFolding, deadCodeElimination, optimize } from "./optimize.js";

function getFirstFunction(source: string) {
  const script = compile(source);
  for (const c of script.constants) {
    if (typeof c === "object" && c !== null && "bytecode" in (c as any)) {
      return c as any;
    }
  }
  return script;
}

function buildAndPrint(source: string, doOptimize = false) {
  const func = getFirstFunction(source);
  const ir = buildIR(func);
  if (doOptimize) optimize(ir);
  return printIR(ir);
}

describe("Constant Folding", () => {
  it("folds 2 + 3 into 5", () => {
    const func = getFirstFunction("function f() { return 2 + 3; }");
    const ir = buildIR(func);
    const before = printIR(ir);
    console.log("=== before ===");
    console.log(before);

    constantFolding(ir);
    const after = printIR(ir);
    console.log("=== after constant folding ===");
    console.log(after);

    assert.ok(before.includes("Add(v0, v1)"), "before should have Add");
    assert.ok(after.includes("Const(5)"), "after should have Const(5)");
    assert.ok(!after.includes("Add("), "after should not have Add");
  });

  it("folds nested: (2 + 3) * 4", () => {
    const func = getFirstFunction("function f() { return (2 + 3) * 4; }");
    const ir = buildIR(func);
    constantFolding(ir); // 1st pass: 2+3 → 5
    constantFolding(ir); // 2nd pass: 5*4 → 20
    const dump = printIR(ir);
    console.log(dump);
    assert.ok(dump.includes("Const(20)"), "should fold to 20");
  });

  it("folds comparison: 3 < 5", () => {
    const func = getFirstFunction("function f() { return 3 < 5; }");
    const ir = buildIR(func);
    constantFolding(ir);
    const dump = printIR(ir);
    console.log(dump);
    assert.ok(dump.includes("Const(true)"), "should fold to true");
  });

  it("does not fold non-constant", () => {
    const func = getFirstFunction("function f(x) { return x + 1; }");
    const ir = buildIR(func);
    constantFolding(ir);
    const dump = printIR(ir);
    assert.ok(dump.includes("Add("), "should keep Add (x is not constant)");
  });
});

describe("Dead Code Elimination", () => {
  it("removes unused constants after folding", () => {
    const func = getFirstFunction("function f() { return 2 + 3; }");
    const ir = buildIR(func);

    const before = printIR(ir);
    console.log("=== before ===");
    console.log(before);
    assert.ok(before.includes("Const(2)"));
    assert.ok(before.includes("Const(3)"));

    optimize(ir); // fold + DCE
    const after = printIR(ir);
    console.log("=== after optimize ===");
    console.log(after);

    // 2 と 3 は消えて 5 だけ残る
    assert.ok(after.includes("Const(5)"));
    assert.ok(!after.includes("Const(2)"), "Const(2) should be eliminated");
    assert.ok(!after.includes("Const(3)"), "Const(3) should be eliminated");
  });
});

describe("Optimize pipeline", () => {
  it("full pipeline: (1 + 2) * (3 + 4)", () => {
    const func = getFirstFunction("function f() { return (1 + 2) * (3 + 4); }");
    const ir = buildIR(func);

    console.log("=== before ===");
    console.log(printIR(ir));

    optimize(ir);

    console.log("=== after ===");
    const after = printIR(ir);
    console.log(after);

    assert.ok(after.includes("Const(21)"), "should fold to 21");
    assert.ok(!after.includes("Add("), "no Add left");
    assert.ok(!after.includes("Mul("), "no Mul left");
  });

  it("preserves non-foldable code", () => {
    const func = getFirstFunction("function f(x, y) { return x + y; }");
    const ir = buildIR(func);
    optimize(ir);
    const dump = printIR(ir);
    assert.ok(dump.includes("Param(0)"));
    assert.ok(dump.includes("Param(1)"));
    assert.ok(dump.includes("Add("));
  });

  it("fibonacci is not folded (dynamic)", () => {
    const func = getFirstFunction(`
      function fib(n) {
        if (n <= 1) { return n; }
        return fib(n - 1) + fib(n - 2);
      }
    `);
    const ir = buildIR(func);
    optimize(ir);
    const dump = printIR(ir);
    // n はパラメータなので畳み込めない
    assert.ok(dump.includes("Param(0)"));
    assert.ok(dump.includes("Sub("));
  });
});
