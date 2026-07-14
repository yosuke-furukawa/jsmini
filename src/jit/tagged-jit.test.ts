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

describe("Phase 33 — ネストアクセス (__load_slot import)", () => {
  it("2 段ネスト読み (this.cur.link.id)", () => {
    jitEq(`
      function P(o) { this.cur = o; }
      P.prototype.deepId = function() { if (this.cur != null && this.cur.link != null) return this.cur.link.id; return -1; };
      var o = { link: { id: 99, link: null }, id: 1 };
      var p = new P(o);
      var r = 0;
      for (var i = 0; i < 20; i++) { r = p.deepId(); }
      r;
    `, 99);
  });

  it("ネスト値同士の identity 比較", () => {
    jitEq(`
      function Q(a, b) { this.a = a; this.b = b; }
      Q.prototype.sameTarget = function() { return this.a.target == this.b.target ? 1 : 0; };
      var shared = { v: 1 };
      var q1 = new Q({ target: shared }, { target: shared });
      var q2 = new Q({ target: shared }, { target: { v: 1 } });
      var r = 0;
      for (var i = 0; i < 20; i++) { r = q1.sameTarget() * 10 + q2.sameTarget(); }
      r;
    `, 10);
  });

  it("prototype 上のプロパティは deopt して正しい", () => {
    jitEq(`
      function R(o) { this.cur = o; }
      R.prototype.f = function() { return this.cur.onProto == null ? 0 : 1; };
      function Base() {}
      Base.prototype.onProto = { x: 1 };
      var r = new R(new Base());
      var v = 0;
      for (var i = 0; i < 20; i++) { v = r.f(); }
      v;
    `, 1, false); // own に無い → __load_slot が deopt → VM で正しい
  });
});

describe("Phase 33-6 — tagged × f64 共存と保全", () => {
  it("token-ring (参照 move + identity + null チェックのホットループ) が JIT される", () => {
    // 594x の看板ケース。ループカウンタの f64 昇格と tagged が共存すること
    const src = `
      function Ring(a, b, c) { this.s0 = a; this.s1 = b; this.s2 = c; this.s3 = null; this.marker = b; }
      Ring.prototype.spin = function(n) {
        var hits = 0;
        for (var i = 0; i < n; i++) {
          this.s3 = this.s2; this.s2 = this.s1; this.s1 = this.s0; this.s0 = this.s3;
          if (this.s1 == this.marker) hits = hits + 1;
          if (this.s3 != null) { this.s3 = null; }
        }
        return hits;
      };
      var r = new Ring({id:1}, {id:2}, {id:3});
      var total = 0;
      for (var k = 0; k < 10; k++) { total = r.spin(100); }
      total;
    `;
    const plain = vmEvaluate(src);
    const r = vmEvaluate(src, { jit: true, jitThreshold: 3, useIR: true, traceTier: true }) as { value: unknown; tierLog?: string[] };
    assert.equal(r.value, plain);
    assert.ok((r.tierLog ?? []).some(l => /Wasm compiled/.test(l)), "token-ring should JIT-compile");
  });

  it("非 tagged 関数の undefined-phi の truthiness が壊れない", () => {
    // emitValueOrConst の null/undefined タグ化は tagged Phi 限定であること
    // (無条件だと undefined が 3 = truthy になり if(x) が壊れる)
    const src = `
      function f(c, n) {
        var x;
        if (c) { x = 5; }
        var hit = 0;
        for (var i = 0; i < n; i++) { if (x) { hit = hit + 1; } }
        return hit;
      }
      var r = 0;
      for (var k = 0; k < 10; k++) { r = f(0, 10) * 100 + f(1, 10); }
      r;
    `;
    const plain = vmEvaluate(src);
    const jit = vmEvaluate(src, { jit: true, jitThreshold: 3, useIR: true });
    assert.equal(jit, plain);
    assert.equal(jit, 10); // f(0,·)=0, f(1,·)=10
  });
});
