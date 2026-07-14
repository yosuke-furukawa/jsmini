import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Rng, hashSeed } from "./prng.js";

describe("Rng - 決定性", () => {
  it("同じ seed は同じ列を返す", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
  });

  it("違う seed は違う列を返す", () => {
    const a = new Rng(1);
    const b = new Rng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.next() === b.next()) same++;
    assert.ok(same < 5, `列が近すぎる (same=${same})`);
  });
});

describe("Rng - 範囲", () => {
  it("next() は [0,1)", () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      assert.ok(v >= 0 && v < 1);
    }
  });

  it("int(n) は [0,n)", () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(5);
      assert.ok(Number.isInteger(v) && v >= 0 && v < 5);
    }
  });

  it("range(lo,hi) は両端含む", () => {
    const r = new Rng(9);
    let sawLo = false, sawHi = false;
    for (let i = 0; i < 1000; i++) {
      const v = r.range(3, 6);
      assert.ok(v >= 3 && v <= 6);
      if (v === 3) sawLo = true;
      if (v === 6) sawHi = true;
    }
    assert.ok(sawLo && sawHi);
  });

  it("pick は必ず配列要素を返す", () => {
    const r = new Rng(11);
    const arr = ["a", "b", "c"] as const;
    for (let i = 0; i < 100; i++) assert.ok(arr.includes(r.pick(arr)));
  });

  it("weighted は重み 0 の要素を選ばない", () => {
    const r = new Rng(13);
    for (let i = 0; i < 500; i++) {
      const v = r.weighted([["x", 1], ["never", 0]] as const);
      assert.equal(v, "x");
    }
  });
});

describe("hashSeed", () => {
  it("決定的で 32bit に収まる", () => {
    assert.equal(hashSeed(100, 3), hashSeed(100, 3));
    const v = hashSeed(100, 3);
    assert.ok(v >= 0 && v <= 0xffffffff && Number.isInteger(v));
  });

  it("i が違えば大抵違う値", () => {
    const set = new Set<number>();
    for (let i = 0; i < 1000; i++) set.add(hashSeed(555, i));
    assert.ok(set.size > 990, `衝突が多すぎる (unique=${set.size})`);
  });
});
