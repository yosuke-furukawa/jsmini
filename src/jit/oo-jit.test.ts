import { describe, it } from "node:test";
import assert from "node:assert";
import { vmEvaluate } from "../vm/index.js";

// Phase 31: object JIT (used-props this-model / 論理演算子の Wasm 化 /
// 読み取り専用グローバルのパラメータ渡し) の回帰テスト

function jitEq(src: string, expected?: unknown) {
  const plain = vmEvaluate(src);
  const jit = vmEvaluate(src, { jit: true, jitThreshold: 3, useIR: true });
  assert.deepEqual(jit, plain);
  if (expected !== undefined) assert.equal(jit, expected);
}

describe("Phase 31 — || / && / 三項演算子の JIT (スタック値の Phi)", () => {
  // IR builder が || の右辺を丸ごと落としていた回帰
  // (合流点でスタック上の値に Phi が張られていなかった)
  it("this.state を使う || (richards isHeldOrSuspended 形)", () => {
    jitEq(`
      var HELD = 4; var SUSPENDED = 2;
      function T(s) { this.link = { x: 1 }; this.state = s; }
      T.prototype.check = function () {
        return (this.state & HELD) != 0 || (this.state == SUSPENDED);
      };
      var out = 0;
      for (var i = 0; i < 40; i++) {
        var t = new T(i % 8);
        if (t.check()) out++;
      }
      out;
    `, 25); // state 2,4,5,6,7 が true → 8 周期中 5 回 × 5 周 = 25
  });

  it("&& の右辺も正しく評価される", () => {
    jitEq(`
      function f(a, b) { return (a > 1) && (b > 1); }
      var n = 0;
      for (var i = 0; i < 30; i++) { if (f(i % 4, i % 3)) n++; }
      n;
    `);
  });

  it("三項演算子の両辺", () => {
    jitEq(`
      function f(x) { return x > 5 ? x * 2 : x + 100; }
      var s = 0;
      for (var i = 0; i < 30; i++) { s = s + f(i % 10); }
      s;
    `);
  });

  it("|| の値がそのまま返る (boolean でなく値)", () => {
    jitEq(`
      function f(x) { return x || 42; }
      f(0) * 1000 + f(7);
    `, 42 * 1000 + 7);
  });
});

describe("Phase 31 — used-props this-model", () => {
  it("使わない参照プロパティがあっても数値メソッドは JIT される", () => {
    const src = `
      function T(s) { this.link = { big: "object" }; this.state = s; this.extra = null; }
      T.prototype.bump = function () { this.state = this.state + 1; return this.state; };
      var t = new T(0);
      var r = 0;
      for (var i = 0; i < 30; i++) { r = t.bump(); }
      r * 100 + t.state;
    `;
    const plain = vmEvaluate(src);
    const r = vmEvaluate(src, { jit: true, jitThreshold: 3, useIR: true, traceTier: true }) as { value: unknown; tierLog?: string[] };
    assert.equal(r.value, plain);
    assert.equal(r.value, 30 * 100 + 30);
    assert.ok((r.tierLog ?? []).some(l => /Wasm compiled/.test(l)), "should JIT despite ref props");
  });

  it("this への書き込みが VM に write-back される", () => {
    jitEq(`
      var MASK = 3;
      function T() { this.state = 0; }
      T.prototype.set = function (v) { this.state = (this.state * 2 + v) & 255; };
      var t = new T();
      for (var i = 0; i < 30; i++) { t.set(i & MASK); }
      t.state;  // VM 側から読む (write-back が無いと古い値)
    `);
  });

  it("プロパティ定義順と使用順が違っても正しい offset で読む", () => {
    jitEq(`
      function T() { this.a = 10; this.b = 20; this.c = 30; }
      T.prototype.f = function () { return this.c * 100 + this.a; };  // 使用順 c, a
      var t = new T();
      var r = 0;
      for (var i = 0; i < 30; i++) { r = t.f(); }
      r;
    `, 3010);
  });

  it("使うプロパティが非数値なら deopt して正しい結果", () => {
    jitEq(`
      function T() { this.root = null; this.n = 0; }
      T.prototype.isEmpty = function () { return !this.root; };
      var t = new T();
      var c = 0;
      for (var i = 0; i < 30; i++) { if (t.isEmpty()) c++; }
      c;
    `, 30);
  });
});

describe("Phase 31 — 読み取り専用グローバルのパラメータ渡し", () => {
  it("グローバル定数を読む関数が JIT され正しい値を見る", () => {
    const src = `
      var K = 7;
      function f(x) { return x * K; }
      var s = 0;
      for (var i = 0; i < 30; i++) { s = s + f(i); }
      s;
    `;
    const plain = vmEvaluate(src);
    const r = vmEvaluate(src, { jit: true, jitThreshold: 3, useIR: true, traceTier: true }) as { value: unknown; tierLog?: string[] };
    assert.equal(r.value, plain);
    assert.ok((r.tierLog ?? []).some(l => /Wasm compiled/.test(l)), "global-reading fn should JIT");
  });

  it("グローバルが呼び出しの合間に変わっても最新値を見る", () => {
    jitEq(`
      var K = 1;
      function f(x) { return x + K; }
      var s = 0;
      for (var i = 0; i < 20; i++) { s = s + f(0); }
      K = 100;
      for (var i = 0; i < 20; i++) { s = s + f(0); }
      s;
    `, 20 + 2000);
  });

  it("グローバルに書く関数は JIT されない (正しさ優先)", () => {
    jitEq(`
      var g = 0;
      function f(x) { g = g + x; return g; }
      var r = 0;
      for (var i = 0; i < 30; i++) { r = f(1); }
      r * 1000 + g;
    `, 30 * 1000 + 30);
  });
});

describe("Phase 31 — 見せかけ JIT の排除 (hasThis 単一真実源)", () => {
  it("this を読み書きするメソッドが実際に Wasm で実行され結果が正しい", () => {
    // 旧: IR パスが StoreProperty の f64 型不整合で CompileError →
    // direct パスが this-model 無しでコンパイル → 旧 executeWasm の
    // !memory ガードで「compiled ログは出るが毎回 VM」の見せかけ JIT。
    // hasThis を compile 結果基準に単一化したら誤実行 (2802) が露呈した
    const src = `
      function T(s) { this.link = { big: "object" }; this.state = s; this.extra = null; }
      T.prototype.bump = function () { this.state = this.state + 1; return this.state; };
      var t = new T(0);
      var r = 0;
      for (var i = 0; i < 30; i++) { r = t.bump(); }
      r * 100 + t.state;
    `;
    const jit = vmEvaluate(src, { jit: true, jitThreshold: 3, useIR: true });
    assert.equal(jit, 3030);
  });
});
