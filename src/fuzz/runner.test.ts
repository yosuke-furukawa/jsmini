import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEngines, detectDivergence } from "./runner.js";

function keys(src: string) {
  const results = runEngines(src);
  return { results, div: detectDivergence(src, results) };
}

describe("runEngines - 全エンジン一致", () => {
  it("単純な算術は 3 エンジン一致で差分なし", () => {
    const { results, div } = keys("let s=0; for(let i=0;i<10;i++){ s = s + i; } s;");
    assert.equal(results.length, 3);
    assert.equal(div, null);
  });

  it("throw も 3 エンジンで一致", () => {
    const { div } = keys("throw new TypeError('x');");
    assert.equal(div, null);
  });

  it("console.log の副作用も一致すれば差分なし", () => {
    const { div } = keys("console.log(1, 'a'); console.log(true); 0;");
    assert.equal(div, null);
  });

  it("ReferenceError (未定義変数) も一致", () => {
    const { div } = keys("undefinedVarXYZ;");
    assert.equal(div, null);
  });

  it("オブジェクト/配列を返しても一致", () => {
    const { div } = keys("let o = { a: 1, b: [2, 3] }; o;");
    assert.equal(div, null);
  });
});

describe("detectDivergence - 差分検出ロジック", () => {
  it("エンジン間でキーが割れれば divergence", () => {
    const fake = [
      { engine: "TW" as const, ok: true as const, outcome: { kind: "value" as const, repr: "1", logs: [] } },
      { engine: "VM" as const, ok: true as const, outcome: { kind: "value" as const, repr: "2", logs: [] } },
      { engine: "JIT" as const, ok: true as const, outcome: { kind: "value" as const, repr: "1", logs: [] } },
    ];
    const div = detectDivergence("src", fake);
    assert.ok(div);
    assert.equal(div!.keys.VM, "V:2");
  });

  it("ok が 1 つ以下なら判定不能 (null)", () => {
    const fake = [
      { engine: "TW" as const, ok: true as const, outcome: { kind: "value" as const, repr: "1", logs: [] } },
      { engine: "VM" as const, ok: false as const, skip: "steplimit" },
      { engine: "JIT" as const, ok: false as const, skip: "steplimit" },
    ];
    assert.equal(detectDivergence("src", fake), null);
  });

  it("skip があっても ok 同士が一致なら差分なし", () => {
    const fake = [
      { engine: "TW" as const, ok: true as const, outcome: { kind: "value" as const, repr: "7", logs: [] } },
      { engine: "VM" as const, ok: true as const, outcome: { kind: "value" as const, repr: "7", logs: [] } },
      { engine: "JIT" as const, ok: false as const, skip: "steplimit" },
    ];
    assert.equal(detectDivergence("src", fake), null);
  });
});
