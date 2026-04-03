import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createIRFunction, createBlock, createConst, createParam, createPhi, createOp,
  isPhi,
  type IRFunction, type Block, type Op,
} from "./types.js";
import { printIR } from "./printer.js";

describe("IR types", () => {
  it("createIRFunction creates an empty function", () => {
    const func = createIRFunction("test", 2);
    assert.equal(func.name, "test");
    assert.equal(func.paramCount, 2);
    assert.equal(func.blocks.length, 0);
    assert.equal(func.nextOpId, 0);
  });

  it("createConst creates a constant op", () => {
    const func = createIRFunction("test", 0);
    const c = createConst(func, 42);
    assert.equal(c.opcode, "Const");
    assert.equal(c.value, 42);
    assert.equal(c.type, "i32");
    assert.equal(c.id, 0);
  });

  it("createParam creates a parameter op", () => {
    const func = createIRFunction("test", 2);
    const p0 = createParam(func, 0);
    const p1 = createParam(func, 1);
    assert.equal(p0.index, 0);
    assert.equal(p1.index, 1);
    assert.equal(p0.id, 0);
    assert.equal(p1.id, 1);
  });

  it("createOp auto-increments id", () => {
    const func = createIRFunction("test", 0);
    const a = createConst(func, 1);
    const b = createConst(func, 2);
    const c = createOp(func, "Add", [a.id, b.id], "i32");
    assert.equal(a.id, 0);
    assert.equal(b.id, 1);
    assert.equal(c.id, 2);
    assert.equal(c.opcode, "Add");
    assert.deepEqual(c.args, [0, 1]);
  });

  it("createPhi creates a phi node", () => {
    const func = createIRFunction("test", 0);
    const phi = createPhi(func, "i32");
    assert.equal(phi.opcode, "Phi");
    assert.equal(isPhi(phi), true);
    phi.inputs.push([0, 1]);
    phi.inputs.push([1, 2]);
    assert.equal(phi.inputs.length, 2);
  });

  it("Block has ops, phis, successors, predecessors", () => {
    const block = createBlock(0);
    assert.equal(block.id, 0);
    assert.equal(block.ops.length, 0);
    assert.equal(block.phis.length, 0);
    assert.equal(block.successors.length, 0);
    assert.equal(block.predecessors.length, 0);
  });
});

describe("IR printer", () => {
  it("prints a simple function", () => {
    const func = createIRFunction("add", 2);
    const entry = createBlock(0);
    func.blocks.push(entry);

    const p0 = createParam(func, 0, "i32");
    const p1 = createParam(func, 1, "i32");
    const sum = createOp(func, "Add", [p0.id, p1.id], "i32");
    const ret = createOp(func, "Return", [sum.id], "any");

    entry.ops.push(p0, p1, sum, ret);

    const output = printIR(func);
    assert.ok(output.includes("== IR: add (params: 2) =="));
    assert.ok(output.includes("v0: i32 = Param(0)"));
    assert.ok(output.includes("v1: i32 = Param(1)"));
    assert.ok(output.includes("v2: i32 = Add(v0, v1)"));
    assert.ok(output.includes("Return(v2)"));
  });

  it("prints phi nodes", () => {
    const func = createIRFunction("loop", 0);
    const b0 = createBlock(0);
    const b1 = createBlock(1);
    b1.predecessors = [0, 1];
    func.blocks.push(b0, b1);

    const phi = createPhi(func, "i32");
    phi.inputs = [[0, 10], [1, 20]];
    b1.phis.push(phi);

    const output = printIR(func);
    assert.ok(output.includes("Phi(B0:v10, B1:v20)"));
  });

  it("prints blocks with successors and predecessors", () => {
    const func = createIRFunction("branch", 1);
    const b0 = createBlock(0);
    const b1 = createBlock(1);
    const b2 = createBlock(2);
    b0.successors = [1, 2];
    b1.predecessors = [0];
    b2.predecessors = [0];
    func.blocks.push(b0, b1, b2);

    const p = createParam(func, 0, "bool");
    const br = createOp(func, "Branch", [p.id], "any");
    b0.ops.push(p, br);

    const output = printIR(func);
    assert.ok(output.includes("B0 -> [B1, B2]:"));
    assert.ok(output.includes("B1 <- [B0]:"));
    assert.ok(output.includes("B2 <- [B0]:"));
  });

  it("prints constant folding example", () => {
    // 2 + 3 を表現
    const func = createIRFunction("constfold", 0);
    const entry = createBlock(0);
    func.blocks.push(entry);

    const c2 = createConst(func, 2);
    const c3 = createConst(func, 3);
    const add = createOp(func, "Add", [c2.id, c3.id], "i32");
    const ret = createOp(func, "Return", [add.id], "any");
    entry.ops.push(c2, c3, add, ret);

    const output = printIR(func);
    assert.ok(output.includes("v0: i32 = Const(2)"));
    assert.ok(output.includes("v1: i32 = Const(3)"));
    assert.ok(output.includes("v2: i32 = Add(v0, v1)"));
    assert.ok(output.includes("Return(v2)"));
  });
});
