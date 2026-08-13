import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

// Phase 43: yield* 委譲の回帰テスト。
// 簡易化している部分 (sent 値の内側転送 / throw・return の転送) はテストしない

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
  describe(`yield* 委譲 (${name})`, () => {
    it("sync generator への委譲と return 値", () => {
      assert.deepEqual(run(`
        function* inner() { yield 1; yield 2; return 99; }
        function* outer() { var r = yield* inner(); yield r; }
        var it = outer();
        console.log(it.next().value, it.next().value, it.next().value, it.next().done);
      `), [[1, 2, 99, true]]);
    });

    it("配列/文字列への委譲", () => {
      assert.deepEqual(run(`
        function* g() { yield* [1, 2]; yield* "ab"; }
        var a = [];
        for (var v of g()) a.push(v);
        console.log(a.join(","));
      `), ["1,2,a,b"]);
    });

    it("async generator から async generator への委譲", () => {
      assert.deepEqual(run(`
        async function* inner() { yield 1; yield 2; }
        async function* outer() { yield 0; yield* inner(); yield 3; }
        (async function() {
          var a = [];
          for await (const v of outer()) a.push(v);
          console.log(a.join(","));
        })();
      `), ["0,1,2,3"]);
    });

    it("async generator から sync 配列への委譲", () => {
      assert.deepEqual(run(`
        async function* g() { yield* [1, 2]; }
        (async function() {
          var a = [];
          for await (const v of g()) a.push(v);
          console.log(a.join(","));
        })();
      `), ["1,2"]);
    });

    it("@@asyncIterator が非 callable なら TypeError で reject (フォールバックしない)", () => {
      assert.deepEqual(run(`
        var obj = {};
        Object.defineProperty(obj, Symbol.asyncIterator, { value: false });
        Object.defineProperty(obj, Symbol.iterator, { value: function() { throw new Error("should not fall back"); } });
        class C { async *gen() { yield* obj; } }
        new C().gen().next().then(
          function() { console.log("fulfilled"); },
          function(e) { console.log("rejected", e.constructor === TypeError); });
      `), [["rejected", true]]);
    });

    it("非イテラブルへの yield* は TypeError で reject", () => {
      assert.deepEqual(run(`
        class C { async *gen() { yield* 3; } }
        new C().gen().next().then(
          function() { console.log("fulfilled"); },
          function(e) { console.log("rejected", e instanceof TypeError); });
      `), [["rejected", true]]);
    });
  });
}
