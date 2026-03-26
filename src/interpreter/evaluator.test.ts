import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./evaluator.js";

describe("Evaluator - Step 1-1: 数値リテラルと四則演算", () => {
  it("数値リテラルを評価できる", () => {
    assert.equal(evaluate("42;"), 42);
  });

  it("加算を評価できる", () => {
    assert.equal(evaluate("1 + 2;"), 3);
  });

  it("減算を評価できる", () => {
    assert.equal(evaluate("10 - 3;"), 7);
  });

  it("乗算を評価できる", () => {
    assert.equal(evaluate("3 * 4;"), 12);
  });

  it("除算を評価できる", () => {
    assert.equal(evaluate("10 / 2;"), 5);
  });

  it("剰余を評価できる", () => {
    assert.equal(evaluate("10 % 3;"), 1);
  });

  it("演算子優先順位が正しい", () => {
    assert.equal(evaluate("1 + 2 * 3;"), 7);
  });

  it("括弧によるグループ化が正しい", () => {
    assert.equal(evaluate("(1 + 2) * 3;"), 9);
  });

  it("複数の演算を組み合わせられる", () => {
    assert.equal(evaluate("2 + 3 * 4 - 1;"), 13);
  });

  it("複数の文がある場合、最後の文の値を返す", () => {
    assert.equal(evaluate("1 + 2; 3 + 4;"), 7);
  });
});

describe("Evaluator - Step 1-2: var と変数参照", () => {
  it("var 宣言と変数参照ができる", () => {
    assert.equal(evaluate("var x = 10; x;"), 10);
  });

  it("変数を使った演算ができる", () => {
    assert.equal(evaluate("var x = 10; x + 5;"), 15);
  });

  it("変数同士の演算ができる", () => {
    assert.equal(evaluate("var x = 10; var y = 20; x + y;"), 30);
  });

  it("変数に式の結果を代入できる", () => {
    assert.equal(evaluate("var x = 10; var y = x + 5; y;"), 15);
  });

  it("変数を再代入できる", () => {
    assert.equal(evaluate("var x = 10; x = 20; x;"), 20);
  });

  it("初期化なしの var は undefined になる", () => {
    assert.equal(evaluate("var x; x;"), undefined);
  });

  it("未定義の変数参照でエラーになる", () => {
    assert.throws(() => evaluate("y;"), /not defined/);
  });
});

describe("Evaluator - Step 1-3: 比較・論理演算 + if/else", () => {
  it("比較演算を評価できる", () => {
    assert.equal(evaluate("1 < 2;"), true);
    assert.equal(evaluate("2 > 1;"), true);
    assert.equal(evaluate("1 <= 1;"), true);
    assert.equal(evaluate("1 >= 2;"), false);
  });

  it("等価演算を評価できる", () => {
    assert.equal(evaluate("1 == 1;"), true);
    assert.equal(evaluate("1 === 1;"), true);
    assert.equal(evaluate("1 != 2;"), true);
    assert.equal(evaluate("1 !== 2;"), true);
  });

  it("論理AND を短絡評価できる", () => {
    assert.equal(evaluate("true && false;"), false);
    assert.equal(evaluate("true && true;"), true);
    assert.equal(evaluate("false && true;"), false);
  });

  it("論理OR を短絡評価できる", () => {
    assert.equal(evaluate("true || false;"), true);
    assert.equal(evaluate("false || true;"), true);
    assert.equal(evaluate("false || false;"), false);
  });

  it("単項 ! を評価できる", () => {
    assert.equal(evaluate("!true;"), false);
    assert.equal(evaluate("!false;"), true);
  });

  it("if 文の consequent が実行される", () => {
    assert.equal(evaluate("var x = 0; if (true) { x = 1; } x;"), 1);
  });

  it("if 文の alternate が実行される", () => {
    assert.equal(evaluate("var x = 0; if (false) { x = 1; } else { x = 2; } x;"), 2);
  });

  it("if 文で条件式を評価できる", () => {
    assert.equal(
      evaluate("var x = 10; var y = 0; if (x > 5) { y = 1; } else { y = 2; } y;"),
      1,
    );
  });

  it("null リテラルを評価できる", () => {
    assert.equal(evaluate("null;"), null);
  });

  it("undefined リテラルを評価できる", () => {
    assert.equal(evaluate("undefined;"), undefined);
  });

  it("boolean リテラルを評価できる", () => {
    assert.equal(evaluate("true;"), true);
    assert.equal(evaluate("false;"), false);
  });
});

describe("Evaluator - Codex レビュー指摘修正", () => {
  it("var 再宣言（初期化なし）は既存の値を上書きしない", () => {
    assert.equal(evaluate("var a = 1; var a; a;"), 1);
  });

  it("var 再宣言（初期化あり）は値を更新する", () => {
    assert.equal(evaluate("var a = 1; var a = 2; a;"), 2);
  });

  it("undefined は書き換えできない", () => {
    assert.equal(evaluate("undefined = 1; undefined;"), undefined);
  });

  it("undefined は予約語ではなく識別子として参照できる", () => {
    assert.equal(evaluate("undefined;"), undefined);
  });

  it("var ホイスティング: 宣言前に参照すると undefined になる", () => {
    assert.equal(evaluate("var x = a; var a = 1; x;"), undefined);
  });

  it("var ホイスティング: 宣言前に参照しても ReferenceError にならない", () => {
    assert.doesNotThrow(() => evaluate("a; var a = 1;"));
  });

  it("$ 始まりの識別子が使える", () => {
    assert.equal(evaluate("var $x = 42; $x;"), 42);
  });

  it("$ のみの識別子が使える", () => {
    assert.equal(evaluate("var $ = 1; $;"), 1);
  });
});

describe("Evaluator - Step 1-4: while / for", () => {
  it("while で合計を計算できる", () => {
    assert.equal(evaluate(`
      var sum = 0;
      var i = 0;
      while (i < 5) {
        sum = sum + i;
        i = i + 1;
      }
      sum;
    `), 10);
  });

  it("while の条件が最初から false なら body を実行しない", () => {
    assert.equal(evaluate(`
      var x = 0;
      while (false) {
        x = 1;
      }
      x;
    `), 0);
  });

  it("for で合計を計算できる", () => {
    assert.equal(evaluate(`
      var sum = 0;
      for (var i = 0; i < 5; i = i + 1) {
        sum = sum + i;
      }
      sum;
    `), 10);
  });

  it("for のネストができる", () => {
    assert.equal(evaluate(`
      var sum = 0;
      for (var i = 0; i < 3; i = i + 1) {
        for (var j = 0; j < 3; j = j + 1) {
          sum = sum + 1;
        }
      }
      sum;
    `), 9);
  });

  it("for の init が式文でも動く", () => {
    assert.equal(evaluate(`
      var i = 10;
      for (i = 0; i < 3; i = i + 1) {}
      i;
    `), 3);
  });
});

describe("Evaluator - Step 1-5: 関数宣言・呼び出し・return", () => {
  it("関数を宣言して呼び出せる", () => {
    assert.equal(evaluate(`
      function add(a, b) {
        return a + b;
      }
      add(3, 4);
    `), 7);
  });

  it("関数は独自のスコープを持つ", () => {
    assert.equal(evaluate(`
      var x = 10;
      function foo(x) {
        return x + 1;
      }
      foo(20);
    `), 21);
  });

  it("関数の外の変数は変わらない", () => {
    assert.equal(evaluate(`
      var x = 10;
      function foo(x) {
        return x + 1;
      }
      foo(20);
      x;
    `), 10);
  });

  it("関数からクロージャでグローバル変数を参照できる", () => {
    assert.equal(evaluate(`
      var x = 100;
      function foo() {
        return x;
      }
      foo();
    `), 100);
  });

  it("再帰関数が動く", () => {
    assert.equal(evaluate(`
      function factorial(n) {
        if (n <= 1) {
          return 1;
        }
        return n * factorial(n - 1);
      }
      factorial(5);
    `), 120);
  });

  it("return がない関数は undefined を返す", () => {
    assert.equal(evaluate(`
      function noop() {}
      noop();
    `), undefined);
  });

  it("return で関数を途中で抜けられる", () => {
    assert.equal(evaluate(`
      function early(x) {
        if (x > 0) {
          return x;
        }
        return 0;
      }
      early(5);
    `), 5);
  });

  it("引数が足りない場合は undefined になる", () => {
    assert.equal(evaluate(`
      function foo(a, b) {
        return b;
      }
      foo(1);
    `), undefined);
  });
});

describe("Evaluator - Step 1-6: 文字列リテラル + console.log", () => {
  it("文字列リテラルを評価できる", () => {
    assert.equal(evaluate('"hello";'), "hello");
  });

  it("シングルクォートの文字列を評価できる", () => {
    assert.equal(evaluate("'hello';"), "hello");
  });

  it("文字列の連結ができる", () => {
    assert.equal(evaluate('"hello" + " " + "world";'), "hello world");
  });

  it("文字列と変数の連結ができる", () => {
    assert.equal(evaluate('var name = "world"; "hello " + name;'), "hello world");
  });

  it("console.log が動く", () => {
    const logs: unknown[] = [];
    evaluate('console.log("hello");', { log: (...args: unknown[]) => logs.push(...args) });
    assert.deepEqual(logs, ["hello"]);
  });

  it("console.log が複数引数を受け取れる", () => {
    const logs: unknown[][] = [];
    evaluate('console.log(1, 2, 3);', { log: (...args: unknown[]) => logs.push(args) });
    assert.deepEqual(logs, [[1, 2, 3]]);
  });

  it("console.log が数値を出力できる", () => {
    const logs: unknown[] = [];
    evaluate('console.log(42);', { log: (...args: unknown[]) => logs.push(...args) });
    assert.deepEqual(logs, [42]);
  });

  it("エスケープシーケンスが動く", () => {
    assert.equal(evaluate('"hello\\nworld";'), "hello\nworld");
    assert.equal(evaluate('"tab\\there";'), "tab\there");
    assert.equal(evaluate('"quote\\"here";'), 'quote"here');
    assert.equal(evaluate('"back\\\\slash";'), "back\\slash");
  });
});

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
