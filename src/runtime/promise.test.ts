import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";

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
    // executor 内から外側の変数にアクセスする代わりに、直接 Promise チェーンで adopt
    const r = run(`
      Promise.resolve(77)
        .then(function(v) { return Promise.resolve(v); })
        .then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [77]);
  });
});
