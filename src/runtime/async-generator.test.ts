import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

// Phase 41: async generator (async function* / async *m() / for await) の
// 回帰テスト。evaluate/vmEvaluate は完了時に microtask を drain するので、
// 呼び出し後に logs が確定している。

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
  describe(`async generator (${name})`, () => {
    it("next が {value, done} の Promise を返す", () => {
      const logs = run(`
        async function* g() { yield 1; yield 2; }
        var it = g();
        it.next().then(function(r) { console.log(r.value, r.done); });
        it.next().then(function(r) { console.log(r.value, r.done); });
        it.next().then(function(r) { console.log(r.value, r.done); });
      `);
      assert.deepEqual(logs, [[1, false], [2, false], [undefined, true]]);
    });

    it("body 内の await が動く", () => {
      const logs = run(`
        async function* g() { var x = await Promise.resolve(10); yield x + 1; }
        g().next().then(function(r) { console.log(r.value); });
      `);
      assert.deepEqual(logs, [11]);
    });

    it("object literal の async *method", () => {
      const logs = run(`
        var callCount = 0;
        var obj = { async *method(x) { callCount = callCount + 1; yield x; } };
        obj.method(42).next().then(function(r) { console.log(callCount, r.value, r.done); });
      `);
      assert.deepEqual(logs, [[1, 42, false]]);
    });

    it("class の async *method", () => {
      const logs = run(`
        class C { async *g() { yield 5; } }
        new C().g().next().then(function(r) { console.log(r.value); });
      `);
      assert.deepEqual(logs, [5]);
    });

    it("return 値が {value, done:true} になる", () => {
      const logs = run(`
        async function* g() { yield 1; return 99; }
        var it = g();
        it.next().then(function(r) { console.log(r.value, r.done); });
        it.next().then(function(r) { console.log(r.value, r.done); });
      `);
      assert.deepEqual(logs, [[1, false], [99, true]]);
    });

    it("body の throw で next の Promise が reject される", () => {
      const logs = run(`
        async function* g() { yield 1; throw new Error("boom"); }
        var it = g();
        it.next().then(function(r) { console.log(r.value); });
        it.next().then(function() { console.log("unexpected"); }, function(e) { console.log("caught", e.message); });
      `);
      assert.deepEqual(logs, [1, ["caught", "boom"]]);
    });

    it("for await が async generator を反復する", () => {
      const logs = run(`
        async function* g() { yield 1; yield 2; yield 3; }
        (async function() {
          var sum = 0;
          for await (const v of g()) { sum = sum + v; }
          console.log(sum);
        })();
      `);
      assert.deepEqual(logs, [6]);
    });

    it("for await が sync 配列 (Promise 混在) を反復する", () => {
      const logs = run(`
        (async function() {
          for await (const v of [Promise.resolve(1), 2]) { console.log(v); }
        })();
      `);
      assert.deepEqual(logs, [1, 2]);
    });

    it("完了後の next は {undefined, done:true}", () => {
      const logs = run(`
        async function* g() { yield 1; }
        var it = g();
        it.next().then(function() {
          return it.next();
        }).then(function() {
          return it.next();
        }).then(function(r) { console.log(r.value, r.done); });
      `);
      assert.deepEqual(logs, [[undefined, true]]);
    });
  });
}
