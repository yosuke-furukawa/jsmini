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
