import { describe, it } from "node:test";
import assert from "node:assert";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";
import { isJSString, jsStringToString } from "../vm/js-string.js";

const unwrap = (v: unknown): unknown => isJSString(v) ? jsStringToString(v) : v;

function bothModes(name: string, source: string, expect: (v: unknown) => void) {
  it(`${name} (TW)`, () => expect(evaluate(source)));
  it(`${name} (VM)`, () => expect(vmEvaluate(source)));
}

describe("Phase 27 — Map", () => {
  bothModes("new Map() empty", `
    const m = new Map();
    m.size;
  `, v => assert.equal(v, 0));

  bothModes("set / get / has", `
    const m = new Map();
    m.set("a", 1);
    m.set("b", 2);
    [m.get("a"), m.get("b"), m.has("a"), m.has("c"), m.size];
  `, v => {
    const arr = v as unknown[];
    assert.equal(arr[0], 1);
    assert.equal(arr[1], 2);
    assert.equal(arr[2], true);
    assert.equal(arr[3], false);
    assert.equal(arr[4], 2);
  });

  bothModes("delete / clear", `
    const m = new Map();
    m.set("a", 1); m.set("b", 2);
    m.delete("a");
    const r1 = [m.has("a"), m.size];
    m.clear();
    [r1[0], r1[1], m.size];
  `, v => {
    const arr = v as unknown[];
    assert.equal(arr[0], false);
    assert.equal(arr[1], 1);
    assert.equal(arr[2], 0);
  });

  bothModes("constructor with iterable", `
    const m = new Map([["a", 1], ["b", 2], ["c", 3]]);
    [m.size, m.get("a"), m.get("b"), m.get("c")];
  `, v => {
    const arr = v as unknown[];
    assert.equal(arr[0], 3);
    assert.equal(arr[1], 1);
    assert.equal(arr[2], 2);
    assert.equal(arr[3], 3);
  });

  bothModes("for-of over Map yields [k, v]", `
    const m = new Map([["a", 1], ["b", 2]]);
    let result = "";
    for (const [k, v] of m) {
      result += k + "=" + v + ",";
    }
    result;
  `, v => assert.equal(unwrap(v), "a=1,b=2,"));

  bothModes("for-of over m.keys()", `
    const m = new Map([["x", 10], ["y", 20]]);
    let s = "";
    for (const k of m.keys()) s += k;
    s;
  `, v => assert.equal(unwrap(v), "xy"));

  bothModes("for-of over m.values()", `
    const m = new Map([["x", 10], ["y", 20]]);
    let s = 0;
    for (const v of m.values()) s += v;
    s;
  `, v => assert.equal(v, 30));

  bothModes("forEach", `
    const m = new Map([["a", 1], ["b", 2]]);
    let s = "";
    m.forEach((v, k) => { s += k + ":" + v + ";"; });
    s;
  `, v => assert.equal(unwrap(v), "a:1;b:2;"));

  bothModes("number keys", `
    const m = new Map();
    m.set(1, "one"); m.set(2, "two");
    [m.get(1), m.get(2)];
  `, v => {
    const arr = v as unknown[];
    assert.equal(unwrap(arr[0]), "one");
    assert.equal(unwrap(arr[1]), "two");
  });

  bothModes("instanceof Map", `
    const m = new Map();
    m instanceof Map;
  `, v => assert.equal(v, true));
});

describe("Phase 27 — Set", () => {
  bothModes("new Set() empty", `new Set().size;`, v => assert.equal(v, 0));

  bothModes("add / has / delete", `
    const s = new Set();
    s.add(1); s.add(2); s.add(2);
    const r = [s.size, s.has(1), s.has(3)];
    s.delete(1);
    [r[0], r[1], r[2], s.has(1), s.size];
  `, v => {
    const arr = v as unknown[];
    assert.equal(arr[0], 2);
    assert.equal(arr[1], true);
    assert.equal(arr[2], false);
    assert.equal(arr[3], false);
    assert.equal(arr[4], 1);
  });

  bothModes("constructor with iterable", `
    const s = new Set([1, 2, 3, 2, 1]);
    s.size;
  `, v => assert.equal(v, 3));

  bothModes("for-of over Set", `
    const s = new Set([10, 20, 30]);
    let total = 0;
    for (const v of s) total += v;
    total;
  `, v => assert.equal(v, 60));

  bothModes("forEach over Set", `
    const s = new Set(["a", "b", "c"]);
    let r = "";
    s.forEach((v) => { r += v; });
    r;
  `, v => assert.equal(unwrap(v), "abc"));

  bothModes("instanceof Set", `
    const s = new Set();
    s instanceof Set;
  `, v => assert.equal(v, true));
});

describe("Phase 27 — WeakMap", () => {
  bothModes("set / get / has / delete", `
    const k1 = {};
    const k2 = {};
    const m = new WeakMap();
    m.set(k1, "v1");
    m.set(k2, "v2");
    const r = [m.get(k1), m.get(k2), m.has(k1)];
    m.delete(k1);
    [r[0], r[1], r[2], m.has(k1)];
  `, v => {
    const arr = v as unknown[];
    assert.equal(unwrap(arr[0]), "v1");
    assert.equal(unwrap(arr[1]), "v2");
    assert.equal(arr[2], true);
    assert.equal(arr[3], false);
  });

  bothModes("WeakMap rejects primitive key", `
    const m = new WeakMap();
    let err = null;
    try { m.set(1, "x"); } catch (e) { err = "caught"; }
    err;
  `, v => assert.equal(unwrap(v), "caught"));
});

describe("Phase 27 — WeakSet", () => {
  bothModes("add / has / delete", `
    const k1 = {};
    const k2 = {};
    const s = new WeakSet();
    s.add(k1); s.add(k2);
    const r = [s.has(k1), s.has(k2), s.has({})];
    s.delete(k1);
    [r[0], r[1], r[2], s.has(k1)];
  `, v => {
    const arr = v as unknown[];
    assert.equal(arr[0], true);
    assert.equal(arr[1], true);
    assert.equal(arr[2], false);
    assert.equal(arr[3], false);
  });

  bothModes("WeakSet rejects primitive", `
    const s = new WeakSet();
    let err = null;
    try { s.add(42); } catch (e) { err = "caught"; }
    err;
  `, v => assert.equal(unwrap(v), "caught"));
});
