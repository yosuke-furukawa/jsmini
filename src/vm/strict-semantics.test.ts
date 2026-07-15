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
