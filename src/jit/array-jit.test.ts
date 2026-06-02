import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vmEvaluate } from "../vm/index.js";
import { compile } from "../vm/compiler.js";
import { buildIR } from "../ir/builder.js";
import { compileIRToWasm } from "../ir/codegen.js";

// Phase 29: 配列を引数で受け取る関数の JIT (WasmGC array)
// 以前は ref 型パラメータの型セクションエンコードがバグっていて
// "invalid value type 0x1" で Wasm 生成に失敗していた。

function getFn(src: string, name: string) {
  const top = compile(src);
  for (const c of top.constants) {
    if (c && typeof c === "object" && (c as any).name === name) return c as any;
  }
  throw new Error(`function ${name} not found`);
}

describe("Phase 29: array param JIT (WasmGC array)", () => {
  it("配列引数を取る関数が Wasm にコンパイルできる", () => {
    const fn = getFn(
      `function dot(a, b, n) {
         var s = 0;
         for (var i = 0; i < n; i = i + 1) { s = s + a[i] * b[i]; }
         return s;
       }
       dot([1,2],[3,4],2);`,
      "dot",
    );
    const ir = buildIR(fn, {});
    const result = compileIRToWasm(ir);
    assert.ok(result !== null, "compileIRToWasm should not return null for array-param function");
    assert.ok((result as any).hasArrayOps, "should be flagged as array ops");
  });

  it("dot product が JIT 有効でも正しい結果を返す", () => {
    const src = `
      function dot(a, b, n) {
        var s = 0;
        for (var i = 0; i < n; i = i + 1) { s = s + a[i] * b[i]; }
        return s;
      }
      var a = []; var b = [];
      for (var k = 0; k < 100; k = k + 1) { a[k] = k; b[k] = 2; }
      var total = 0;
      for (var r = 0; r < 50; r = r + 1) { total = total + dot(a, b, 100); }
      total;
    `;
    const plain = vmEvaluate(src);
    const jit = vmEvaluate(src, { jit: true, jitThreshold: 5, useIR: true });
    assert.equal(jit, plain);
    // dot = sum(k*2, k=0..99) = 2 * 4950 = 9900; * 50 = 495000
    assert.equal(jit, 495000);
  });

  it("配列の書き込み (ArraySet) を含む関数も JIT できる", () => {
    const src = `
      function scale(a, n, factor) {
        for (var i = 0; i < n; i = i + 1) { a[i] = a[i] * factor; }
        var s = 0;
        for (var j = 0; j < n; j = j + 1) { s = s + a[j]; }
        return s;
      }
      var a = [];
      for (var k = 0; k < 100; k = k + 1) { a[k] = 1; }
      var total = 0;
      for (var r = 0; r < 50; r = r + 1) {
        var arr = [];
        for (var m = 0; m < 100; m = m + 1) { arr[m] = 1; }
        total = total + scale(arr, 100, 3);
      }
      total;
    `;
    const plain = vmEvaluate(src);
    const jit = vmEvaluate(src, { jit: true, jitThreshold: 5, useIR: true });
    assert.equal(jit, plain);
  });
});
