// tree-walking の全テストケースを vmEvaluate でも実行する互換テスト
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "./index.js";

// テストケース: [説明, ソースコード]
// evaluate と vmEvaluate が同じ結果を返すことを検証
const cases: [string, string][] = [
  // Phase 1: 基本
  ["数値リテラル", "42;"],
  ["加算", "1 + 2;"],
  ["演算子優先順位", "1 + 2 * 3;"],
  ["括弧", "(1 + 2) * 3;"],
  ["var と変数参照", "var x = 10; x + 5;"],
  ["変数同士", "var x = 10; var y = 20; x + y;"],
  ["変数再代入", "var x = 10; x = 20; x;"],
  ["比較演算", "1 < 2;"],
  ["論理AND", "true && false;"],
  ["論理OR", "false || true;"],
  ["単項NOT", "!true;"],
  ["if true", "var x = 0; if (true) { x = 1; } x;"],
  ["if false else", "var x = 0; if (false) { x = 1; } else { x = 2; } x;"],
  ["while ループ", "var s = 0; var i = 0; while (i < 5) { s = s + i; i = i + 1; } s;"],
  ["for ループ", "var s = 0; for (var i = 0; i < 5; i = i + 1) { s = s + i; } s;"],
  ["関数宣言と呼び出し", "function add(a, b) { return a + b; } add(3, 4);"],
  ["再帰", "function f(n) { if (n <= 1) { return 1; } return n * f(n - 1); } f(5);"],
  ["return なし", "function f() {} f();"],
  ["文字列", '"hello";'],
  ["文字列連結", '"hello" + " " + "world";'],

  // Phase 2: コア
  ["オブジェクトリテラル", "var p = { x: 10, y: 20 }; p.x + p.y;"],
  ["ブラケットアクセス", 'var p = { x: 10 }; p["x"];'],
  ["プロパティ代入", "var p = { x: 10 }; p.x = 99; p.x;"],
  ["配列リテラル", "var arr = [10, 20, 30]; arr[1];"],
  ["配列 length", "var arr = [1, 2, 3]; arr.length;"],
  ["typeof number", 'typeof 42;'],
  ["typeof string", 'typeof "hello";'],
  ["typeof undefined", "typeof undefined;"],
  ["typeof null", "typeof null;"],
  ["throw/catch", 'var r = 0; try { throw "err"; } catch (e) { r = e; } r;'],
  ["finally", "var r = 0; try { r = 1; } finally { r = r + 10; } r;"],

  // Phase 2: let/const
  ["let 宣言", "let x = 42; x;"],
  ["const 宣言", "const x = 10; x;"],
  ["ブロックスコープ let (関数内)", "function f() { let x = 1; { let x = 2; } return x; } f();"],

  // Phase 2: new / this
  ["new でオブジェクト生成", "function Foo(v) { this.v = v; } var f = new Foo(42); f.v;"],
  ["メソッド呼び出し this", "var o = { x: 10, f: function f() { return this.x; } }; o.f();"],

  // Phase 3: アロー
  ["アロー関数 (式)", "var f = (a, b) => a + b; f(3, 4);"],
  ["アロー関数 (ブロック)", "var f = (a) => { return a * 2; }; f(5);"],

  // Phase 3: テンプレートリテラル
  ["テンプレートリテラル", 'var n = "world"; `hello ${n}`;'],

  // Phase 3: for...of
  ["for...of", "var s = 0; for (var x of [10, 20, 30]) { s = s + x; } s;"],

  // Phase 3: ++/--, +=
  ["後置++", "var x = 5; x++; x;"],
  ["前置++", "var x = 5; ++x;"],
  ["+=", "var x = 10; x += 5; x;"],

  // Phase 3: break
  ["break", "var s = 0; for (var i = 0; i < 10; i = i + 1) { if (i === 5) { break; } s = s + i; } s;"],

  // Phase 3: クラス
  ["class 基本", "class A { constructor(x) { this.x = x; } get() { return this.x; } } var a = new A(42); a.get();"],

  // Phase 3: 分割代入
  ["オブジェクト分割代入", "var { x, y } = { x: 10, y: 20 }; x + y;"],
  ["配列分割代入", "var [a, b] = [1, 2]; a + b;"],

  // Phase 3: スプレッド
  ["配列スプレッド", "var arr = [1, 2, 3]; var a2 = [0, ...arr]; a2.length;"],

  // Phase 3: in / instanceof
  ["in 演算子", 'var o = { x: 1 }; "x" in o;'],

  // throw new Error
  ["throw new Error + catch", 'var msg = ""; try { throw new Error("oops"); } catch (e) { msg = e.message; } msg;'],

  // 現実的パターン: 配列の computed 代入
  ["arr[i] 代入", "var arr = []; arr[0] = 42; arr[0];"],
  ["arr[i] ループ代入", "var arr = []; for (var i = 0; i < 5; i = i + 1) { arr[i] = i * 10; } arr[3];"],
  ["arr.length after push", "var arr = []; arr[0] = 1; arr[1] = 2; arr.length;"],

  // 現実的パターン: 関数をコールバックとして渡す
  ["関数を引数に渡す", "function apply(fn, x) { return fn(x); } function dbl(n) { return n * 2; } apply(dbl, 5);"],
  ["forEach 的パターン", `
    function forEach(arr, fn) { for (var i = 0; i < arr.length; i = i + 1) { fn(arr[i], i); } }
    var sum = 0;
    forEach([10, 20, 30], function add(n) { sum = sum + n; });
    sum;
  `],

  // 現実的パターン: map + reduce
  ["map 的パターン", `
    function map(arr, fn) {
      var result = [];
      for (var i = 0; i < arr.length; i = i + 1) { result[i] = fn(arr[i]); }
      return result;
    }
    function double(x) { return x * 2; }
    var a = map([1, 2, 3], double);
    a[0] + a[1] + a[2];
  `],
  ["reduce 的パターン", `
    function reduce(arr, fn, init) {
      var acc = init;
      for (var i = 0; i < arr.length; i = i + 1) { acc = fn(acc, arr[i]); }
      return acc;
    }
    reduce([1, 2, 3, 4], function add(a, b) { return a + b; }, 0);
  `],

  // 現実的パターン: オブジェクト生成 + プロパティアクセス多数
  ["オブジェクト生成関数", `
    function makePoint(x, y) { return { x: x, y: y }; }
    function dist(a, b) { var dx = a.x - b.x; var dy = a.y - b.y; return dx * dx + dy * dy; }
    var p1 = makePoint(3, 4);
    var p2 = makePoint(0, 0);
    dist(p1, p2);
  `],

  // 現実的パターン: 再帰 + 配列操作 (quicksort)
  ["quicksort", `
    function swap(arr, i, j) { var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp; }
    function partition(arr, lo, hi) {
      var pivot = arr[hi];
      var i = lo;
      for (var j = lo; j < hi; j = j + 1) {
        if (arr[j] <= pivot) { swap(arr, i, j); i = i + 1; }
      }
      swap(arr, i, hi);
      return i;
    }
    function qsort(arr, lo, hi) {
      if (lo < hi) { var p = partition(arr, lo, hi); qsort(arr, lo, p - 1); qsort(arr, p + 1, hi); }
    }
    var a = [5, 3, 1, 4, 2];
    qsort(a, 0, a.length - 1);
    a[0] + a[2] + a[4];
  `],

  // 現実的パターン: クラス + メソッド呼び出し多数
  ["Vec クラス演算", `
    class Vec {
      constructor(x, y) { this.x = x; this.y = y; }
      add(other) { return new Vec(this.x + other.x, this.y + other.y); }
      dot(other) { return this.x * other.x + this.y * other.y; }
    }
    var v1 = new Vec(1, 2);
    var v2 = new Vec(3, 4);
    var v3 = v1.add(v2);
    v3.dot(new Vec(1, 1));
  `],

  // 現実的パターン: コールバック (トップレベル — クロージャ不要)
  ["コールバック多段 (トップレベル)", `
    function forEach(arr, fn) { for (var i = 0; i < arr.length; i = i + 1) { fn(arr[i], i); } }
    var result = [];
    var len = 0;
    forEach([1, 2, 3, 4, 5, 6], function check(item) {
      if (item % 2 === 0) { result[len] = item; len = len + 1; }
    });
    result[0] + result[1] + result[2];
  `],
];

describe("VM 互換テスト: evaluate vs vmEvaluate", () => {
  for (const [name, source] of cases) {
    it(name, () => {
      let twResult: unknown;
      let vmResult: unknown;
      let twError: Error | null = null;
      let vmError: Error | null = null;

      try { twResult = evaluate(source); } catch (e: any) { twError = e; }
      try { vmResult = vmEvaluate(source); } catch (e: any) { vmError = e; }

      if (twError) {
        // tree-walking がエラーなら VM もエラーであるべき
        assert.ok(vmError, `tree-walking threw but VM did not: ${twError.message}`);
      } else if (vmError) {
        assert.fail(`VM threw but tree-walking did not: ${vmError.message}`);
      } else {
        assert.deepEqual(vmResult, twResult);
      }
    });
  }
});
