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

describe("Phase 28 — RegExp literal & RegExp ctor", () => {
  bothModes("literal test", `/abc/i.test("ABC");`, v => assert.equal(v, true));

  bothModes("literal exec match[0]", `/\\d+/.exec("foo 42 bar")[0];`, v => assert.equal(unwrap(v), "42"));

  bothModes("flag access", `/abc/gi.flags;`, v => assert.equal(unwrap(v), "gi"));

  bothModes("source access", `/abc/i.source;`, v => assert.equal(unwrap(v), "abc"));

  bothModes("instanceof RegExp", `/foo/ instanceof RegExp;`, v => assert.equal(v, true));

  bothModes("new RegExp(string)", `new RegExp("\\\\d+").test("abc 5");`, v => assert.equal(v, true));

  bothModes("new RegExp(string, flags)", `new RegExp("foo", "i").test("FOO");`, v => assert.equal(v, true));

  bothModes("character class", `/[a-z]+/.test("Hello");`, v => assert.equal(v, true));

  bothModes("escaped slash", `/a\\/b/.test("a/b");`, v => assert.equal(v, true));

  bothModes("regex inside conditional", `var x = true ? /foo/ : /bar/; x.test("foo");`, v => assert.equal(v, true));
});

describe("Phase 28 — String.prototype with RegExp", () => {
  bothModes("match returns array", `"a1b2c3".match(/\\d/g).length;`, v => assert.equal(v, 3));

  bothModes("match no flags returns first", `"hello world".match(/o/)[0];`, v => assert.equal(unwrap(v), "o"));

  bothModes("match no match returns null", `"abc".match(/\\d/);`, v => assert.equal(v, null));

  bothModes("replace global with string", `"hello".replace(/l/g, "L");`, v => assert.equal(unwrap(v), "heLLo"));

  bothModes("replace single with string", `"hello".replace(/l/, "L");`, v => assert.equal(unwrap(v), "heLlo"));

  bothModes("replace callback uppercase", `"hello".replace(/l/g, function(m) { return m.toUpperCase(); });`,
    v => assert.equal(unwrap(v), "heLLo"));

  bothModes("replace arrow callback", `"hello".replace(/l/g, m => m.toUpperCase());`,
    v => assert.equal(unwrap(v), "heLLo"));

  bothModes("search returns index", `"abc def".search(/\\s/);`, v => assert.equal(v, 3));

  bothModes("search not found returns -1", `"abc".search(/\\d/);`, v => assert.equal(v, -1));

  bothModes("split with regex", `"a, b ,c".split(/\\s*,\\s*/).length;`, v => assert.equal(v, 3));

  bothModes("string ctor + RegExp method", `var s = "AbCdE"; s.match(/[A-Z]/g).length;`, v => assert.equal(v, 3));
});

describe("Phase 28 — Lexer context", () => {
  bothModes("after assign is regex", `var r = /abc/; r.test("abc");`, v => assert.equal(v, true));

  bothModes("after Identifier is division", `var a = 10; var b = 5; a / b;`, v => assert.equal(v, 2));

  bothModes("after return is regex", `(function(){ return /a/; })().test("a");`, v => assert.equal(v, true));

  bothModes("after typeof is division (typeof returns string)", `typeof 1;`, v => assert.equal(unwrap(v), "number"));
});
