import { describe, it } from "node:test";
import assert from "node:assert";
import { vmEvaluate } from "../vm/index.js";

// Phase 32: クラスタコンパイル (兄弟クロージャの同一モジュール化) と
// その過程で見つかったバグの回帰テスト

function jitEq(src: string, expectWasm = false) {
  const plain = vmEvaluate(src);
  const r = vmEvaluate(src, { jit: true, jitThreshold: 2, useIR: true, traceTier: true }) as { value: unknown; tierLog?: string[] };
  assert.deepEqual(r.value, plain);
  if (expectWasm) {
    assert.ok((r.tierLog ?? []).some(l => /Wasm compiled/.test(l)), "should JIT-compile");
  }
  return r.value;
}

describe("Phase 32 — クラスタコンパイル (兄弟クロージャ)", () => {
  it("数値 upvalue を共有する兄弟呼び出し", () => {
    jitEq(`
      function Field() {
        var scale = 3;
        function helper(x) { return x * scale; }
        function kernel(n) {
          var s = 0;
          for (var i = 0; i < n; i++) { s = s + helper(i); }
          return s;
        }
        this.run = function(n) { return kernel(n); };
      }
      var f = new Field();
      var r = 0;
      for (var k = 0; k < 5; k++) { r = f.run(100); }
      r;
    `, true);
  });

  it("配列を兄弟に渡して書き換える (lin_solve → set_bnd 形)", () => {
    jitEq(`
      function Field() {
        var width = 10;
        function fill_edge(a) { a[0] = 42; a[width - 1] = 42; return 0; }
        function kernel(a, n) {
          for (var i = 1; i < n - 1; i++) { a[i] = i; }
          fill_edge(a);
          var s = 0;
          for (var i = 0; i < n; i++) { s = s + a[i]; }
          return s;
        }
        this.run = function(a) { return kernel(a, a.length); };
      }
      var f = new Field();
      var arr = new Array(10);
      for (var i = 0; i < 10; i++) arr[i] = 0;
      var r = 0;
      for (var k = 0; k < 5; k++) { r = f.run(arr); }
      r;
    `, true);
  });

  it("f64 + 分岐両腕で兄弟呼び出し (lin_solve 縮小形)", () => {
    jitEq(`
      function Field() {
        var width = 8;
        function edge(b, x) { x[0] = x[1]; x[width - 1] = x[width - 2]; return 0; }
        function solve(b, x, x0, a, c) {
          if (a === 0 && c === 1) {
            for (var i = 0; i < width; i++) { x[i] = x0[i]; }
            edge(b, x);
          } else {
            var inv = 1 / c;
            for (var k = 0; k < 3; k++) {
              for (var i = 1; i < width - 1; i++) { x[i] = (x0[i] + a * (x[i-1] + x[i+1])) * inv; }
              edge(b, x);
            }
          }
          return x[2];
        }
        this.run = function(x, x0) { return solve(1, x, x0, 0.5, 2.0); };
      }
      var f = new Field();
      var x = new Array(8), x0 = new Array(8);
      for (var i = 0; i < 8; i++) { x[i] = 0; x0[i] = i; }
      var r = 0;
      for (var k = 0; k < 4; k++) { r = f.run(x, x0); }
      Math.round(r * 1000);
    `);
  });

  it("callee が差し替わったら deopt して正しく実行", () => {
    jitEq(`
      function Field() {
        var fn = function(x) { return x * 2; };
        function kernel(n) {
          var s = 0;
          for (var i = 0; i < n; i++) { s = s + fn(i); }
          return s;
        }
        this.run = function(n) { return kernel(n); };
        this.swap = function() { fn = function(x) { return x * 100; }; };
      }
      var f = new Field();
      var a = 0;
      for (var k = 0; k < 5; k++) { a = f.run(10); }
      f.swap();
      var b = f.run(10);
      a * 100000 + b;
    `);
  });
});

describe("Phase 32 — 過程で見つかったバグの回帰", () => {
  it("連鎖代入 lastX = x[i] = v が value を返す (IR builder desync)", () => {
    // 旧: builder の SetPropertyComputed が arr を peek で残し (VM は value を
    // push)、後続の Sta が配列を拾って lastX が配列になっていた
    jitEq(`
      function f(x, x0, n) {
        var lastX = x[0];
        for (var i = 1; i < n; i++) {
          lastX = x[i] = (x0[i] + 0.5 * lastX) * 0.5;
        }
        return Math.round(lastX * 1000);
      }
      var x = new Array(8), x0 = new Array(8);
      for (var i = 0; i < 8; i++) { x[i] = 0; x0[i] = i; }
      var r = 0;
      for (var k = 0; k < 4; k++) { r = f(x, x0, 8); }
      r;
    `);
  });

  it("ArrayGet(x, 計算済み index) のオペランド順 (leaf=配列 ref)", () => {
    // 旧: 配列 ref 引数が sawLeafBefore を立てず、計算済み index が
    // inline のまま arr と index が逆転していた
    jitEq(`
      function f(x, x0, n) {
        for (var i = 1; i < n - 1; i++) { x[i] = x0[i] + 0.5 * x[i-1]; }
        return Math.round(x[2] * 1000);
      }
      var x = new Array(8), x0 = new Array(8);
      for (var i = 0; i < 8; i++) { x[i] = 0; x0[i] = i; }
      var r = 0;
      for (var k = 0; k < 4; k++) { r = f(x, x0, 8); }
      r;
    `);
  });

  it("127 超の locals を持つ大きい関数 (LEB128 エンコード)", () => {
    // 旧: local index を生バイトで push しており >127 で壊れていた
    const vars = Array.from({ length: 70 }, (_, i) => `var v${i} = ${i} * 1.5;`).join("\n");
    const sum = Array.from({ length: 70 }, (_, i) => `v${i}`).join(" + ");
    jitEq(`
      function f(n) {
        ${vars}
        var s = 0;
        for (var i = 0; i < n; i++) { s = s + ${sum}; }
        return Math.round(s);
      }
      var r = 0;
      for (var k = 0; k < 4; k++) { r = f(10); }
      r;
    `);
  });

  it("ループ持ち関数は初回呼び出しでコンパイルされる", () => {
    const src = `
      function kernel(n) { var s = 0; for (var i = 0; i < n; i++) { s = s + i; } return s; }
      kernel(1000);
    `;
    const r = vmEvaluate(src, { jit: true, jitThreshold: 100, useIR: true, traceTier: true }) as { value: unknown; tierLog?: string[] };
    assert.equal(r.value, 499500);
    assert.ok((r.tierLog ?? []).some(l => /Wasm compiled/.test(l)), "loopy fn should compile on first call despite high threshold");
  });
});

describe("Phase 32 — 深さ 2 クラスタ (callee が callee を呼ぶ)", () => {
  it("project → lin_solve → set_bnd 形が JIT される", () => {
    const src = `
      function Field() {
        var width = 8;
        function edge(x) { x[0] = x[1]; return 0; }
        function solve(x, x0, c) {
          var inv = 1 / c;
          for (var i = 1; i < width - 1; i++) { x[i] = (x0[i] + x[i-1]) * inv; }
          edge(x);
          return 0;
        }
        function outer(x, x0) {
          for (var i = 0; i < width; i++) { x0[i] = i * 0.5; }
          solve(x, x0, 2.0);
          edge(x0);
          return x[3];
        }
        this.run = function(x, x0) { return outer(x, x0); };
      }
      var f = new Field();
      var x = new Array(8), x0 = new Array(8);
      for (var i = 0; i < 8; i++) { x[i] = 0; x0[i] = 0; }
      var r = 0;
      for (var k = 0; k < 4; k++) { r = f.run(x, x0); }
      Math.round(r * 1000);
    `;
    const plain = vmEvaluate(src);
    const r = vmEvaluate(src, { jit: true, jitThreshold: 2, useIR: true, traceTier: true }) as { value: unknown; tierLog?: string[] };
    assert.equal(r.value, plain);
    assert.ok((r.tierLog ?? []).some(l => /Wasm compiled/.test(l)), "depth-2 cluster should compile");
  });

  it("深さ 2 でも callee 差し替えで deopt して正しい", () => {
    const src = `
      function Field() {
        var inner = function(x) { return x + 1; };
        function mid(n) { return inner(n) * 2; }
        function outer(n) {
          var s = 0;
          for (var i = 0; i < n; i++) { s = s + mid(i); }
          return s;
        }
        this.run = function(n) { return outer(n); };
        this.swap = function() { inner = function(x) { return x + 100; }; };
      }
      var f = new Field();
      var a = 0;
      for (var k = 0; k < 5; k++) { a = f.run(10); }
      f.swap();
      var b = f.run(10);
      a * 100000 + b;
    `;
    const plain = vmEvaluate(src);
    const jit = vmEvaluate(src, { jit: true, jitThreshold: 2, useIR: true });
    assert.equal(jit, plain);
  });
});
