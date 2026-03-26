import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vmEvaluate } from "./index.js";
import { compile } from "./compiler.js";
import { disassemble } from "./bytecode.js";

describe("VM - Step 4-1: パイプライン貫通 (リテラル + 算術)", () => {
  it("数値リテラルを評価できる", () => {
    assert.equal(vmEvaluate("42;"), 42);
  });

  it("加算を評価できる", () => {
    assert.equal(vmEvaluate("1 + 2;"), 3);
  });

  it("減算を評価できる", () => {
    assert.equal(vmEvaluate("10 - 3;"), 7);
  });

  it("乗算を評価できる", () => {
    assert.equal(vmEvaluate("3 * 4;"), 12);
  });

  it("除算を評価できる", () => {
    assert.equal(vmEvaluate("10 / 2;"), 5);
  });

  it("剰余を評価できる", () => {
    assert.equal(vmEvaluate("10 % 3;"), 1);
  });

  it("演算子優先順位が正しい", () => {
    assert.equal(vmEvaluate("1 + 2 * 3;"), 7);
  });

  it("括弧によるグループ化が正しい", () => {
    assert.equal(vmEvaluate("(1 + 2) * 3;"), 9);
  });

  it("複数の演算を組み合わせられる", () => {
    assert.equal(vmEvaluate("2 + 3 * 4 - 1;"), 13);
  });

  it("複数の文がある場合、最後の文の値を返す", () => {
    assert.equal(vmEvaluate("1 + 2; 3 + 4;"), 7);
  });

  it("単項マイナスが動く", () => {
    assert.equal(vmEvaluate("-5;"), -5);
  });

  it("真偽値リテラルが動く", () => {
    assert.equal(vmEvaluate("true;"), true);
    assert.equal(vmEvaluate("false;"), false);
  });

  it("null リテラルが動く", () => {
    assert.equal(vmEvaluate("null;"), null);
  });

  it("比較演算が動く", () => {
    assert.equal(vmEvaluate("1 < 2;"), true);
    assert.equal(vmEvaluate("2 > 1;"), true);
    assert.equal(vmEvaluate("1 === 1;"), true);
    assert.equal(vmEvaluate("1 !== 2;"), true);
  });

  it("論理 NOT が動く", () => {
    assert.equal(vmEvaluate("!true;"), false);
    assert.equal(vmEvaluate("!false;"), true);
  });
});

describe("VM - disassemble", () => {
  it("バイトコードをダンプできる", () => {
    const func = compile("1 + 2 * 3;");
    const output = disassemble(func);
    assert.ok(output.includes("LdaConst"));
    assert.ok(output.includes("Mul"));
    assert.ok(output.includes("Add"));
  });
});
