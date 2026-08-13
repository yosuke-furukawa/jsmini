import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

// Phase 46: RegExp exec/match 結果の index/input/groups と JSString intern 同一性

const engines: { name: string; run: (src: string) => unknown }[] = [
  { name: "TW", run: (src) => evaluate(src) },
  { name: "VM", run: (src) => vmEvaluate(src) },
];

for (const { name, run } of engines) {
  const isTrue = (src: string) => assert.equal(run(src), true, src);

  describe(`RegExp 結果の整形 (${name})`, () => {
    it("exec の要素・index・input が intern された文字列と一致", () => {
      isTrue(`var r = /b(c)/.exec("abcd"); r[0] === "bc" && r[1] === "c";`);
      isTrue(`var r = /b(c)/.exec("abcd"); r.index === 1 && r.input === "abcd";`);
      isTrue(`var r = /[a-c\\d]+/.exec("\\n\\nabc324234\\n"); r.index === 2 && r[0] === "abc324234";`);
    });

    it("named groups が intern される (groups なしは undefined)", () => {
      isTrue(`var r = /(?<x>b)(?<y>c)/.exec("abcd"); r.groups.x === "b" && r.groups.y === "c";`);
      isTrue(`var r = /bc/.exec("abcd"); r.groups === undefined;`);
    });

    it("マッチしない場合は null / 不参加グループは undefined", () => {
      isTrue(`/z/.exec("abcd") === null;`);
      isTrue(`var r = /a(b)?/.exec("ac"); r[1] === undefined;`);
    });

    it("match (g なし) は exec 相当の index/input を持つ", () => {
      isTrue(`var m = "abcd".match(/b(c)/); m[0] === "bc" && m[1] === "c" && m.index === 1 && m.input === "abcd";`);
    });

    it("match (g あり) は全マッチの intern 配列", () => {
      isTrue(`var m = "aXbX".match(/X/g); m.length === 2 && m[0] === "X" && m[1] === "X";`);
    });

    it("host 内部の replace/split は壊れない", () => {
      isTrue(`"aXbX".replace(/X/g, "-") === "a-b-";`);
      isTrue(`"a,b".split(",")[1] === "b";`);
      isTrue(`"aXbY".replace(/[XY]/g, function(m) { return m === "X" ? "1" : "2"; }) === "a1b2";`);
    });
  });
}
