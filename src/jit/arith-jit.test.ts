import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vmEvaluate } from "../vm/index.js";

// Phase 29: JIT の算術コード生成バグ回帰
// 1. `/` を i32.div_s で整数除算していた (JS は常に浮動小数除算 7/2===3.5)
// 2. 非可換演算 (Sub/Div/Mod) で右オペランドが計算済みインライン値、
//    かつ左オペランドが leaf (Const/Param) のとき、スタック順が反転していた
//    例: 1/(n*2) が (n*2)/1 に、a-b*c が b*c-a になっていた

function jitMatchesVM(src: string): { vm: unknown; jit: unknown } {
  const vm = vmEvaluate(src);
  const jit = vmEvaluate(src, { jit: true, jitThreshold: 3, useIR: true });
  return { vm, jit };
}

describe("Phase 29: JIT division は浮動小数除算", () => {
  for (const [name, expr, n] of [
    ["1/n", "1/n", 15],
    ["10/n", "10/n", 4],
    ["n/2", "n/2", 7],
    ["1/(n*2)", "1/(n*2)", 3],
  ] as const) {
    it(`${name} が VM と一致`, () => {
      const src = `function f(n){ return ${expr}; } var s=0; for(var r=0;r<50;r=r+1){ s=f(${n}); } s;`;
      const { vm, jit } = jitMatchesVM(src);
      assert.equal(jit, vm);
    });
  }
});

describe("Phase 29: JIT 非可換演算のオペランド順", () => {
  for (const [name, body] of [
    ["a - b*c", "return a - b*c;"],
    ["a - (b+c)", "return a - (b+c);"],
    ["a*b - c", "return a*b - c;"],
  ] as const) {
    it(`${name} が VM と一致`, () => {
      const src = `function f(a,b,c){ ${body} } var s=0; for(var r=0;r<50;r=r+1){ s=f(100,3,4); } s;`;
      const { vm, jit } = jitMatchesVM(src);
      assert.equal(jit, vm);
    });
  }

  it("100 - n*2 (定数左 + 計算値右)", () => {
    const src = `function f(n){ return 100 - n*2; } var s=0; for(var r=0;r<50;r=r+1){ s=f(7); } s;`;
    const { vm, jit } = jitMatchesVM(src);
    assert.equal(jit, vm);
    assert.equal(jit, 86);
  });
});

describe("Phase 29: spectral-norm 風の f64 配列計算", () => {
  it("A(i,j)=1/(...) が JIT で正しい", () => {
    const src = `
      function A(i,j){ return 1/((i+j)*(i+j+1)/2+i+1); }
      var s=0; for(var r=0;r<100;r=r+1){ s = A(r%5, r%3); } s;
    `;
    const { vm, jit } = jitMatchesVM(src);
    assert.equal(jit, vm);
  });

  it("k3*sk*sk (インライン値が Math 呼び出しに埋もれない)", () => {
    const src = `
      function f(k){ var k3=k*k*k; var sk=Math.sin(k); return k3*sk*sk; }
      var s=0; for(var r=0;r<50;r=r+1){ s=f(3); } s;
    `;
    const { vm, jit } = jitMatchesVM(src);
    assert.equal(jit, vm);
  });

  it("1/(k3*sk*sk) 全体", () => {
    const src = `
      function f(n){ var a=0; for(var k=1;k<=n;k++){ var k3=k*k*k; var sk=Math.sin(k); a+=1/(k3*sk*sk); } return a; }
      var s=0; for(var r=0;r<30;r=r+1){ s=f(10); } s;
    `;
    const { vm, jit } = jitMatchesVM(src);
    assert.equal(jit, vm);
  });

  it("配列に f64 を貯める Au パターンが JIT で正しい", () => {
    const src = `
      function A(i,j){ return 1/((i+j)*(i+j+1)/2+i+1); }
      function Au(u,v){ for(var i=0;i<u.length;++i){ var t=0; for(var j=0;j<u.length;++j) t+=A(i,j)*u[j]; v[i]=t; } }
      var u=[1,1,1,1],v=[0,0,0,0];
      for(var r=0;r<100;r=r+1){ Au(u,v); }
      v[0]+","+v[1]+","+v[2]+","+v[3];
    `;
    const { vm, jit } = jitMatchesVM(src);
    assert.equal(jit, vm);
  });
});
