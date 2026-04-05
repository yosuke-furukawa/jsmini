import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../vm/compiler.js";
import { buildIR } from "./builder.js";
import { printIR } from "./printer.js";
import { optimize } from "./optimize.js";
import { compileIRToWasm } from "./codegen.js";

function getFirstFunction(source: string) {
  const script = compile(source);
  for (const c of script.constants) {
    if (typeof c === "object" && c !== null && "bytecode" in (c as any)) {
      return c as any;
    }
  }
  return script;
}

function irPipeline(source: string): { result: number; optimizedIR: string } | null {
  const func = getFirstFunction(source);
  const ir = buildIR(func);

  console.log("=== before optimize ===");
  console.log(printIR(ir));

  optimize(ir);

  const optimizedIR = printIR(ir);
  console.log("=== after optimize ===");
  console.log(optimizedIR);

  const compiled = compileIRToWasm(ir);
  if (!compiled) return null;

  const wasmFunc = (compiled.instance.exports as any)[ir.name];
  return { result: wasmFunc(), optimizedIR };
}

describe("IR → Wasm codegen", () => {
  it("constant expression: return 2 + 3", () => {
    const r = irPipeline("function f() { return 2 + 3; }");
    assert.ok(r !== null, "should compile to wasm");
    assert.equal(r!.result, 5);
    // IR は Const(5) に畳み込まれてるはず
    assert.ok(r!.optimizedIR.includes("Const(5)"));
  });

  it("nested: return (1 + 2) * (3 + 4)", () => {
    const r = irPipeline("function f() { return (1 + 2) * (3 + 4); }");
    assert.ok(r !== null);
    assert.equal(r!.result, 21);
    assert.ok(r!.optimizedIR.includes("Const(21)"));
  });

  it("parameters: add(a, b)", () => {
    const func = getFirstFunction("function add(a, b) { return a + b; }");
    const ir = buildIR(func);
    optimize(ir);
    console.log(printIR(ir));

    const compiled = compileIRToWasm(ir);
    assert.ok(compiled !== null);

    const wasmAdd = (compiled!.instance.exports as any).add;
    assert.equal(wasmAdd(3, 4), 7);
    assert.equal(wasmAdd(100, 200), 300);
    assert.equal(wasmAdd(-5, 10), 5);
  });

  it("comparison + constant fold: 3 < 5", () => {
    const r = irPipeline("function f() { return 3 < 5; }");
    assert.ok(r !== null);
    assert.equal(r!.result, 1); // true = 1
  });

  it("mixed: return (10 - 3) * 2 + 1", () => {
    const r = irPipeline("function f() { return (10 - 3) * 2 + 1; }");
    assert.ok(r !== null);
    assert.equal(r!.result, 15);
    assert.ok(r!.optimizedIR.includes("Const(15)"));
  });

  it("parameter arithmetic: f(x) = x * 2 + 1", () => {
    const func = getFirstFunction("function f(x) { return x * 2 + 1; }");
    const ir = buildIR(func);
    optimize(ir);
    console.log(printIR(ir));

    const compiled = compileIRToWasm(ir);
    assert.ok(compiled !== null);

    const wasmF = (compiled!.instance.exports as any).f;
    assert.equal(wasmF(5), 11);
    assert.equal(wasmF(0), 1);
    assert.equal(wasmF(10), 21);
  });
});

describe("IR → Wasm codegen — loops", () => {
  it("for loop sum: sumTo(n)", () => {
    const func = getFirstFunction("function sumTo(n) { var s=0; for(var i=0;i<n;i++){s=s+i;} return s; }");
    const ir = buildIR(func);
    optimize(ir);
    const compiled = compileIRToWasm(ir);
    assert.ok(compiled !== null, "should compile loop to wasm");
    const wasmF = (compiled!.instance.exports as any).sumTo;
    assert.equal(wasmF(0), 0);
    assert.equal(wasmF(10), 45);
    assert.equal(wasmF(100), 4950);
    assert.equal(wasmF(10000), 49995000);
  });

  it("nested loop: f(n) = n*n", () => {
    const func = getFirstFunction("function f(n){var s=0;for(var i=0;i<n;i++)for(var j=0;j<n;j++)s++;return s;}");
    const ir = buildIR(func);
    optimize(ir);
    const compiled = compileIRToWasm(ir);
    assert.ok(compiled !== null, "should compile nested loop to wasm");
    const wasmF = (compiled!.instance.exports as any).f;
    assert.equal(wasmF(0), 0);
    assert.equal(wasmF(1), 1);
    assert.equal(wasmF(5), 25);
    assert.equal(wasmF(10), 100);
    assert.equal(wasmF(100), 10000);
  });

  it("constant folding in loop: var seven = 3+4 → Const(7)", () => {
    const func = getFirstFunction("function f(n) { var seven = 3+4; var sum=0; for(var i=0;i<n;i=i+1){sum=sum+i+seven;} return sum; }");
    const ir = buildIR(func);
    optimize(ir);
    const dump = printIR(ir);
    assert.ok(dump.includes("Const(7)"), "3+4 should fold to 7");
    assert.ok(!dump.includes("Const(3)"), "Const(3) should be eliminated");
    const compiled = compileIRToWasm(ir);
    assert.ok(compiled !== null);
    const wasmF = (compiled!.instance.exports as any).f;
    assert.equal(wasmF(10), 115);   // 45 + 70
    assert.equal(wasmF(100), 5650); // 4950 + 700
  });

  it("loop with Inlining: add(i, 1) inlined", () => {
    const source = "function add(a,b){return a+b;} function f(n){var s=0;for(var i=0;i<n;i++){s=s+add(i,1);}return s;}";
    const script = compile(source);
    const funcs = new Map<string, any>();
    for (const c of script.constants) {
      if (typeof c === "object" && c !== null && "bytecode" in (c as any)) {
        funcs.set((c as any).name, c);
      }
    }
    const func = funcs.get("f")!;
    const ir = buildIR(func, { knownFuncs: funcs });
    optimize(ir, { knownFuncs: funcs });
    const dump = printIR(ir);
    // Call が消えてるはず
    assert.ok(!dump.includes("Call("), "add should be inlined (no Call)");
    const compiled = compileIRToWasm(ir);
    assert.ok(compiled !== null);
    const wasmF = (compiled!.instance.exports as any).f;
    assert.equal(wasmF(10), 55);   // sum(1..10) = 55
    assert.equal(wasmF(100), 5050);
  });
});
