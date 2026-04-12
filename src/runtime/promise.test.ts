import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

function run(source: string): unknown[] {
  const logs: unknown[][] = [];
  evaluate(source, { log: (...args: unknown[]) => logs.push(args) });
  return logs.map(l => l[0]);
}

describe("Promise (TW)", () => {
  it("new Promise + then", () => {
    const r = run(`new Promise(function(resolve) { resolve(42); }).then(function(v) { console.log(v); });`);
    assert.deepEqual(r, [42]);
  });

  it("then chain", () => {
    const r = run(`
      new Promise(function(resolve) { resolve(1); })
        .then(function(v) { return v + 10; })
        .then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [11]);
  });

  it("catch rejected", () => {
    const r = run(`
      new Promise(function(resolve, reject) { reject("err"); })
        .catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["err"]);
  });

  it("Promise.resolve", () => {
    const r = run(`Promise.resolve(99).then(function(v) { console.log(v); });`);
    assert.deepEqual(r, [99]);
  });

  it("Promise.reject", () => {
    const r = run(`Promise.reject("bad").catch(function(e) { console.log(e); });`);
    assert.deepEqual(r, ["bad"]);
  });

  it("execution order: sync before microtask", () => {
    const r = run(`
      console.log("a");
      Promise.resolve(1).then(function() { console.log("b"); });
      console.log("c");
    `);
    assert.deepEqual(r, ["a", "c", "b"]);
  });

  it("then with no handler passes value through", () => {
    const r = run(`
      Promise.resolve(5)
        .then()
        .then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [5]);
  });

  it("catch does not trigger on fulfilled", () => {
    const r = run(`
      Promise.resolve(1)
        .catch(function() { console.log("caught"); })
        .then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [1]);
  });

  it("then onFulfilled throw → catch", () => {
    const r = run(`
      Promise.resolve(1)
        .then(function() { throw "oops"; })
        .catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["oops"]);
  });

  it("nested then: then returns Promise", () => {
    const r = run(`
      Promise.resolve(1)
        .then(function(v) { return Promise.resolve(v + 1).then(function(v2) { return v2 + 1; }); })
        .then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [3]);
  });

  it("long chain (5 steps)", () => {
    const r = run(`
      Promise.resolve(0)
        .then(function(v) { return v + 1; })
        .then(function(v) { return v + 1; })
        .then(function(v) { return v + 1; })
        .then(function(v) { return v + 1; })
        .then(function(v) { return v + 1; })
        .then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [5]);
  });

  it("multiple then on same promise", () => {
    const r = run(`
      var p = Promise.resolve(42);
      p.then(function(v) { console.log("a"); });
      p.then(function(v) { console.log("b"); });
      p.then(function(v) { console.log("c"); });
    `);
    assert.deepEqual(r, ["a", "b", "c"]);
  });

  it("reject → catch → then (recovery)", () => {
    const r = run(`
      Promise.reject("bad")
        .catch(function(e) { return "recovered"; })
        .then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, ["recovered"]);
  });

  it("executor throw → catch", () => {
    const r = run(`
      new Promise(function() { throw "executor error"; })
        .catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["executor error"]);
  });

  it("interleaved microtasks (correct order)", () => {
    const r = run(`
      console.log("1");
      Promise.resolve().then(function() { console.log("3"); });
      Promise.resolve().then(function() { console.log("4"); });
      console.log("2");
    `);
    assert.deepEqual(r, ["1", "2", "3", "4"]);
  });

  it("then onRejected (2nd arg)", () => {
    const r = run(`
      Promise.reject("fail").then(
        function() { console.log("no"); },
        function(e) { console.log(e); }
      );
    `);
    assert.deepEqual(r, ["fail"]);
  });

  it("then throw skips next then, caught by catch", () => {
    const r = run(`
      Promise.resolve(1)
        .then(function() { throw "inner"; })
        .then(function() { console.log("skipped"); })
        .catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["inner"]);
  });

  it("double resolve wrapper", () => {
    const r = run(`
      Promise.resolve(Promise.resolve(42))
        .then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [42]);
  });

  it("resolve with another Promise (adopt)", () => {
    const r = run(`
      Promise.resolve(77)
        .then(function(v) { return Promise.resolve(v); })
        .then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [77]);
  });

  // Promise.all
  it("Promise.all — all fulfilled", () => {
    const r = run(`
      Promise.all([Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)])
        .then(function(v) { console.log(v[0] + "," + v[1] + "," + v[2]); });
    `);
    assert.deepEqual(r, ["1,2,3"]);
  });

  it("Promise.all — one rejects", () => {
    const r = run(`
      Promise.all([Promise.resolve(1), Promise.reject("fail"), Promise.resolve(3)])
        .catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["fail"]);
  });

  it("Promise.all — empty array", () => {
    const r = run(`
      Promise.all([]).then(function(v) { console.log(v.length); });
    `);
    assert.deepEqual(r, [0]);
  });

  // Promise.race
  it("Promise.race — first wins", () => {
    const r = run(`
      Promise.race([Promise.resolve(42), Promise.resolve(99)])
        .then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [42]);
  });

  it("Promise.race — reject wins", () => {
    const r = run(`
      Promise.race([Promise.reject("fast"), Promise.resolve(99)])
        .catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["fast"]);
  });

  // Promise.allSettled
  it("Promise.allSettled — mixed", () => {
    const r = run(`
      Promise.allSettled([Promise.resolve(1), Promise.reject("err")])
        .then(function(v) { console.log(v[0].status + ":" + v[0].value + "," + v[1].status + ":" + v[1].reason); });
    `);
    assert.deepEqual(r, ["fulfilled:1,rejected:err"]);
  });

  it("Promise.allSettled — all fulfilled", () => {
    const r = run(`
      Promise.allSettled([Promise.resolve("a"), Promise.resolve("b")])
        .then(function(v) { console.log(v[0].status + "," + v[1].status); });
    `);
    assert.deepEqual(r, ["fulfilled,fulfilled"]);
  });

  // Promise.any
  it("Promise.any — first fulfilled wins", () => {
    const r = run(`
      Promise.any([Promise.reject("a"), Promise.resolve(42), Promise.resolve(99)])
        .then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [42]);
  });

  it("Promise.any — all rejected", () => {
    const r = run(`
      Promise.any([Promise.reject("a"), Promise.reject("b")])
        .catch(function(e) { console.log(e.message); });
    `);
    assert.deepEqual(r, ["All promises were rejected"]);
  });
});

// ========== VM Promise tests ==========

function runVM(source: string): unknown[] {
  const logs: unknown[][] = [];
  vmEvaluate(source, { console: { log: (...args: unknown[]) => logs.push(args) } });
  return logs.map(l => l[0]);
}

describe("Promise (VM)", () => {
  it("new Promise + then", () => {
    assert.deepEqual(runVM(`new Promise(function(resolve) { resolve(42); }).then(function(v) { console.log(v); });`), [42]);
  });

  it("then chain", () => {
    assert.deepEqual(runVM(`Promise.resolve(1).then(function(v) { return v + 10; }).then(function(v) { console.log(v); });`), [11]);
  });

  it("catch rejected", () => {
    assert.deepEqual(runVM(`Promise.reject("err").catch(function(e) { console.log(e); });`), ["err"]);
  });

  it("execution order: sync before microtask", () => {
    assert.deepEqual(runVM(`console.log("a"); Promise.resolve().then(function() { console.log("b"); }); console.log("c");`), ["a", "c", "b"]);
  });

  it("long chain", () => {
    assert.deepEqual(runVM(`
      Promise.resolve(0)
        .then(function(v) { return v + 1; })
        .then(function(v) { return v + 1; })
        .then(function(v) { return v + 1; })
        .then(function(v) { console.log(v); });
    `), [3]);
  });

  it("reject → catch → then (recovery)", () => {
    assert.deepEqual(runVM(`Promise.reject("bad").catch(function() { return "ok"; }).then(function(v) { console.log(v); });`), ["ok"]);
  });

  it("multiple then on same promise", () => {
    assert.deepEqual(runVM(`var p = Promise.resolve(1); p.then(function() { console.log("a"); }); p.then(function() { console.log("b"); });`), ["a", "b"]);
  });

  // Combinators
  it("Promise.all — all fulfilled", () => {
    assert.deepEqual(runVM(`
      Promise.all([Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)])
        .then(function(v) { console.log(v[0] + "," + v[1] + "," + v[2]); });
    `), ["1,2,3"]);
  });

  it("Promise.all — one rejects", () => {
    assert.deepEqual(runVM(`
      Promise.all([Promise.resolve(1), Promise.reject("fail"), Promise.resolve(3)])
        .catch(function(e) { console.log(e); });
    `), ["fail"]);
  });

  it("Promise.all — empty", () => {
    assert.deepEqual(runVM(`Promise.all([]).then(function(v) { console.log(v.length); });`), [0]);
  });

  it("Promise.race — first wins", () => {
    assert.deepEqual(runVM(`
      Promise.race([Promise.resolve(42), Promise.resolve(99)])
        .then(function(v) { console.log(v); });
    `), [42]);
  });

  it("Promise.allSettled — mixed", () => {
    assert.deepEqual(runVM(`
      Promise.allSettled([Promise.resolve(1), Promise.reject("err")])
        .then(function(v) { console.log(v[0].status + "," + v[1].status); });
    `), ["fulfilled,rejected"]);
  });

  it("Promise.any — first fulfilled", () => {
    assert.deepEqual(runVM(`
      Promise.any([Promise.reject("a"), Promise.resolve(42)])
        .then(function(v) { console.log(v); });
    `), [42]);
  });

  it("Promise.any — all rejected", () => {
    assert.deepEqual(runVM(`
      Promise.any([Promise.reject("a"), Promise.reject("b")])
        .catch(function(e) { console.log(e.message); });
    `), ["All promises were rejected"]);
  });
});

// ========== test262-style spec compliance tests ==========

describe("Promise (spec compliance)", () => {
  // 27.2.1.1: resolve called multiple times — only first takes effect
  it("resolve called twice — second is ignored", () => {
    const r = run(`
      new Promise(function(resolve) { resolve(1); resolve(2); })
        .then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [1]);
  });

  // 27.2.1.1: reject called after resolve — ignored
  it("reject after resolve — ignored", () => {
    const r = run(`
      new Promise(function(resolve, reject) { resolve(1); reject("err"); })
        .then(function(v) { console.log("ok:" + v); })
        .catch(function(e) { console.log("bad:" + e); });
    `);
    assert.deepEqual(r, ["ok:1"]);
  });

  // 27.2.1.1: resolve after reject — ignored
  it("resolve after reject — ignored", () => {
    const r = run(`
      new Promise(function(resolve, reject) { reject("err"); resolve(1); })
        .then(function(v) { console.log("bad:" + v); })
        .catch(function(e) { console.log("ok:" + e); });
    `);
    assert.deepEqual(r, ["ok:err"]);
  });

  // 27.2.5.4: then always returns new Promise
  it("then returns a new promise (not same)", () => {
    const r = run(`
      var p = Promise.resolve(1);
      var p2 = p.then(function(v) { return v; });
      console.log(p === p2 ? "same" : "different");
    `);
    assert.deepEqual(r, ["different"]);
  });

  // 27.2.5.4: then handler called asynchronously even if already settled
  it("then handler is async even for settled promise", () => {
    const r = run(`
      var order = "";
      var p = Promise.resolve(1);
      p.then(function() { order = order + "B"; });
      order = order + "A";
      Promise.resolve().then(function() { console.log(order); });
    `);
    assert.deepEqual(r, ["AB"]);
  });

  // 27.2.5.4: then with non-function arguments — identity/thrower
  it("then(non-function, non-function) passes through", () => {
    const r = run(`
      Promise.resolve(42).then(null, null).then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [42]);
  });

  it("rejected + then(non-function) passes rejection through", () => {
    const r = run(`
      Promise.reject("err").then(null).catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["err"]);
  });

  // 27.2.1.3.2: resolve with self → TypeError
  // (jsmini simplified: no self-resolution check yet, skip)

  // Chaining: then handler returns rejected promise
  it("then returns rejected promise → next catch", () => {
    const r = run(`
      Promise.resolve(1)
        .then(function() { return Promise.reject("inner-err"); })
        .catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["inner-err"]);
  });

  // Microtask ordering: nested then
  it("microtask ordering: nested promise.then", () => {
    const r = run(`
      var order = "";
      Promise.resolve().then(function() {
        order = order + "1";
        Promise.resolve().then(function() { order = order + "3"; });
      });
      Promise.resolve().then(function() {
        order = order + "2";
      });
      Promise.resolve().then(function() {
        // this runs after "2" because "3" was enqueued during "1"
      }).then(function() {
        console.log(order);
      });
    `);
    assert.deepEqual(r, ["123"]);
  });

  // Promise.resolve with thenable (another JSPromise)
  it("Promise.resolve(promise) returns same promise", () => {
    const r = run(`
      var p = Promise.resolve(42);
      var p2 = Promise.resolve(p);
      console.log(p === p2 ? "same" : "different");
    `);
    assert.deepEqual(r, ["same"]);
  });

  // Error in then handler → rejection propagation
  it("error propagation through chain", () => {
    const r = run(`
      Promise.resolve(1)
        .then(function() { throw "e1"; })
        .then(function() { console.log("should not run"); })
        .then(function() { console.log("should not run 2"); })
        .catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["e1"]);
  });

  // Promise.all preserves order
  it("Promise.all preserves order", () => {
    const r = run(`
      Promise.all([
        Promise.resolve(3),
        Promise.resolve(1),
        Promise.resolve(2)
      ]).then(function(v) { console.log(v[0] + "," + v[1] + "," + v[2]); });
    `);
    assert.deepEqual(r, ["3,1,2"]);
  });

  // Promise.race with reject
  it("Promise.race — reject wins if first", () => {
    const r = run(`
      Promise.race([Promise.reject("fast"), Promise.resolve(1)])
        .catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["fast"]);
  });
});
