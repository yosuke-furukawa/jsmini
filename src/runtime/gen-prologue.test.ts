import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";
import { drainMicrotasks } from "./promise.js";

// Phase 50: generator / async generator の prologue (パラメータ束縛) を
// 呼び出し時に同期実行する (spec FunctionDeclarationInstantiation のタイミング)

const engines: { name: string; run: (src: string) => unknown }[] = [
  { name: "TW", run: (src) => evaluate(src) },
  { name: "VM", run: (src) => vmEvaluate(src) },
];

for (const { name, run } of engines) {
  const eq = (src: string, want: unknown) => assert.equal(run(src), want, src);
  const str = (v: unknown) => (v && typeof v === "object" && "data" in (v as any))
    ? Buffer.from(Object.values((v as any).data) as number[]).toString() : v;

  describe(`generator prologue の同期実行 (${name})`, () => {
    it("デフォルト値式の throw は呼び出し時に届く (next 不要)", () => {
      eq(`function E(){} function* g([x = (function(){ throw new E(); })()]) {}
          var r = "no"; try { g([undefined]); } catch (e) { r = e instanceof E ? "E" : "other"; } r === "E";`, true);
      eq(`function E(){} async function* ag([x = (function(){ throw new E(); })()]) {}
          var r = "no"; try { ag([undefined]); } catch (e) { r = e instanceof E ? "E" : "other"; } r === "E";`, true);
    });

    it("非イテラブル / null の分割は呼び出し時に TypeError", () => {
      assert.throws(() => run(`function* g([a]) {} g(1);`), TypeError);
      assert.throws(() => run(`function* g({x}) {} g(null);`), TypeError);
      assert.throws(() => run(`class C { *m([{x}]) {} } new C().m([null]);`), TypeError);
    });

    it("prologue で束縛した値が本体から見える (デフォルト値・分割・依存デフォルト)", () => {
      eq(`class C { *m([a, b = a * 2]) { yield a + b; } } new C().m([3]).next().value;`, 9);
      eq(`function* g(x = 5) { var y = yield x; yield y * 2; }
          var it = g(); var a = it.next().value; var b = it.next(10).value; a * 100 + b;`, 520);
    });

    it("prologue 内で作られたクロージャは本体と変数を共有する", () => {
      eq(`function* g(x, f = function() { return x; }) { x = 7; yield f(); } g(1).next().value;`, 7);
    });

    it("通常の反復は従来通り (for-of / 複数 yield / 引数付き)", () => {
      eq(`function* g(n) { for (var i = 0; i < n; i++) yield i; } var s = 0; for (var v of g(4)) s += v; s;`, 6);
      eq(`function* g() { yield 1; yield 2; } var it = g(); it.next(); it.next(); it.next().done;`, true);
    });

    it("async generator の next(v) 再開が壊れない", () => {
      const log = run(`var log = []; async function* ag(x = 1) { var y = yield x; yield y + 1; }
        var it = ag(); it.next().then(function(r){ log.push(r.value); return it.next(41); })
          .then(function(r){ log.push(r.value); }); log;`) as unknown[];
      drainMicrotasks();
      assert.deepEqual(log.map(str), [1, 42]);
    });
  });
}
