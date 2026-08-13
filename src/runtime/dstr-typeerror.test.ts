import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

// Phase 45: 分割代入の TypeError (RequireObjectCoercible / GetIterator / generator 引数)

const engines: { name: string; run: (src: string) => unknown }[] = [
  { name: "TW", run: (src) => evaluate(src) },
  { name: "VM", run: (src) => vmEvaluate(src) },
];

for (const { name, run } of engines) {
  const throwsType = (src: string) => {
    assert.throws(() => run(src), (e: unknown) => e instanceof TypeError, `TypeError expected: ${src}`);
  };

  describe(`分割代入の TypeError (${name})`, () => {
    it("ObjectPattern × null/undefined (空パターン含む)", () => {
      throwsType(`var {} = null;`);
      throwsType(`var {x} = undefined;`);
      throwsType(`({} = undefined);`);
      throwsType(`var {...r} = null;`);
    });

    it("関数/メソッドのパラメータ分割 × null", () => {
      throwsType(`function f({}) {} f(null);`);
      throwsType(`class C { m({}) {} } new C().m(null);`);
    });

    it("ArrayPattern × 非イテラブル", () => {
      throwsType(`var [a] = {};`);
      throwsType(`var [a] = 1;`);
      throwsType(`let x; [x] = {};`);
      throwsType(`var [a] = null;`);
    });

    it("ネストしたパターン × null", () => {
      throwsType(`var [{x}] = [null];`);
      throwsType(`var {a: {b}} = {a: null};`);
    });

    it("generator / async generator の呼び出し時に throw (next 不要)", () => {
      throwsType(`function* g({x}) {} g(null);`);
      throwsType(`class C { *m([{x}]) {} } new C().m([null]);`);
      throwsType(`async function* ag({x}) {} ag(null);`);
      throwsType(`function* g([a]) {} g(1);`);
    });

    it("coercible な値は throw しない (プリミティブの ObjectPattern / デフォルト適用)", () => {
      assert.equal(run(`var {x} = 0; x === undefined;`), true);
      assert.equal(run(`function* g({x} = {x: 1}) { yield x; } g().next().value;`), 1);
      assert.equal(run(`var [a, b] = "xy"; a + b;`) as any && true, true);
    });
  });
}
