import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

// Phase 51: 分割代入の Iterator Protocol (ユーザー定義 @@iterator / IteratorClose)。
// IteratorClose (return() 呼び出し) と Symbol.iterator getter は VM 未対応のため
// TW のみ検証 (PLAN-v9 項目 J)

const engines: { name: string; run: (src: string) => unknown }[] = [
  { name: "TW", run: (src) => evaluate(src) },
  { name: "VM", run: (src) => vmEvaluate(src) },
];

for (const { name, run } of engines) {
  const eq = (src: string, want: unknown) => assert.equal(run(src), want, src);
  const twOnly = name === "TW";

  describe(`分割代入の Iterator Protocol (${name})`, () => {
    it("ユーザー定義 @@iterator (jsmini 関数) で反復できる (rest 含む)", () => {
      eq(`var it = { [Symbol.iterator]: function() { var i = 0; return { next: function() {
            return i < 3 ? { value: i++, done: false } : { value: undefined, done: true }; } }; } };
          var [a, b, ...r] = it; a * 100 + b * 10 + r[0];`, 12);
    });

    it("@@iterator が throw する / 非イテラブルは呼び出し元に届く", () => {
      eq(`function E(){} var it = {}; it[Symbol.iterator] = function() { throw new E(); };
          var r = "no", _; try { [ _ ] = it; } catch (e) { r = e instanceof E ? "E" : "other"; } r === "E";`, true);
      assert.throws(() => run(`var [a] = {};`), TypeError);
    });

    it("next() の throw は return() を呼ばずに伝播 (spec: abrupt next は close しない)", () => {
      eq(`function E(){} var closed = 0; var it = { [Symbol.iterator]: function() { return {
            next: function() { throw new E(); }, return: function() { closed++; return {}; } }; } };
          var r = "no"; try { var [a] = it; } catch (e) { r = e instanceof E ? "E" : "other"; } r + closed;`, "E0");
    });

    it("従来パス (配列・elision・文字列・generator・Set) は変わらない", () => {
      eq(`var [a, , c] = [1, 2, 3]; a + c;`, 4);
      eq(`var [a, b] = "xy"; a === "x" && b === "y";`, true);
      eq(`function* g() { yield 1; yield 2; } var [a, b] = g(); a + b;`, 3);
      eq(`var [a, b] = new Set([5, 6]); a + b;`, 11);
    });

    it("IteratorClose: 途中終了で return() を呼び、使い切ったら呼ばない (TW)", () => {
      if (!twOnly) return;
      eq(`var closed = 0; var it = { [Symbol.iterator]: function() { return {
            next: function() { return { value: 1, done: false }; }, return: function() { closed++; return {}; } }; } };
          var [a] = it; closed;`, 1);
      eq(`var closed = 0; var it = { [Symbol.iterator]: function() { var i = 0; return {
            next: function() { return i++ < 1 ? { value: 1, done: false } : { done: true }; }, return: function() { closed++; return {}; } }; } };
          var [a, b] = it; closed;`, 0);
    });

    it("IteratorClose: 束縛中の throw では return() の例外を握りつぶし元の例外を優先 / 正常完了時の非オブジェクト結果は TypeError (TW)", () => {
      if (!twOnly) return;
      eq(`function E(){} var closed = 0; var it = { [Symbol.iterator]: function() { return {
            next: function() { return { value: undefined, done: false }; },
            return: function() { closed++; throw new Error("ignored"); } }; } };
          var r = "no"; try { var [a = (function(){ throw new E(); })()] = it; } catch (e) { r = e instanceof E ? "E" : "other"; } r + closed;`, "E1");
      eq(`var it = { [Symbol.iterator]: function() { return { next: function() { return { value: 1, done: false }; }, return: function() { return null; } }; } };
          var r = "no"; try { var [a] = it; } catch (e) { r = e.constructor.name; } r;`, "TypeError");
    });

    it("Symbol.iterator の getter が throw → 伝播 (TW)", () => {
      if (!twOnly) return;
      eq(`function E(){} var it = {}; Object.defineProperty(it, Symbol.iterator, { get: function() { throw new E(); } });
          var r = "no"; try { var [x] = it; } catch (e) { r = e instanceof E ? "E" : "other"; } r === "E";`, true);
    });
  });
}
