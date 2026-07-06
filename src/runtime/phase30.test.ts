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

// Octane が炙り出した言語コアのバグの回帰テスト (Phase 30)

describe("Phase 30 — new の callee member チェーン (B2, splay)", () => {
  bothModes("new T.Node(5)", `
    function T() {}
    T.Node = function(k) { this.k = k; };
    var n = new T.Node(5); n.k;
  `, v => assert.equal(v, 5));

  bothModes("new obj[key]()", `
    var ns = {};
    ns.C = function() { this.v = 9; };
    var n = new ns["C"](); n.v;
  `, v => assert.equal(v, 9));
});

describe("Phase 30 — Object.prototype 経由の関数プロパティ (B3, deltablue)", () => {
  // deltablue の inheritsFrom パターン
  bothModes("defineProperty(Object.prototype) を関数から参照", `
    Object.defineProperty(Object.prototype, "__p30_inh", { value: function(shuper) {
      function I() {}
      I.prototype = shuper.prototype;
      this.prototype = new I();
      this.superConstructor = shuper;
    }});
    function Base(s) { this.s = s; }
    Base.prototype.tag = function() { return this.s * 2; };
    function Sub(s) { Sub.superConstructor.call(this, s + 1); }
    Sub.__p30_inh(Base);
    var x = new Sub(20);
    var r = x.tag();
    delete Object.prototype.__p30_inh;
    r;
  `, v => assert.equal(v, 42));

  bothModes("defineProperty(Object.prototype) は for-in を汚染しない", `
    Object.defineProperty(Object.prototype, "__p30_zzz", { value: 1 });
    var o = { a: 1 };
    var n = 0; for (var k in o) n++;
    delete Object.prototype.__p30_zzz;
    n;
  `, v => assert.equal(v, 1));
});

describe("Phase 30 — member への ++/-- (B1, richards/deltablue)", () => {
  bothModes("prefix ++this.prop", `
    function C() { this.n = 0; }
    C.prototype.next = function() { return ++this.n; };
    var c = new C(); c.next(); c.next();
  `, v => assert.equal(v, 2));

  bothModes("postfix this.prop++", `
    function C() { this.n = 10; }
    C.prototype.take = function() { return this.n++; };
    var c = new C(); c.take();
    c.take() * 100 + c.n;
  `, v => assert.equal(v, 1112));

  bothModes("computed a[i]++", `
    var a = [1, 2, 3]; var i = 1;
    var r = a[i]++;
    r * 100 + a[1];
  `, v => assert.equal(v, 203));

  bothModes("トップレベルの ++obj.prop", `
    var o = { n: 5 };
    var r = ++o.n;
    r * 100 + o.n;
  `, v => assert.equal(v, 606));

  bothModes("obj.prop-- と --obj.prop", `
    var o = { n: 5 }; o.n--; --o.n; o.n;
  `, v => assert.equal(v, 3));

  bothModes("statement 位置の this.prop++ がスタックを壊さない", `
    function C() { this.count = 0; }
    C.prototype.bump = function() { this.count++; this.count++; return "x"; };
    var c = new C();
    var s = 0;
    for (var i = 0; i < 10; i++) { c.bump(); s = s + 1; }
    s * 1000 + c.count;
  `, v => assert.equal(v, 10020));
});

describe("Phase 30 — オブジェクト同士の == は参照比較 (deltablue)", () => {
  bothModes("別オブジェクト == は false", `({a:1}) == ({b:2});`, v => assert.equal(v, false));
  bothModes("同一オブジェクト == は true", `var o = {a:1}; o == o;`, v => assert.equal(v, true));
  bothModes("別オブジェクト != は true", `({a:1}) != ({b:2});`, v => assert.equal(v, true));
  bothModes("ToPrimitive は片辺 primitive のときだけ", `
    var o = { valueOf: function() { return 5; } };
    (o == 5) && (5 == o);
  `, v => assert.equal(v, true));
});

describe("Phase 30 — 後方宣言 var のクロージャ捕獲 (B4, navier-stokes)", () => {
  bothModes("クロージャがソース上で後方の var を参照", `
    function F() {
      this.get = function() { return x[0]; };
      var x;
      function reset() { x = new Array(1); x[0] = 5; }
      this.reset = reset;
    }
    var f = new F(); f.reset(); f.get();
  `, v => assert.equal(v, 5));

  bothModes("後方 var の単純読み", `
    function F() {
      this.get = function() { return y; };
      var y = 33;
    }
    var f = new F(); f.get();
  `, v => assert.equal(v, 33));

  bothModes("for ループ内 var も hoist される", `
    function F() {
      this.get = function() { return i; };
      for (var i = 0; i < 3; i++) {}
    }
    var f = new F(); f.get();
  `, v => assert.equal(v, 3));
});
