import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";
import { drainMicrotasks } from "./promise.js";
import { isJSString, jsStringToString } from "../vm/js-string.js";

// Phase 47: ビルトイン歯抜けの補充 (RegExp @@メソッド / ES2024-25 各種)

const engines: { name: string; run: (src: string) => unknown }[] = [
  { name: "TW", run: (src) => evaluate(src) },
  { name: "VM", run: (src) => vmEvaluate(src) },
];

for (const { name, run } of engines) {
  const isTrue = (src: string) => assert.equal(run(src), true, src);

  describe(`ビルトイン補充 (${name})`, () => {
    it("RegExp.prototype[Symbol.replace] (文字列/関数 replacement)", () => {
      isTrue(`/a/[Symbol.replace]("banana", "X") === "bXnana";`);
      isTrue(`/a/g[Symbol.replace]("banana", "X") === "bXnXnX";`);
      isTrue(`/[XY]/g[Symbol.replace]("aXbY", function(m) { return m === "X" ? "1" : "2"; }) === "a1b2";`);
    });

    it("RegExp.prototype[Symbol.match/search/split/matchAll]", () => {
      isTrue(`var m = /a(n)/[Symbol.match]("banana"); m[0] === "an" && m[1] === "n" && m.index === 1;`);
      isTrue(`/a/[Symbol.search]("banana") === 1;`);
      isTrue(`var p = /,/[Symbol.split]("a,b"); p[0] === "a" && p[1] === "b";`);
      isTrue(`var o = []; for (const m of /a/g[Symbol.matchAll]("banana")) o.push(m.index); o.join(",") === "1,3,5";`);
    });

    it("RegExp.escape", () => {
      isTrue(`RegExp.escape(".b*") .indexOf("\\\\.") === 0;`);
      isTrue(`new RegExp(RegExp.escape("a.b")).test("a.b");`);
    });

    it("Map/WeakMap getOrInsert / getOrInsertComputed", () => {
      isTrue(`var m = new Map(); m.getOrInsert("k", 1) === 1 && m.getOrInsert("k", 2) === 1;`);
      isTrue(`var m = new Map(); m.getOrInsertComputed("k", function(key) { return key + "!"; }) === "k!";`);
      isTrue(`var w = new WeakMap(); var o = {}; w.getOrInsert(o, 5) === 5 && w.getOrInsert(o, 9) === 5;`);
    });

    it("Map.groupBy", () => {
      isTrue(`var g = Map.groupBy([1,2,3,4], function(v) { return v % 2; }); g.get(1).length === 2 && g.get(0).length === 2;`);
    });

    it("Promise.prototype.finally が値を素通しする", () => {
      const src = `
        var log = [];
        Promise.resolve(7).finally(function() { log.push("f"); }).then(function(v) { log.push(v); });
        Promise.reject("e").finally(function() { log.push("g"); }).catch(function(r) { log.push(r); });
        log;
      `;
      const logs = run(src) as unknown[];
      drainMicrotasks();
      const disp = logs.map((v: unknown) => isJSString(v) ? jsStringToString(v) : v);
      // microtask 順: finally 2 つが先に走り、チェーンした then/catch が続く
      assert.deepEqual(disp, ["f", "g", 7, "e"]);
    });

    it("Promise.try が同期例外を rejection にする", () => {
      const src = `
        var log = [];
        Promise.try(function() { return 1; }).then(function(v) { log.push(v); });
        Promise.try(function() { throw "boom"; }).catch(function(e) { log.push(e); });
        log;
      `;
      const logs = run(src) as unknown[];
      drainMicrotasks();
      const disp = logs.map((v: unknown) => isJSString(v) ? jsStringToString(v) : v);
      assert.deepEqual(disp, [1, "boom"]);
    });
  });
}
