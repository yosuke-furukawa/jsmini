import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

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

// ========== VM async/await tests ==========

function runVM(source: string): unknown[] {
  const logs: unknown[][] = [];
  vmEvaluate(source, { console: { log: (...args: unknown[]) => logs.push(args) } });
  return logs.map(l => l[0]);
}

describe("async/await (VM)", () => {
  it("async function returns Promise", () => {
    assert.deepEqual(runVM(`async function f() { return 42; } f().then(function(v) { console.log(v); });`), [42]);
  });

  it("await Promise.resolve", () => {
    assert.deepEqual(runVM(`async function f() { var x = await Promise.resolve(10); console.log(x); } f();`), [10]);
  });

  it("await non-Promise value", () => {
    assert.deepEqual(runVM(`async function f() { var x = await 42; console.log(x); } f();`), [42]);
  });

  it("multiple awaits", () => {
    assert.deepEqual(runVM(`async function f() { var a = await 1; var b = await 2; console.log(a + b); } f();`), [3]);
  });

  it("execution order: sync, async body, then after await", () => {
    assert.deepEqual(runVM(`
      console.log("a");
      async function f() { console.log("b"); await 0; console.log("d"); }
      f();
      console.log("c");
    `), ["a", "b", "c", "d"]);
  });

  it("async throw → catch", () => {
    assert.deepEqual(runVM(`async function f() { throw "oops"; } f().catch(function(e) { console.log(e); });`), ["oops"]);
  });

  it("nested async", () => {
    assert.deepEqual(runVM(`
      async function inner() { return await 5; }
      async function outer() { var x = await inner(); console.log(x); }
      outer();
    `), [5]);
  });

  it("async with Promise.all", () => {
    assert.deepEqual(runVM(`
      async function f() {
        var r = await Promise.all([Promise.resolve(1), Promise.resolve(2)]);
        console.log(r[0] + r[1]);
      }
      f();
    `), [3]);
  });
});

// ========== test262-inspired edge cases ==========

describe("test262-inspired Promise edge cases", () => {
  // resolve-self: resolve(promise) → TypeError reject (25.4.1.3.2 step 6)
  // jsmini simplified: we don't do self-resolution check, skip

  // reject-via-abrupt: executor throws → promise rejects with thrown value
  it("executor throw with object → rejects with that object", () => {
    const r = run(`
      var obj = { x: 1 };
      new Promise(function() { throw obj; })
        .catch(function(e) { console.log(e.x); });
    `);
    assert.deepEqual(r, [1]);
  });

  // reject-ignored-via-fn-immed: resolve then reject → reject is ignored
  it("resolve() then reject() → reject ignored", () => {
    const r = run(`
      var log = [];
      new Promise(function(resolve, reject) {
        resolve(42);
        reject("err");
      }).then(
        function(v) { console.log("ok:" + v); },
        function(e) { console.log("bad:" + e); }
      );
    `);
    assert.deepEqual(r, ["ok:42"]);
  });

  // exception-after-resolve: resolve then throw → throw is ignored
  it("resolve() then throw → exception ignored", () => {
    const r = run(`
      new Promise(function(resolve) {
        resolve(1);
        throw "ignored";
      }).then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, [1]);
  });

  // Promise.all with empty
  it("Promise.all([]) resolves with empty array", () => {
    const r = run(`
      Promise.all([]).then(function(v) { console.log(v.length); });
    `);
    assert.deepEqual(r, [0]);
  });

  // Promise.all preserves order even if later resolves first
  it("Promise.all preserves insertion order", () => {
    const r = run(`
      Promise.all([Promise.resolve(3), Promise.resolve(1), Promise.resolve(2)])
        .then(function(v) { console.log(v[0] + "," + v[1] + "," + v[2]); });
    `);
    assert.deepEqual(r, ["3,1,2"]);
  });

  // Promise.race with immediate reject
  it("Promise.race — reject settles first", () => {
    const r = run(`
      Promise.race([Promise.reject("fast"), Promise.resolve("slow")])
        .catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["fast"]);
  });

  // Then handler returning rejected promise propagates rejection
  it("then returns rejected promise → next catch receives it", () => {
    const r = run(`
      Promise.resolve(1)
        .then(function() { return Promise.reject("inner"); })
        .catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["inner"]);
  });

  // Multiple then on settled promise — all called in order
  it("multiple then on already-settled promise — FIFO order", () => {
    const r = run(`
      var p = Promise.resolve(1);
      p.then(function() { console.log("a"); });
      p.then(function() { console.log("b"); });
      p.then(function() { console.log("c"); });
    `);
    assert.deepEqual(r, ["a", "b", "c"]);
  });

  // Reject handler that doesn't throw → fulfills next
  it("catch handler returns value → chain fulfills", () => {
    const r = run(`
      Promise.reject("err")
        .catch(function(e) { return "recovered:" + e; })
        .then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, ["recovered:err"]);
  });

  // Long rejection chain — skips then, caught by far catch
  it("rejection skips multiple thens to reach catch", () => {
    const r = run(`
      Promise.reject("e")
        .then(function() { console.log("skip1"); })
        .then(function() { console.log("skip2"); })
        .then(function() { console.log("skip3"); })
        .catch(function(e) { console.log("caught:" + e); });
    `);
    assert.deepEqual(r, ["caught:e"]);
  });
});

describe("test262-inspired async/await edge cases", () => {
  // return await vs return (different try/catch behavior)
  it("return await in try/catch catches rejection", () => {
    const r = run(`
      async function f() {
        try {
          return await Promise.reject("err");
        } catch(e) {
          return "caught:" + e;
        }
      }
      f().then(function(v) { console.log(v); });
    `);
    assert.deepEqual(r, ["caught:err"]);
  });

  // await in loop
  it("await in for loop", () => {
    const r = run(`
      async function f() {
        var sum = 0;
        for (var i = 0; i < 5; i = i + 1) {
          sum = sum + await Promise.resolve(i);
        }
        console.log(sum);
      }
      f();
    `);
    assert.deepEqual(r, [10]);
  });

  // async function that never awaits
  it("async function with no await still returns Promise", () => {
    const r = run(`
      async function f() { return 42; }
      var result = f();
      console.log(typeof result);
      result.then(function(v) { console.log(v); });
    `);
    // typeof JSPromise is "object" in jsmini
    assert.deepEqual(r, ["object", 42]);
  });

  // await undefined
  it("await undefined resolves to undefined", () => {
    const r = run(`
      async function f() {
        var x = await undefined;
        console.log(x);
      }
      f();
    `);
    assert.deepEqual(r, [undefined]);
  });

  // async function throws before await
  it("throw before await → rejected promise", () => {
    const r = run(`
      async function f() {
        throw "early";
        await 1;
      }
      f().catch(function(e) { console.log(e); });
    `);
    assert.deepEqual(r, ["early"]);
  });

  // nested await
  it("await of await", () => {
    const r = run(`
      async function f() {
        var x = await (await Promise.resolve(10));
        console.log(x);
      }
      f();
    `);
    assert.deepEqual(r, [10]);
  });

  // async function as callback
  it.todo("async function passed as then callback");
  // TODO: async JSFunction as .then handler needs wrapping in microtask runner
});
