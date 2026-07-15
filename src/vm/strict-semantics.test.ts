import { describe, it } from "node:test";
import assert from "node:assert";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "./index.js";

// 差分ファザ (npm run fuzz) が検出した VM の意味論バグ 3 件の回帰テスト。
// jsmini は strict のみをサポートするため、正しい挙動は Tree-Walking (evaluate) に一致する。

// 3 エンジン (TW / VM / VM+JIT) が同じ完了値を返すことを確認
function agree(src: string, expected: unknown) {
  const tw = evaluate(src);
  const vm = vmEvaluate(src);
  const jit = vmEvaluate(src, { jit: true, jitThreshold: 2 });
  assert.deepEqual(vm, tw, "VM が TW と一致");
  assert.deepEqual(jit, tw, "JIT が TW と一致");
  assert.deepEqual(vm, expected);
}

// 3 エンジンとも指定した種別で throw することを確認
function allThrow(src: string, ctor: new (...a: any[]) => Error) {
  for (const run of [() => evaluate(src), () => vmEvaluate(src), () => vmEvaluate(src, { jit: true, jitThreshold: 2 })]) {
    assert.throws(run, ctor, `throw ${ctor.name}: ${src}`);
  }
}

describe("bug1 — const 再代入は TypeError", () => {
  it("単純な再代入", () => allThrow(`const x = 1; x = 2;`, TypeError));
  it("複合代入 +=", () => allThrow(`const x = 1; x += 2;`, TypeError));
  it("インクリメント ++", () => allThrow(`const x = 1; x++;`, TypeError));
  it("非実行の else 分岐でも静的に検出", () => allThrow(`const x = 1; if (false) {} else { x = 9; }`, TypeError));
  it("分割代入で束縛した const", () => allThrow(`const { a } = { a: 1 }; a = 2;`, TypeError));
  it("配列分割の const", () => allThrow(`const [a, b] = [1, 2]; b = 3;`, TypeError));
  it("const の初期化は許可される", () => agree(`const x = 41; x + 1;`, 42));
  it("let は再代入できる", () => agree(`let x = 1; x = 2; x;`, 2));
});

describe("bug2 — object の数値/ビット変換は TypeError を投げない", () => {
  it("({}) & 0.5 → 0 (NaN→ToInt32)", () => agree(`(({}) & 0.5);`, 0));
  it("({}) | 3 → 3", () => agree(`(({}) | 3);`, 3));
  it("({}) ^ 5 → 5", () => agree(`(({}) ^ 5);`, 5));
  it("~({}) → -1", () => agree(`(~({}));`, -1));
  it("({}) << 1 → 0", () => agree(`(({}) << 1);`, 0));
  it("({}) >> 2 → 0", () => agree(`(({}) >> 2);`, 0));
  it("({}) >>> 0 → 0", () => agree(`(({}) >>> 0);`, 0));
  it("配列被演算子 [3] & 1 → 1", () => agree(`([3] & 1);`, 1));
  // ビルトインも同じ症状 (jsmini オブジェクトは host prototype が null で ToNumber が throw する)
  it("Math.abs({}) → NaN", () => agree(`Math.abs({});`, NaN));
  it("Math.max({}, \"0\") → NaN", () => agree(`Math.max({}, "0");`, NaN));
  it("isNaN({}) → true", () => agree(`isNaN({});`, true));
  it("isFinite({}) → false", () => agree(`isFinite({});`, false));
  it("Number({}) → NaN", () => agree(`Number({});`, NaN));
  it("配列は数値化できる Math.abs([3]) → 3", () => agree(`Math.abs([3]);`, 3));
});

describe("bug3 — 未宣言変数への代入は ReferenceError (strict)", () => {
  it("トップレベルの未宣言代入", () => allThrow(`y = 5;`, ReferenceError));
  it("関数内からの未宣言代入", () => allThrow(`function f() { z = 3; } f();`, ReferenceError));
  it("var 宣言後の代入は許可", () => agree(`var y; y = 5; y;`, 5));
  it("関数からグローバル var への書き込みは許可", () => agree(`var g = 0; function f(x) { g = g + x; return g; } f(10); g;`, 10));
});

describe("function-in-block — strict の block-scoped 巻き上げ", () => {
  it("ブロック内では宣言前から呼べる", () => agree(`var r = 0; { r = g(); function g() { return 3; } } r;`, 3));
  it("for 本体のブロック内で可視", () => agree(`var r = 0; for (var i = 0; i < 1; i++) { function f() { return 7; } r = f(); } r;`, 7));
  it("ブロックの外には漏れない (for)", () => allThrow(`for (var i = 0; i < 1; i++) { function f() { return 7; } } f();`, ReferenceError));
  it("ブロックの外には漏れない (if)", () => allThrow(`if (true) { function g() { return 8; } } g();`, ReferenceError));
});

describe("var 巻き上げ — 入れ子ブロック", () => {
  it("非実行の if 分岐内の var", () => agree(`if (false) { var v0 = 1; } v0;`, undefined));
  it("0 回ループの for 本体内の var", () => agree(`for (var i = 0; i < 0; i++) { var v1 = 2; } v1;`, undefined));
  it("try 内の非実行分岐の var", () => agree(`try { if (false) { var tv = 1; } } catch (e) {} tv;`, undefined));
  it("switch の非実行 case の var", () => agree(`switch (1) { case 2: var sv = 4; break; } sv;`, undefined));
});

describe("文字列/数値変換の spec 準拠", () => {
  it("文字列同士の相対比較は辞書順", () => agree(`("12" < "9") ? 1 : 0;`, 1));
  it("'a' < 'b'", () => agree(`("a" < "b") ? 1 : 0;`, 1));
  it("文字列と数値の相対比較は数値化", () => agree(`("5" < 10) ? 1 : 0;`, 1));
  it("'5' - 2 = 3 (ToNumber)", () => agree(`"5" - 2;`, 3));
  it("-'5' = -5", () => agree(`-"5";`, -5));
  it("[5] - 2 = 3 (配列の ToPrimitive)", () => agree(`[5] - 2;`, 3));
  it("[1] + 2 = '12' (文字列連結)", () => agree(`String([1] + 2);`, "12"));
  it("オブジェクト入り配列の数値化は NaN (throw しない)", () => agree(`isNaN([2, ({k0: 1})] - 0);`, true));
  it("String(オブジェクト入り配列)", () => agree(`String([({k0: 1}), 2]);`, "[object Object],2"));
  it("文字列の ++ は数値化", () => agree(`var s = "5"; s++; s;`, 6));
  it("computed キーにオブジェクト", () => agree(`var o = {}; o[o] = 5; o["[object Object]"];`, 5));
});

describe("Phase 36 — switch/lexical スコープと配列メソッド", () => {
  it("switch case 内 fn 宣言はブロック内可視", () => agree(`var x = 0; switch (1) { case 1: function f() { return 9; } x = f(); } x;`, 9));
  it("switch case 内 fn は前方 case から可視", () => agree(`var r = 0; switch (1) { case 1: r = g(); break; case 2: function g() { return 3; } } r;`, 3));
  it("switch case 内 fn は外に漏れない", () => allThrow(`switch (1) { case 1: function f() { return 9; } } f();`, ReferenceError));
  it("巻き上げ fn から後方の let へ書き込み", () => agree(`function f() { z = 5; } let z = 1; f(); z;`, 5));
  it("巻き上げ fn から後方の let を読む", () => agree(`function g() { return w; } let w = 1; g();`, 1));
  it("後方の const への代入は TypeError", () => allThrow(`function f() { x = 5; } const x = 1; f();`, TypeError));
  it("宣言前アクセスの擬似 TDZ は維持", () => allThrow(`q; let q = 1;`, ReferenceError));
  it("member 複合代入 o.p += v", () => agree(`var o = { p: 1 }; o.p += 2; o.p;`, 3));
  it("this.p += v (メソッド内)", () => agree(`function T() { this.c = 10; } T.prototype.add = function (n) { this.c += n; }; var t = new T(); t.add(5); t.add(3); t.c;`, 18));
  it("computed 複合代入 o[k] += v", () => agree(`var o = { p: 1 }; var k = "p"; o[k] += 2; o.p;`, 3));
  it("複合代入で object 式は 1 回だけ評価", () =>
    agree(`var n = 0; var w = { o: { p: 1 } }; function O() { n = n + 1; return w.o; } O().p += 2; w.o.p * 10 + n;`, 31));
  it("join は JSString 要素/区切りを正しく扱う", () => agree(`["a", "b"].join("-");`, "a-b"));
  it("join のオブジェクト要素は [object Object]", () => agree(`[({ k0: 1 }), 2].join("-");`, "[object Object]-2"));
  it("toString は join(,) 相当", () => agree(`["a", 1].toString();`, "a,1"));
  it("indexOf は concat 由来の文字列も内容比較", () => agree(`var s = "a" + "b"; ["ab"].indexOf(s);`, 0));
  it("sort 既定は ToString 辞書順", () => agree(`[10, 9, 1].sort().join(",");`, "1,10,9"));
  it("sort はオブジェクト要素で throw しない", () => agree(`[({}), 1].sort().length;`, 2));
});

describe("評価順 — callee 解決と複合代入の LHS", () => {
  it("未定義 callee は引数評価より先に ReferenceError", () => allThrow(`foo((void 0).x);`, ReferenceError));
  it("既知 callee なら引数の TypeError が飛ぶ", () => allThrow(`function g(x) { return x; } g((void 0).x);`, TypeError));
  it("複合代入は LHS 未宣言の ReferenceError が RHS 内の例外より先", () =>
    allThrow(`function f() { return (void 0).x; } v1 += f();`, ReferenceError));
});

describe("JIT の数値表現 — i32 で表現できない値", () => {
  function jitAgree(src: string, expected: unknown) {
    const vm = vmEvaluate(src);
    for (const useIR of [false, true]) {
      const jit = vmEvaluate(src, { jit: true, jitThreshold: 4, useIR });
      assert.deepEqual(jit, vm, `useIR=${useIR} が VM と一致`);
    }
    assert.deepEqual(vm, expected);
  }
  it("1e10 を返す関数が wrap しない", () =>
    jitAgree(`function f0() { return 1e10; } var x = 0; for (var i = 0; i < 300; i++) { x = f0(); } x;`, 1e10));
  it("小数定数 0.5 が 0 にならない", () =>
    jitAgree(`function h() { return 0.5; } var x = 0; for (var i = 0; i < 300; i++) { x = h(); } x;`, 0.5));
  it("-0 が 0 にならない", () => {
    const src = `function f0() { return -0; } var x = 1; for (var i = 0; i < 300; i++) { x = f0(); } x;`;
    for (const useIR of [false, true]) {
      const jit = vmEvaluate(src, { jit: true, jitThreshold: 4, useIR });
      assert.ok(Object.is(jit, -0), `useIR=${useIR} で -0 が保存される`);
    }
  });
});

describe("Phase 36-3 — == の ToNumber 段 (JS 仕様 7.2.14)", () => {
  it("'5' == 5", () => agree(`("5" == 5) ? 1 : 0;`, 1));
  it("'5' != 5 は false", () => agree(`("5" != 5) ? 1 : 0;`, 0));
  it("'abc' == 5 は false (NaN)", () => agree(`("abc" == 5) ? 1 : 0;`, 0));
  it("'1' == true", () => agree(`("1" == true) ? 1 : 0;`, 1));
  it("'' == 0", () => agree(`("" == 0) ? 1 : 0;`, 1));
  it("'' == null は false", () => agree(`("" == null) ? 1 : 0;`, 0));
  it("null == undefined", () => agree(`(null == undefined) ? 1 : 0;`, 1));
  it("null == 0 は false", () => agree(`(null == 0) ? 1 : 0;`, 0));
  it("[5] == 5 (ToPrimitive 経由)", () => agree(`([5] == 5) ? 1 : 0;`, 1));
  it("'5' === 5 は false のまま", () => agree(`("5" === 5) ? 1 : 0;`, 0));
  it("別オブジェクト同士は false (参照比較)", () => agree(`var a = {}, b = {}; (a == b ? 1 : 0) * 10 + (a == a ? 1 : 0);`, 1));
  it("2 == true は false", () => agree(`(2 == true) ? 1 : 0;`, 0));
});

describe("Phase 36-4 — ユーザー定義 valueOf/toString とビルトイン", () => {
  it("Number(valueOf)", () => agree(`var o = { valueOf: function () { return 42; } }; Number(o);`, 42));
  it("String(toString)", () => agree(`var o = { toString: function () { return "hi"; } }; String(o);`, "hi"));
  it("Math.abs(valueOf)", () => agree(`var o = { valueOf: function () { return -7; } }; Math.abs(o);`, 7));
  it("parseInt(toString)", () => agree(`var o = { toString: function () { return "42px"; } }; parseInt(o);`, 42));
  it("String は toString 優先", () => agree(`var o = { valueOf: function () { return 1; }, toString: function () { return "s"; } }; String(o);`, "s"));
  it("Number は valueOf 優先", () => agree(`var o = { valueOf: function () { return 1; }, toString: function () { return "2"; } }; Number(o);`, 1));
  it("メソッド無しは従来の既定値", () => agree(`isNaN(Number({})) ? 1 : 0;`, 1));
  it("+= の文字列結果は内容比較に乗る (JSString 生成)", () => agree(`var x = 1; x += [2]; ["12"].indexOf(x);`, 0));
});

describe("Phase 36-5 — JIT の boolean 表現 (tagged bool タグ + bool return)", () => {
  const jopts = { jit: true, jitThreshold: 3, useIR: true } as const;
  it("this.b = false が write-back 後も false", () => {
    const src = `
      function T() { this.b = true; this.n = 0; }
      T.prototype.step = function () { this.b = false; this.n = this.n + 1; return 0; };
      var t = new T();
      for (var i = 0; i < 30; i++) { t.step(); }
      t.b === false ? 1 : 0;
    `;
    assert.equal(vmEvaluate(src, jopts), vmEvaluate(src));
    assert.equal(vmEvaluate(src, jopts), 1);
  });
  it("copy-in された bool prop の truthiness", () => {
    const src = `
      function T() { this.flag = false; }
      T.prototype.check = function () { return this.flag ? 1 : 0; };
      var t = new T();
      var r = 0;
      for (var i = 0; i < 30; i++) { r = t.check(); }
      t.flag = true;
      r * 10 + t.check();
    `;
    assert.equal(vmEvaluate(src, jopts), vmEvaluate(src));
    assert.equal(vmEvaluate(src, jopts), 1);
  });
  it("return this.b が boolean のまま (tagged decode)", () => {
    const src = `
      function T() { this.b = false; }
      T.prototype.get = function () { return this.b; };
      var t = new T();
      var got;
      for (var i = 0; i < 30; i++) { got = t.get(); }
      got === false ? 1 : 0;
    `;
    assert.equal(vmEvaluate(src, jopts), 1);
  });
  it("bool return が number にならない (両 JIT パス)", () => {
    for (const useIR of [false, true]) {
      const src = `
        function f(a, b) { return a < b; }
        var got;
        for (var i = 0; i < 300; i++) { got = f(1, 2); }
        got === true ? 1 : 0;
      `;
      assert.equal(vmEvaluate(src, { jit: true, jitThreshold: 4, useIR }), 1, `useIR=${useIR}`);
    }
  });
  it("bool/非bool 混在 return は VM で正しく", () => {
    for (const useIR of [false, true]) {
      const src = `
        function f(c) { if (c) return false; return 42; }
        var got;
        for (var i = 0; i < 300; i++) { got = f(0); }
        var g2 = f(1);
        (got === 42 ? 10 : 0) + (g2 === false ? 1 : 0);
      `;
      assert.equal(vmEvaluate(src, { jit: true, jitThreshold: 4, useIR }), 11, `useIR=${useIR}`);
    }
  });
});

describe("Phase 36-6 — TDZ (Temporal Dead Zone) の実行時実装", () => {
  // switch: 制御が宣言をスキップして別 case の lexical を読む → ReferenceError
  it("switch case をまたぐ宣言前 read", () =>
    allThrow(`switch (undefined) { case 1: const v0 = true; break; default: [(v0)]; }`, ReferenceError));
  it("switch case をまたぐ宣言前 write", () =>
    allThrow(`switch (undefined) { case 1: let v0 = 1; break; default: v0 = 2; }`, ReferenceError));
  // block: 宣言文より前で read/write
  it("block 内の宣言前 read", () => allThrow(`{ x; let x = 1; }`, ReferenceError));
  it("block 内の宣言前 write", () => allThrow(`{ x = 2; let x = 1; }`, ReferenceError));
  // closure: 巻き上げ関数が初期化前に lexical をキャプチャ read
  it("クロージャの宣言前キャプチャ read", () =>
    allThrow(`function foo() { return q; } foo(); let q = 3;`, ReferenceError));
  // 正常系: 初期化後は普通に読める / let 無初期化は undefined (TDZ ではない)
  it("初期化後の read は正常", () => agree(`let a = 5; let b = a + 1; b;`, 6));
  it("初期化子無し let は undefined (throw しない)", () => agree(`let z; z;`, undefined));
  it("block の const は初期化後 read 可", () => agree(`let r = 0; { const c = 10; r = c * 2; } r;`, 20));
  it("再代入は初期化後なら throw しない", () => agree(`let x = 1; x = 2; x;`, 2));
  it("switch case 内 let は別 case で共有 (初期化後)", () =>
    agree(`let r; switch (1) { case 1: let v = 7; case 2: r = v; } r;`, 7));
});

describe("Phase 36-6 — null/undefined へのプロパティ代入は TypeError", () => {
  it("null[key] = v (computed)", () => allThrow(`var v0 = null; (v0)["k0"] = 1;`, TypeError));
  it("null.x = v (dotted)", () => allThrow(`var v0 = null; v0.x = 1;`, TypeError));
  it("undefined.x = v", () => allThrow(`var v0; v0.x = 1;`, TypeError));
  it("null.x += v (複合代入)", () => allThrow(`var v0 = null; v0.x += 1;`, TypeError));
});

describe("Phase 36-6 — プリミティブへのプロパティ代入は TypeError (intern 汚染防止)", () => {
  // 文字列は intern 共有オブジェクト。代入を許すと後続実行に状態が漏れる
  it("string.x = v", () => allThrow(`let s = "a"; s.x = 5;`, TypeError));
  it("string.x += v (複合)", () => allThrow(`let s = "a"; s.x += 1;`, TypeError));
  it("string[key] = v (computed)", () => allThrow(`let s = "a"; s["k"] = 5;`, TypeError));
  it("number.x = v", () => allThrow(`let n = 5; n.x = 1;`, TypeError));
  it("boolean.x = v", () => allThrow(`let b = true; b.x = 1;`, TypeError));
  it("symbol.x = v", () => allThrow(`let y = Symbol(); y.x = 1;`, TypeError));
  // 汚染していないこと: 代入試行後も文字列プロパティは undefined のまま
  it("代入失敗後に string プロパティは汚染されない", () =>
    agree(`try { let s = "a"; s.x = 5; } catch (e) {} ("a").x;`, undefined));
});
