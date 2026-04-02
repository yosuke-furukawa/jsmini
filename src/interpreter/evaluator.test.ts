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

  it("分割代入 rest/default が動く", () => {
    assert.equal(evaluate("var [a, ...rest] = [1, 2, 3]; rest[0] + rest[1];"), 5);
    assert.equal(evaluate("var {a, ...rest} = {a: 1, b: 2, c: 3}; rest.b + rest.c;"), 5);
    assert.equal(evaluate("var {a = 10, b = 20} = {a: 1}; a + b;"), 21);
    assert.equal(evaluate("var [x = 5, y = 6] = [1]; x + y;"), 7);
    assert.equal(evaluate("var [,, x] = [1, 2, 3]; x;"), 3);
  });
});

