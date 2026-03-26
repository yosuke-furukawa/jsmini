import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./evaluator.js";
describe("Evaluator - Step 2-1: オブジェクトリテラル", () => {
  it("空のオブジェクトを生成できる", () => {
    const result = evaluate("var x = {}; x;") as any;
    assert.equal(typeof result, "object");
    assert.notEqual(result, null);
  });

  it("プロパティ付きオブジェクトを生成できる", () => {
    const result = evaluate("var p = { x: 10, y: 20 }; p;") as any;
    assert.equal(result.x, 10);
    assert.equal(result.y, 20);
  });

  it("ドットアクセスでプロパティを読める", () => {
    assert.equal(evaluate("var p = { x: 10, y: 20 }; p.x + p.y;"), 30);
  });

  it("ブラケットアクセスでプロパティを読める", () => {
    assert.equal(evaluate('var p = { x: 10 }; p["x"];'), 10);
  });

  it("ドットアクセスでプロパティに代入できる", () => {
    assert.equal(evaluate("var p = { x: 10 }; p.x = 100; p.x;"), 100);
  });

  it("ブラケットアクセスでプロパティに代入できる", () => {
    assert.equal(evaluate('var p = { x: 10 }; p["x"] = 200; p.x;'), 200);
  });

  it("存在しないプロパティは undefined", () => {
    assert.equal(evaluate("var p = { x: 10 }; p.y;"), undefined);
  });

  it("新しいプロパティを追加できる", () => {
    assert.equal(evaluate("var p = {}; p.x = 42; p.x;"), 42);
  });

  it("数値キーのオブジェクトが動く", () => {
    assert.equal(evaluate("var x = { 0: 10, 1: 20 }; x[0];"), 10);
  });

  it("変数をキーにブラケットアクセスできる", () => {
    assert.equal(evaluate('var p = { x: 10 }; var k = "x"; p[k];'), 10);
  });

  it("ネストしたオブジェクトが動く", () => {
    assert.equal(evaluate("var o = { a: { b: 42 } }; o.a.b;"), 42);
  });
});

describe("Evaluator - Step 2-2: 配列", () => {
  it("配列リテラルを生成できる", () => {
    const result = evaluate("var arr = [10, 20, 30]; arr;") as any;
    assert.deepEqual(result, [10, 20, 30]);
  });

  it("インデックスアクセスができる", () => {
    assert.equal(evaluate("var arr = [10, 20, 30]; arr[0];"), 10);
    assert.equal(evaluate("var arr = [10, 20, 30]; arr[2];"), 30);
  });

  it(".length が取得できる", () => {
    assert.equal(evaluate("var arr = [10, 20, 30]; arr.length;"), 3);
  });

  it("空配列の .length は 0", () => {
    assert.equal(evaluate("var arr = []; arr.length;"), 0);
  });

  it("インデックスに代入できる", () => {
    assert.equal(evaluate("var arr = [1, 2, 3]; arr[0] = 99; arr[0];"), 99);
  });

  it("変数をインデックスに使える", () => {
    assert.equal(evaluate("var arr = [10, 20, 30]; var i = 1; arr[i];"), 20);
  });

  it("式をインデックスに使える", () => {
    assert.equal(evaluate("var arr = [10, 20, 30]; arr[1 + 1];"), 30);
  });

  it("範囲外アクセスは undefined", () => {
    assert.equal(evaluate("var arr = [1]; arr[5];"), undefined);
  });

  it("ネストした配列が動く", () => {
    assert.equal(evaluate("var arr = [[1, 2], [3, 4]]; arr[1][0];"), 3);
  });

  it("for ループで配列を走査できる", () => {
    assert.equal(evaluate(`
      var arr = [10, 20, 30];
      var sum = 0;
      for (var i = 0; i < arr.length; i = i + 1) {
        sum = sum + arr[i];
      }
      sum;
    `), 60);
  });
});

describe("Evaluator - Step 2-3: let / const・ブロックスコープ", () => {
  it("let で変数を宣言できる", () => {
    assert.equal(evaluate("let x = 10; x;"), 10);
  });

  it("const で変数を宣言できる", () => {
    assert.equal(evaluate("const x = 42; x;"), 42);
  });

  it("const への再代入でエラーになる", () => {
    assert.throws(() => evaluate("const x = 1; x = 2;"), /Assignment to constant/);
  });

  it("let はブロックスコープを持つ", () => {
    assert.equal(evaluate(`
      let x = 1;
      {
        let x = 2;
        x;
      }
    `), 2);
  });

  it("ブロック内の let は外に漏れない", () => {
    assert.equal(evaluate(`
      let x = 1;
      {
        let x = 2;
      }
      x;
    `), 1);
  });

  it("const もブロックスコープを持つ", () => {
    assert.equal(evaluate(`
      const x = 1;
      {
        const x = 2;
        x;
      }
    `), 2);
  });

  it("var はブロックスコープを貫通する", () => {
    assert.equal(evaluate(`
      {
        var x = 10;
      }
      x;
    `), 10);
  });

  it("let の TDZ: 宣言前に参照するとエラー", () => {
    assert.throws(() => evaluate(`
      {
        x;
        let x = 1;
      }
    `), /Cannot access.*before initialization/);
  });

  it("クロージャが let 変数をキャプチャする", () => {
    assert.equal(evaluate(`
      let count = 0;
      function inc() {
        count = count + 1;
        return count;
      }
      inc();
      inc();
      inc();
    `), 3);
  });

  it("for の let は各イテレーションでスコープを持つ（基本動作）", () => {
    assert.equal(evaluate(`
      let sum = 0;
      for (let i = 0; i < 3; i = i + 1) {
        sum = sum + i;
      }
      sum;
    `), 3);
  });

  it("for の let 変数はループ外からアクセスできない", () => {
    assert.throws(() => evaluate(`
      for (let i = 0; i < 3; i = i + 1) {}
      i;
    `), /not defined/);
  });

  it("const の初期化なしはエラー", () => {
    assert.throws(() => evaluate("const x;"), /Missing initializer/);
  });

  it("同一スコープで let の重複宣言はエラー", () => {
    assert.throws(() => evaluate("{ let x = 1; let x = 2; }"), /already been declared/);
  });

  it("同一スコープで const の重複宣言はエラー", () => {
    assert.throws(() => evaluate("{ const x = 1; const x = 2; }"), /already been declared/);
  });

  it("var ホイスティングが関数スコープ内で正しく動く", () => {
    assert.equal(evaluate(`
      var x = 1;
      function f() { var y = x; var x = 2; return y; }
      f();
    `), undefined);
  });
});

describe("Evaluator - Step 2-4a: typeof", () => {
  it("typeof number", () => {
    assert.equal(evaluate('typeof 42;'), "number");
  });

  it("typeof string", () => {
    assert.equal(evaluate('typeof "hello";'), "string");
  });

  it("typeof boolean", () => {
    assert.equal(evaluate("typeof true;"), "boolean");
  });

  it("typeof undefined", () => {
    assert.equal(evaluate("typeof undefined;"), "undefined");
  });

  it("typeof null は object", () => {
    assert.equal(evaluate("typeof null;"), "object");
  });

  it("typeof object", () => {
    assert.equal(evaluate("typeof {};"), "object");
  });

  it("typeof array は object", () => {
    assert.equal(evaluate("typeof [];"), "object");
  });

  it("typeof function", () => {
    assert.equal(evaluate("function f() {} typeof f;"), "function");
  });

  it("typeof 未定義変数は ReferenceError にならず undefined を返す", () => {
    assert.equal(evaluate("typeof notDefined;"), "undefined");
  });

  it("typeof を式の中で使える", () => {
    assert.equal(evaluate('typeof 42 === "number";'), true);
  });
});

describe("Evaluator - Step 2-4b: throw / try / catch", () => {
  it("throw した値を catch で受け取れる", () => {
    assert.equal(evaluate(`
      var result = 0;
      try {
        throw "error";
      } catch (e) {
        result = e;
      }
      result;
    `), "error");
  });

  it("throw で数値を投げられる", () => {
    assert.equal(evaluate(`
      var result = 0;
      try {
        throw 42;
      } catch (e) {
        result = e;
      }
      result;
    `), 42);
  });

  it("try の中で例外がなければ catch は実行されない", () => {
    assert.equal(evaluate(`
      var result = 1;
      try {
        result = 2;
      } catch (e) {
        result = 3;
      }
      result;
    `), 2);
  });

  it("finally は常に実行される（例外あり）", () => {
    assert.equal(evaluate(`
      var result = 0;
      try {
        throw "err";
      } catch (e) {
        result = 1;
      } finally {
        result = result + 10;
      }
      result;
    `), 11);
  });

  it("finally は常に実行される（例外なし）", () => {
    assert.equal(evaluate(`
      var result = 0;
      try {
        result = 1;
      } finally {
        result = result + 10;
      }
      result;
    `), 11);
  });

  it("catch の変数は catch ブロック内のみ", () => {
    assert.throws(() => evaluate(`
      try { throw 1; } catch (e) {}
      e;
    `), /not defined/);
  });

  it("catch なしの try-finally で throw は再 throw される", () => {
    assert.throws(() => evaluate(`
      var x = 0;
      try {
        throw "err";
      } finally {
        x = 1;
      }
    `));
  });

  it("catch で ReferenceError を捕捉できる", () => {
    assert.equal(evaluate(`
      var result = "ok";
      try {
        notDefined;
      } catch (e) {
        result = "caught";
      }
      result;
    `), "caught");
  });

  it("catch 内で throw しても finally は実行される", () => {
    assert.equal(evaluate(`
      var x = 0;
      try {
        try {
          throw 1;
        } catch (e) {
          throw 2;
        } finally {
          x = 99;
        }
      } catch (e) {}
      x;
    `), 99);
  });

  it("try {} だけは SyntaxError", () => {
    assert.throws(() => evaluate("try {}"), /Missing catch or finally/);
  });
});

describe("Evaluator - Step 2-4c: new + Error", () => {
  it("new でオブジェクトを生成できる", () => {
    assert.equal(evaluate(`
      function Point(x, y) {
        this.x = x;
        this.y = y;
      }
      var p = new Point(10, 20);
      p.x + p.y;
    `), 30);
  });

  it("new で生成したオブジェクトのプロパティにアクセスできる", () => {
    assert.equal(evaluate(`
      function Foo(val) {
        this.val = val;
      }
      var f = new Foo(42);
      f.val;
    `), 42);
  });

  it("throw new Error が動く", () => {
    assert.equal(evaluate(`
      var msg = "";
      try {
        throw new Error("something went wrong");
      } catch (e) {
        msg = e.message;
      }
      msg;
    `), "something went wrong");
  });

  it("Error の typeof は object", () => {
    assert.equal(evaluate(`
      var e = new Error("test");
      typeof e;
    `), "object");
  });

  it("コンストラクタが値を return したらそれが使われる（オブジェクト）", () => {
    assert.equal(evaluate(`
      function Foo() {
        return { x: 99 };
      }
      var f = new Foo();
      f.x;
    `), 99);
  });

  it("コンストラクタがプリミティブを return したら this が使われる", () => {
    assert.equal(evaluate(`
      function Foo() {
        this.x = 42;
        return 123;
      }
      var f = new Foo();
      f.x;
    `), 42);
  });
});

describe("Evaluator - Step 2-4d: this", () => {
  it("メソッド呼び出しで this がオブジェクトを指す", () => {
    assert.equal(evaluate(`
      var obj = {
        x: 10,
        getX: function getX() { return this.x; }
      };
      obj.getX();
    `), 10);
  });

  it("通常の関数呼び出しで this は undefined", () => {
    assert.equal(evaluate(`
      function getThis() { return this; }
      var result = getThis();
      result;
    `), undefined);
  });
});
