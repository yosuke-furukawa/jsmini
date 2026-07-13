import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonValue, canonThrow, outcomeKey } from "./normalize.js";
import { internString, createSeqString } from "../vm/js-string.js";
import { ThrowSignal } from "../interpreter/values.js";

describe("canonValue - プリミティブ", () => {
  it("特殊な数値を区別する", () => {
    assert.equal(canonValue(NaN), "NaN");
    assert.equal(canonValue(Infinity), "Infinity");
    assert.equal(canonValue(-Infinity), "-Infinity");
    assert.equal(canonValue(-0), "-0");
    assert.equal(canonValue(0), "0");
    assert.equal(canonValue(42), "42");
  });

  it("null / undefined / bool", () => {
    assert.equal(canonValue(null), "null");
    assert.equal(canonValue(undefined), "undefined");
    assert.equal(canonValue(true), "true");
    assert.equal(canonValue(false), "false");
  });

  it("string と bigint", () => {
    assert.equal(canonValue("abc"), '"abc"');
    assert.equal(canonValue(10n), "10n");
  });
});

describe("canonValue - JSString は host string と同一表現", () => {
  it("intern した JSString", () => {
    assert.equal(canonValue(internString("hi")), '"hi"');
  });
  it("seq (非 intern) の JSString も同じ表現", () => {
    const seq = createSeqString("hello");
    assert.equal(canonValue(seq), '"hello"');
    assert.equal(canonValue(seq), canonValue("hello"));
  });
});

describe("canonValue - オブジェクト正規化", () => {
  it("VM の内部キー (__hc__ 等) を無視する", () => {
    const twLike = { a: 1, b: 2 };
    const vmLike = { __hc__: { id: 3 }, __slots__: [1, 2], __proto__: {}, a: 1, b: 2 };
    assert.equal(canonValue(twLike), canonValue(vmLike));
  });

  it("キー順に依らず安定", () => {
    assert.equal(canonValue({ a: 1, b: 2 }), canonValue({ b: 2, a: 1 }));
  });

  it("ネストした配列/オブジェクト", () => {
    assert.equal(canonValue({ x: [1, 2], y: { z: 3 } }), '{"x":[1,2],"y":{"z":3}}');
  });

  it("循環参照でも落ちない", () => {
    const o: any = { a: 1 };
    o.self = o;
    assert.ok(canonValue(o).includes("circular"));
  });
});

describe("canonValue - 関数は種別に依らず [Function]", () => {
  it("closure 風と bytecode 風を同一視", () => {
    const twFn = { name: "f", params: [], body: {}, closure: {} };
    const vmFn = { name: "f", bytecode: [], constants: [] };
    assert.equal(canonValue(twFn), "[Function]");
    assert.equal(canonValue(vmFn), "[Function]");
    assert.equal(canonValue(() => 1), "[Function]");
  });
});

describe("canonThrow - throw 正規化", () => {
  it("host error は種別で表現", () => {
    assert.equal(canonThrow(new TypeError("x")), "Error:TypeError");
    assert.equal(canonThrow(new ReferenceError("y")), "Error:ReferenceError");
  });

  it("TW の ThrowSignal を unwrap する", () => {
    assert.equal(canonThrow(new ThrowSignal(new RangeError("z"))), "Error:RangeError");
  });

  it("VM の生 error 値と TW の ThrowSignal(error) が一致する", () => {
    const raw = new TypeError("boom");
    assert.equal(canonThrow(raw), canonThrow(new ThrowSignal(new TypeError("boom"))));
  });

  it("エラー以外の throw は値で表現 (message には依存しない)", () => {
    assert.equal(canonThrow(new ThrowSignal(5)), "value:5");
    assert.equal(canonThrow("plain"), 'value:"plain"');
  });
});

describe("outcomeKey - 完了値 + ログ副作用", () => {
  it("value と throw を区別", () => {
    assert.notEqual(
      outcomeKey({ kind: "value", repr: "1", logs: [] }),
      outcomeKey({ kind: "throw", repr: "1", logs: [] }),
    );
  });
  it("ログが違えば別キー", () => {
    assert.notEqual(
      outcomeKey({ kind: "value", repr: "1", logs: ['"a"'] }),
      outcomeKey({ kind: "value", repr: "1", logs: ['"b"'] }),
    );
  });
});
