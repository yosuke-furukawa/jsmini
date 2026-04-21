import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

function both(source: string): [unknown, unknown] {
  return [evaluate(source), vmEvaluate(source)];
}

function run(source: string): unknown[] {
  const logs: unknown[][] = [];
  evaluate(source, { log: (...args: unknown[]) => logs.push(args) });
  return logs.map(l => l[0]);
}

function runVM(source: string): unknown[] {
  const logs: unknown[][] = [];
  vmEvaluate(source, { log: (...args: unknown[]) => logs.push(args) });
  return logs.map(l => l[0]);
}

describe("Phase 25 - Object.defineProperty / getOwnPropertyDescriptor", () => {
  it("defineProperty with value descriptor sets the property", () => {
    const [tw, vm] = both(`
      var o = {};
      Object.defineProperty(o, "x", { value: 42 });
      o.x;
    `);
    assert.equal(tw, 42);
    assert.equal(vm, 42);
  });

  it("defineProperty returns the object", () => {
    const [tw, vm] = both(`
      var o = {};
      Object.defineProperty(o, "x", { value: 1 }) === o;
    `);
    assert.equal(tw, true);
    assert.equal(vm, true);
  });

  it("getOwnPropertyDescriptor returns value", () => {
    const [tw, vm] = both(`
      var o = { x: 10 };
      Object.getOwnPropertyDescriptor(o, "x").value;
    `);
    assert.equal(tw, 10);
    assert.equal(vm, 10);
  });

  it("getOwnPropertyDescriptor returns writable/enumerable/configurable", () => {
    const [tw, vm] = both(`
      var o = { x: 1 };
      var d = Object.getOwnPropertyDescriptor(o, "x");
      d.writable && d.enumerable && d.configurable;
    `);
    assert.equal(tw, true);
    assert.equal(vm, true);
  });

  it("getOwnPropertyDescriptor returns undefined for missing key", () => {
    const [tw, vm] = both(`
      Object.getOwnPropertyDescriptor({x:1}, "y") === undefined;
    `);
    assert.equal(tw, true);
    assert.equal(vm, true);
  });
});

describe("Phase 25 - Object.getPrototypeOf / setPrototypeOf", () => {
  it("setPrototypeOf then getPrototypeOf returns the same object", () => {
    const [tw, vm] = both(`
      var proto = { greet: function() { return 7; } };
      var o = {};
      Object.setPrototypeOf(o, proto);
      Object.getPrototypeOf(o) === proto;
    `);
    assert.equal(tw, true);
    assert.equal(vm, true);
  });

  it("setPrototypeOf enables prototype method lookup (VM)", () => {
    // VM のみ: プロトタイプチェーン経由のメソッド呼び出し
    assert.deepEqual(runVM(`
      var proto = { greet: function() { return 42; } };
      var o = {};
      Object.setPrototypeOf(o, proto);
      console.log(o.greet());
    `), [42]);
  });
});

describe("Phase 25 - Object.getOwnPropertyNames / getOwnPropertySymbols", () => {
  it("getOwnPropertyNames returns own string keys", () => {
    // TW と VM で length のみ比較 (JSString の等価性は別問題)
    const src = `Object.getOwnPropertyNames({a:1, b:2, c:3}).length;`;
    const [tw, vm] = both(src);
    assert.equal(tw, 3);
    assert.equal(vm, 3);
  });

  it("getOwnPropertyNames excludes __proto__ etc (VM)", () => {
    assert.deepEqual(runVM(`
      var o = { x: 1 };
      var names = Object.getOwnPropertyNames(o);
      console.log(names.length);
    `), [1]);
  });

  it("getOwnPropertySymbols returns an array", () => {
    const [tw, vm] = both(`
      Object.getOwnPropertySymbols({x:1}).length;
    `);
    assert.equal(tw, 0);
    assert.equal(vm, 0);
  });
});

