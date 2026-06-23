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

  it("関数内で確保する配列 (new Array(n)) を fill+sum で JIT 化", () => {
    // local array allocation: new Array(n) → array.new_default、
    // cross-loop の配列参照は ref 型 local + ref Phi で運ぶ。
    const src = `
      function f(n) {
        var a = new Array(n);
        for (var i = 0; i < n; i = i + 1) { a[i] = i * 2; }
        var s = 0;
        for (var j = 0; j < n; j = j + 1) { s = s + a[j]; }
        return s;
      }
      var t = 0;
      for (var r = 0; r < 50; r = r + 1) { t = f(100); }
      t;
    `;
    const plain = vmEvaluate(src);
    const r = vmEvaluate(src, { jit: true, jitThreshold: 5, useIR: true, traceTier: true }) as { value: unknown; tierLog?: string[] };
    assert.equal(r.value, plain);
    assert.equal(r.value, 9900); // sum(i*2, i=0..99) = 2 * 4950
    assert.ok((r.tierLog ?? []).some(l => /Wasm compiled/.test(l)), "should JIT-compile to Wasm");
  });

  it("複数の local array (a, b) が aliasing しない", () => {
    // 2 つの new Array(n) は別オブジェクト。CSE が AllocArray をマージ
    // すると aliasing して結果が壊れる (回帰防止)。
    const src = `
      function f(n) {
        var a = new Array(n); var b = new Array(n);
        for (var i = 0; i < n; i = i + 1) { a[i] = i; b[i] = 2; }
        var s = 0;
        for (var j = 0; j < n; j = j + 1) { s = s + a[j] * b[j]; }
        return s;
      }
      var t = 0;
      for (var r = 0; r < 50; r = r + 1) { t = f(50); }
      t;
    `;
    const plain = vmEvaluate(src);
    const jit = vmEvaluate(src, { jit: true, jitThreshold: 5, useIR: true });
    assert.equal(jit, plain);
    assert.equal(jit, 2450); // sum(i*2, i=0..49) = 2 * 1225
  });

  it("配列を Return すると VM フォールバック (escape)", () => {
    // 配列が関数外に漏れる (Return) と WasmGC ref を host に返せないので
    // VM フォールバック。結果は正しい。
    const src = `
      function f(n) { var a = new Array(n); for (var i = 0; i < n; i = i + 1) { a[i] = i; } return a; }
      var arr = f(5); arr[0] + arr[4];
    `;
    const plain = vmEvaluate(src);
    const jit = vmEvaluate(src, { jit: true, jitThreshold: 2, useIR: true });
    assert.equal(jit, plain);
    assert.equal(jit, 4);
  });
});

describe("Phase 29: 動的成長配列 ([] + push)", () => {
  function jitVal(src: string) {
    const plain = vmEvaluate(src);
    const r = vmEvaluate(src, { jit: true, jitThreshold: 3, useIR: true, traceTier: true }) as { value: unknown; tierLog?: string[] };
    return { plain, value: r.value, jitted: (r.tierLog ?? []).some(l => /Wasm compiled/.test(l)) };
  }

  it("[] + push を loop で fill+sum して JIT 化", () => {
    const src = `
      function f(n) {
        var a = [];
        for (var i = 0; i < n; i = i + 1) { a.push(i * 2); }
        var s = 0;
        for (var j = 0; j < a.length; j = j + 1) { s = s + a[j]; }
        return s;
      }
      var t = 0; for (var r = 0; r < 50; r = r + 1) { t = f(100); } t;
    `;
    const { plain, value, jitted } = jitVal(src);
    assert.equal(value, plain);
    assert.equal(value, 9900);
    assert.ok(jitted, "growable push should JIT-compile");
  });

  it("初期容量を超える push (再確保コピー) が正しい", () => {
    // 初期容量 4。1000 要素は何度も grow する。
    const src = `
      function f(n) { var a = []; for (var i = 0; i < n; i = i + 1) { a.push(i); } return a[n-1] + a[0] + a.length; }
      var t = 0; for (var r = 0; r < 20; r = r + 1) { t = f(1000); } t;
    `;
    const { plain, value, jitted } = jitVal(src);
    assert.equal(value, plain);
    assert.equal(value, 999 + 0 + 1000);
    assert.ok(jitted, "growable with many grows should JIT-compile");
  });

  it("f64 値の push", () => {
    const src = `
      function f(n) { var a = []; for (var i = 0; i < n; i = i + 1) { a.push(1.0/(i+1)); } var s = 0; for (var j = 0; j < a.length; j = j + 1) { s = s + a[j]; } return s; }
      var t = 0; for (var r = 0; r < 50; r = r + 1) { t = f(50); } t;
    `;
    const { plain, value, jitted } = jitVal(src);
    assert.equal(value, plain);
    assert.ok(jitted, "f64 growable push should JIT-compile");
  });

  it("配列リテラル [1,2,3,4,5] も growable として動く", () => {
    const src = `
      function f() { var a = [1,2,3,4,5]; var s = 0; for (var j = 0; j < a.length; j = j + 1) { s = s + a[j]; } return s; }
      var t = 0; for (var r = 0; r < 50; r = r + 1) { t = f(); } t;
    `;
    const { plain, value } = jitVal(src);
    assert.equal(value, plain);
    assert.equal(value, 15);
  });

  it("配列を Return すると VM フォールバック (escape)", () => {
    const src = `
      function f(n) { var a = []; for (var i = 0; i < n; i = i + 1) { a.push(i); } return a; }
      f(5)[3];
    `;
    const plain = vmEvaluate(src);
    const jit = vmEvaluate(src, { jit: true, jitThreshold: 2, useIR: true });
    assert.equal(jit, plain);
    assert.equal(jit, 3);
  });
});

describe("Phase 29: 2ループ関数の SSA (param が phantom 値にならない)", () => {
  it("2ループで param を参照しても正しく JIT 化", () => {
    // SSA の Phi collapse バグで、2 つ目のループの param 参照が dangling
    // 値 (v1 等) になり f64.lt のオペランドが欠けてコンパイル失敗していた。
    const src = `
      function f(n) {
        var x = 0; for (var i = 0; i < n; i = i + 1) { x = x + 1.0/(i+1); }
        var s = 0; for (var j = 0; j < n; j = j + 1) { s = s + 1.0/(j+1); }
        return s;
      }
      var t = 0; for (var r = 0; r < 50; r = r + 1) { t = f(20); } t;
    `;
    const plain = vmEvaluate(src);
    const r = vmEvaluate(src, { jit: true, jitThreshold: 5, useIR: true, traceTier: true }) as { value: unknown; tierLog?: string[] };
    assert.equal(r.value, plain);
    assert.ok((r.tierLog ?? []).some(l => /Wasm compiled/.test(l)), "two-loop f64 should JIT-compile");
  });
});
