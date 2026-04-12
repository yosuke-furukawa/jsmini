import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";

function run(source: string): unknown[] {
  const logs: unknown[][] = [];
  evaluate(source, { log: (...args: unknown[]) => logs.push(args) });
  return logs.map(l => l[0]);
}

describe("async/await (TW)", () => {
  it("async function returns Promise", () => {
    const r = run(`
      async function f() { return 42; }
      f().then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [42]);
  });

  it("await Promise.resolve", () => {
    const r = run(`
      async function f() {
        var x = await Promise.resolve(10);
        console.log(x);
      }
      f();
    `);
    assert.deepEqual(r, [10]);
  });

  it("await non-Promise value", () => {
    const r = run(`
      async function f() {
        var x = await 42;
        console.log(x);
      }
      f();
    `);
    assert.deepEqual(r, [42]);
  });

  it("multiple awaits", () => {
    const r = run(`
      async function f() {
        var a = await 1;
        var b = await 2;
        var c = await 3;
        console.log(a + b + c);
      }
      f();
    `);
    assert.deepEqual(r, [6]);
  });

  it("await in expression", () => {
    const r = run(`
      async function f() {
        var x = (await 10) + (await 20);
        console.log(x);
      }
      f();
    `);
    assert.deepEqual(r, [30]);
  });

  it("async function expression", () => {
    const r = run(`
      var f = async function() { return await 99; };
      f().then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [99]);
  });

  it("async arrow function", () => {
    const r = run(`
      var f = async function(x) { return await x + 1; };
      f(10).then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [11]);
  });

  it("await chained promises", () => {
    const r = run(`
      async function f() {
        var p = Promise.resolve(1).then(function(v) { return v + 10; });
        var x = await p;
        console.log(x);
      }
      f();
    `);
    assert.deepEqual(r, [11]);
  });

  it("execution order: sync before async", () => {
    const r = run(`
      async function f() {
        console.log("b");
      }
      console.log("a");
      f();
      console.log("c");
    `);
    assert.deepEqual(r, ["a", "b", "c"]);
  });

  it("await causes async execution", () => {
    const r = run(`
      async function f() {
        console.log("b");
        await Promise.resolve();
        console.log("d");
      }
      console.log("a");
      f();
      console.log("c");
    `);
    assert.deepEqual(r, ["a", "b", "c", "d"]);
  });

  it("try/catch with await rejection", () => {
    const r = run(`
      async function f() {
        try {
          await Promise.reject("err");
        } catch (e) {
          console.log("caught:" + e);
        }
      }
      f();
    `);
    assert.deepEqual(r, ["caught:err"]);
  });

  it("async function rejection on throw", () => {
    const r = run(`
      async function f() { throw "oops"; }
      f().catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["oops"]);
  });

  it("nested async functions", () => {
    const r = run(`
      async function inner() { return await 5; }
      async function outer() {
        var x = await inner();
        console.log(x);
      }
      outer();
    `);
    assert.deepEqual(r, [5]);
  });

  it("async with Promise.all", () => {
    const r = run(`
      async function f() {
        var results = await Promise.all([
          Promise.resolve(1),
          Promise.resolve(2),
          Promise.resolve(3)
        ]);
        console.log(results[0] + results[1] + results[2]);
      }
      f();
    `);
    assert.deepEqual(r, [6]);
  });
});
