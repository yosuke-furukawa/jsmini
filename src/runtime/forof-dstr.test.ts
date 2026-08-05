import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

// Phase 44: for-of/for-in の宣言なし LHS (分割代入/メンバ/識別子) の回帰テスト

const engines: { name: string; run: (src: string) => unknown[] }[] = [
  {
    name: "TW",
    run: (src) => {
      const logs: unknown[] = [];
      evaluate(src, { log: (...a: unknown[]) => logs.push(a.length === 1 ? a[0] : a) });
      return logs;
    },
  },
  {
    name: "VM",
    run: (src) => {
      const logs: unknown[] = [];
      vmEvaluate(src, { console: { log: (...a: unknown[]) => logs.push(a.length === 1 ? a[0] : a) } });
      return logs;
    },
  },
];

for (const { name, run } of engines) {
  describe(`for-of/for-in の宣言なし LHS (${name})`, () => {
    it("配列パターンの for-of 代入", () => {
      assert.deepEqual(run(`
        var a, b, out = [];
        for ([a, b] of [[1, 2], [3, 4]]) out.push(a * b);
        console.log(out.join(","));
      `), ["2,12"]);
    });

    it("オブジェクトパターンの for-of 代入 (デフォルト値付き)", () => {
      assert.deepEqual(run(`
        var x, n = 0;
        for ({x = 10} of [{x: 1}, {}]) n += x;
        console.log(n);
      `), [11]);
    });

    it("単純識別子の for-of / for-in 代入", () => {
      assert.deepEqual(run(`
        var v, k, sum = 0, keys = [];
        for (v of [1, 2, 3]) sum += v;
        for (k in {a: 1, b: 2}) keys.push(k);
        console.log(sum, keys.join(","));
      `), [[6, "a,b"]]);
    });

    it("メンバーターゲット (o.p / arr[i])", () => {
      assert.deepEqual(run(`
        var o = {}, arr = [0];
        for (o.p of [1, 2, 3]) {}
        for (arr[0] in {x: 1}) {}
        console.log(o.p, arr[0]);
      `), [[3, "x"]]);
    });

    it("for-in キーの分割 (代入形 / 宣言形)", () => {
      assert.deepEqual(run(`
        var a, b;
        for ([a, b] in {xy: 1}) {}
        var out = [a, b];
        for (const [c, d] in {zw: 1}) out.push(c, d);
        console.log(out.join(""));
      `), ["xyzw"]);
    });

    it("ネスト + デフォルト値の for-of 代入", () => {
      assert.deepEqual(run(`
        var a, b, out = [];
        for ([a = 9, [b]] of [[undefined, [1]], [5, [6]]]) out.push(a, b);
        console.log(out.join(","));
      `), ["9,1,5,6"]);
    });

    it("関数内の for-of 代入 (外側の束縛に書く)", () => {
      assert.deepEqual(run(`
        var g = 0;
        function f() { for (g of [1, 2, 3]) {} }
        f();
        console.log(g);
      `), [3]);
    });

    it("分割代入式のデフォルト値と rest ({x = 1, ...r} = obj)", () => {
      assert.deepEqual(run(`
        var x, r, a;
        ({x = 1, ...r} = {y: 2});
        [a = 42] = [];
        console.log(x, r.y, a);
      `), [[1, 2, 42]]);
    });

    it("文字列の配列分割 (const [a, b] = \"xy\")", () => {
      assert.deepEqual(run(`
        const [a, b] = "xy";
        console.log(a + b);
      `), ["xy"]);
    });
  });
}
