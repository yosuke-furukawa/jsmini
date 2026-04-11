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
