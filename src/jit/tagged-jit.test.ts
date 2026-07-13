import { describe, it } from "node:test";
import assert from "node:assert";
import { vmEvaluate } from "../vm/index.js";

// Phase 33: tagged slots (V8 Smi 流 1bit タグ + object table) の回帰テスト。
// 参照/null/undefined を持つ this プロパティのメソッドが JIT 圏内に入る

function jitEq(src: string, expected: unknown, expectWasm = true) {
  const plain = vmEvaluate(src);
  const r = vmEvaluate(src, { jit: true, jitThreshold: 3, useIR: true, traceTier: true }) as { value: unknown; tierLog?: string[] };
  assert.deepEqual(r.value, plain);
  assert.equal(r.value, expected);
  if (expectWasm) {
    assert.ok((r.tierLog ?? []).some(l => /Wasm compiled/.test(l)), "should JIT-compile");
  }
}

describe("Phase 33 — tagged slots", () => {
  it("truthiness: !this.root_ (null/object)", () => {
    jitEq(`
      function T() { this.root_ = null; this.n = 0; }
      T.prototype.isEmpty = function() { return !this.root_; };
      var t1 = new T(); var t2 = new T(); t2.root_ = { v: 1 };
      var c = 0;
      for (var i = 0; i < 30; i++) { if (t1.isEmpty()) c++; if (t2.isEmpty()) c += 100; }
      c;
    `, 30);
  });

  it("参照の identity 比較と null 比較", () => {
    jitEq(`
      function S() { this.cur = null; this.marker = null; }
      S.prototype.check = function() {
        if (this.cur != null && this.cur == this.marker) return 2;
        if (this.cur != null) return 1;
        return 0;
      };
      var s = new S(); var o1 = {a:1}, o2 = {b:2};
      var r = 0;
      for (var i = 0; i < 30; i++) {
        s.cur = null; r = r * 10 % 1000 + s.check();
        s.cur = o1; s.marker = o2; r = r * 10 % 1000 + s.check();
        s.marker = o1; r = r * 10 % 1000 + s.check();
      }
      r;
    `, 12);
  });

  it("参照の move (this.a = this.b) と write-back", () => {
    jitEq(`
      function P() { this.head = { id: 7 }; this.cur = null; }
      P.prototype.advance = function() { this.cur = this.head; this.head = null; };
      var p = new P();
      for (var i = 0; i < 20; i++) { p.advance(); if (i < 19) { p.head = p.cur; p.cur = null; } }
      p.cur === null ? -1 : p.cur.id;
    `, 7);
  });

  it("参照の return (resultTagged デコード)", () => {
    jitEq(`
      function Q() { this.item = { size: 42 }; }
      Q.prototype.take = function() { return this.item; };
      var q = new Q();
      var got = null;
      for (var i = 0; i < 20; i++) { got = q.take(); }
      got.size;
    `, 42);
  });

  it("=== null と == null が undefined を区別する", () => {
    jitEq(`
      function U() { this.v = undefined; }
      U.prototype.f = function() {
        var a = this.v == null ? 1 : 0;
        var b = this.v === null ? 10 : 0;
        return a + b;
      };
      var u = new U();
      var r = 0;
      for (var i = 0; i < 20; i++) { r = u.f(); }
      u.v = null;
      var r2 = u.f();
      r * 100 + r2;
    `, 111);
  });

  it("数値も tagged で正しい (30bit Smi、0 の falsy 含む)", () => {
    jitEq(`
      function N() { this.v = 0; }
      N.prototype.f = function() { return this.v ? 1 : 0; };
      var n = new N();
      var r = 0;
      for (var i = 0; i < 20; i++) { r = n.f(); }
      n.v = 5;
      r * 10 + n.f();
    `, 1);
  });

  it("f64 が要る混在関数は VM フォールバックで正しい (v1 制約)", () => {
    // 算術で f64 モードになる関数は tagged 無効 → VM で正しく実行される
    jitEq(`
      function M() { this.link = null; this.count = 0; }
      M.prototype.step = function() { this.count = this.count + 1; if (this.link == null) return 0; return 1; };
      var m = new M();
      var s = 0;
      for (var i = 0; i < 30; i++) { s += m.step(); if (i === 10) m.link = {x:1}; }
      s * 1000 + m.count;
    `, 19030, false);
  });
});
