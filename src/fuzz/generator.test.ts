import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generate } from "./generator.js";
import { parse } from "../parser/parser.js";
import { hashSeed } from "./prng.js";

describe("generate - 決定性", () => {
  it("同じ seed は同じプログラム", () => {
    for (const s of [1, 42, 1000, 999999]) {
      assert.equal(generate(s), generate(s));
    }
  });
  it("違う seed は (ほぼ) 違うプログラム", () => {
    const set = new Set<string>();
    for (let i = 0; i < 200; i++) set.add(generate(hashSeed(0, i)));
    assert.ok(set.size > 190, `多様性が低い (unique=${set.size})`);
  });
});

describe("generate - 構文的に妥当 (jsmini parser を通る)", () => {
  it("500 seed すべて SyntaxError なくパースできる", () => {
    const failures: { seed: number; err: string }[] = [];
    for (let i = 0; i < 500; i++) {
      const seed = hashSeed(12345, i);
      const src = generate(seed);
      try {
        parse(src);
      } catch (e: any) {
        failures.push({ seed, err: String(e?.message ?? e) });
      }
    }
    assert.deepEqual(
      failures.slice(0, 5),
      [],
      `パース失敗 ${failures.length}/500 例: ${JSON.stringify(failures.slice(0, 3))}`,
    );
  });
});

describe("generate - 有界性 (hang しない構造)", () => {
  it("while/do を含まない", () => {
    for (let i = 0; i < 200; i++) {
      const src = generate(hashSeed(7, i));
      assert.ok(!/\bwhile\b/.test(src), `while 混入: seed ${i}`);
      assert.ok(!/\bdo\b/.test(src), `do 混入: seed ${i}`);
    }
  });
  it("for ループの上限はリテラル (< 数値)", () => {
    for (let i = 0; i < 200; i++) {
      const src = generate(hashSeed(8, i));
      const forHeads = src.match(/for \([^)]*\)/g) ?? [];
      for (const h of forHeads) {
        assert.ok(/< \d+;/.test(h), `非リテラル上限: ${h}`);
      }
    }
  });
});
