import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSeqString,
  emptyJSString,
  isJSString,
  jsStringConcat,
  jsStringSlice,
  jsStringEquals,
  jsStringCharAt,
  jsStringToString,
  flatten,
  numberToJSString,
  booleanToJSString,
  jsStringToNumber,
} from "./js-string.js";

describe("JSString", () => {
  describe("createSeqString", () => {
    it("文字列を SeqString に変換", () => {
      const s = createSeqString("hello");
      assert.equal(s.kind, "seq");
      assert.equal(s.length, 5);
      assert.equal(jsStringToString(s), "hello");
    });

    it("空文字列", () => {
      const s = createSeqString("");
      assert.equal(s.length, 0);
      assert.equal(jsStringToString(s), "");
    });

    it("isJSString", () => {
      assert.ok(isJSString(createSeqString("hello")));
      assert.ok(!isJSString("hello"));
      assert.ok(!isJSString(42));
      assert.ok(!isJSString(null));
    });
  });

  describe("jsStringConcat", () => {
    it("短い文字列の連結 → SeqString (コピー)", () => {
      const a = createSeqString("hello");
      const b = createSeqString(" world");
      const c = jsStringConcat(a, b);
      assert.equal(jsStringToString(c), "hello world");
      assert.equal(c.length, 11);
      assert.equal(c.kind, "seq"); // 11 < 13 なのでフラット
    });

    it("長い文字列の連結 → ConsString (コピーなし)", () => {
      const a = createSeqString("hello world ");
      const b = createSeqString("this is long");
      const c = jsStringConcat(a, b);
      assert.equal(c.kind, "cons"); // 24 >= 13 なので ConsString
      assert.equal(c.length, 24);
      assert.equal(jsStringToString(c), "hello world this is long");
    });

    it("空文字列との連結", () => {
      const a = createSeqString("hello");
      const empty = emptyJSString();
      assert.equal(jsStringConcat(a, empty), a);
      assert.equal(jsStringConcat(empty, a), a);
    });

    it("ConsString の連鎖", () => {
      let s = createSeqString("a");
      for (let i = 0; i < 20; i++) {
        s = jsStringConcat(s, createSeqString("b"));
      }
      assert.equal(s.length, 21);
      assert.equal(jsStringToString(s), "a" + "b".repeat(20));
    });
  });

  describe("jsStringSlice", () => {
    it("部分文字列", () => {
      const s = createSeqString("hello world");
      const sliced = jsStringSlice(s, 6, 11);
      assert.equal(jsStringToString(sliced), "world");
    });

    it("短い slice → SeqString", () => {
      const s = createSeqString("hello world");
      const sliced = jsStringSlice(s, 0, 5);
      assert.equal(sliced.kind, "seq");
      assert.equal(jsStringToString(sliced), "hello");
    });

    it("全体の slice → 元を返す", () => {
      const s = createSeqString("hello");
      assert.equal(jsStringSlice(s, 0, 5), s);
    });
  });

  describe("flatten", () => {
    it("ConsString を flatten", () => {
      const a = createSeqString("hello world ");
      const b = createSeqString("this is long");
      const cons = jsStringConcat(a, b);
      assert.equal(cons.kind, "cons");
      const flat = flatten(cons);
      assert.equal(flat.kind, "seq");
      assert.equal(flat.length, 24);
    });
  });

  describe("jsStringEquals", () => {
    it("同じ内容は等しい", () => {
      assert.ok(jsStringEquals(createSeqString("hello"), createSeqString("hello")));
    });

    it("異なる内容は不一致", () => {
      assert.ok(!jsStringEquals(createSeqString("hello"), createSeqString("world")));
    });

    it("長さが異なれば不一致", () => {
      assert.ok(!jsStringEquals(createSeqString("hi"), createSeqString("hello")));
    });

    it("同じ参照は等しい", () => {
      const s = createSeqString("hello");
      assert.ok(jsStringEquals(s, s));
    });

    it("ConsString と SeqString の比較", () => {
      const a = jsStringConcat(createSeqString("hello world "), createSeqString("this is long"));
      const b = createSeqString("hello world this is long");
      assert.ok(jsStringEquals(a, b));
    });
  });

  describe("jsStringCharAt", () => {
    it("指定位置の文字を返す", () => {
      const s = createSeqString("hello");
      assert.equal(jsStringToString(jsStringCharAt(s, 0)), "h");
      assert.equal(jsStringToString(jsStringCharAt(s, 4)), "o");
    });

    it("範囲外は空文字列", () => {
      const s = createSeqString("hi");
      assert.equal(jsStringCharAt(s, -1).length, 0);
      assert.equal(jsStringCharAt(s, 2).length, 0);
    });
  });

  describe("型変換", () => {
    it("numberToJSString", () => {
      assert.equal(jsStringToString(numberToJSString(42)), "42");
      assert.equal(jsStringToString(numberToJSString(3.14)), "3.14");
    });

    it("booleanToJSString", () => {
      assert.equal(jsStringToString(booleanToJSString(true)), "true");
      assert.equal(jsStringToString(booleanToJSString(false)), "false");
    });

    it("jsStringToNumber", () => {
      assert.equal(jsStringToNumber(createSeqString("42")), 42);
      assert.ok(isNaN(jsStringToNumber(createSeqString("hello"))));
    });
  });
});
