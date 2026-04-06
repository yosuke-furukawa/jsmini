import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../vm/compiler.js";
import { buildIR } from "./builder.js";
import { analyzeCFG } from "./loop-analysis.js";
import type { BytecodeFunction } from "../vm/bytecode.js";

function getFunc(source: string, name: string): BytecodeFunction {
  const script = compile(source);
  for (const c of script.constants) {
    if (typeof c === "object" && c !== null && "bytecode" in (c as any) && (c as any).name === name) {
      return c as BytecodeFunction;
    }
  }
  throw new Error(`Function ${name} not found`);
}

describe("Loop Analysis", () => {
  it("detects no loops in linear code", () => {
    const func = getFunc("function f(x) { return x + 1; }", "f");
    const ir = buildIR(func);
    const analysis = analyzeCFG(ir);
    assert.equal(analysis.loops.length, 0);
    assert.equal(analysis.backEdges.size, 0);
  });

  it("detects no loops in if/else", () => {
    const func = getFunc("function f(x) { if (x) { return 1; } return 2; }", "f");
    const ir = buildIR(func);
    const analysis = analyzeCFG(ir);
    assert.equal(analysis.loops.length, 0);
  });

  it("detects a for loop", () => {
    const func = getFunc("function f(n) { var s=0; for(var i=0;i<n;i++){s=s+i;} return s; }", "f");
    const ir = buildIR(func);
    const analysis = analyzeCFG(ir);

    console.log("back edges:", analysis.backEdges);
    console.log("loops:", analysis.loops);
    console.log("topo order:", analysis.topoOrder);

    assert.equal(analysis.loops.length, 1);
    const loop = analysis.loops[0];
    assert.equal(loop.header, 1, "B1 is loop header");
    assert.ok(loop.body.has(1), "body includes header");
    assert.ok(loop.body.has(2), "body includes B2");
    assert.ok(!loop.body.has(0), "body does not include B0");
    assert.ok(!loop.body.has(3), "body does not include exit B3");
    assert.equal(loop.exitBlock, 3, "exit is B3");
    assert.equal(analysis.backEdges.size, 1);
    assert.ok(analysis.loopHeaders.has(1));
  });

  it("topo order puts entry first", () => {
    const func = getFunc("function f(n) { var s=0; for(var i=0;i<n;i++){s=s+i;} return s; }", "f");
    const ir = buildIR(func);
    const analysis = analyzeCFG(ir);
    assert.equal(analysis.topoOrder[0], 0, "B0 is first in topo order");
  });

  it("detects nested loops", () => {
    const func = getFunc(`
      function f(n) {
        var s = 0;
        for (var i = 0; i < n; i++) {
          for (var j = 0; j < n; j++) {
            s = s + 1;
          }
        }
        return s;
      }
    `, "f");
    const ir = buildIR(func);
    const analysis = analyzeCFG(ir);

    console.log("nested loops:", analysis.loops.length);
    console.log("back edges:", analysis.backEdges);

    assert.ok(analysis.loops.length >= 2, "should detect 2 loops");
  });
});
