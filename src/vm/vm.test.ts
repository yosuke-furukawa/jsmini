import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vmEvaluate } from "./index.js";
import { compile } from "./compiler.js";
import { disassemble } from "./bytecode.js";

describe("VM - Step 4-1: パイプライン貫通 (リテラル + 算術)", () => {
  it("数値リテラルを評価できる", () => {
    assert.equal(vmEvaluate("42;"), 42);
  });

  it("加算を評価できる", () => {
    assert.equal(vmEvaluate("1 + 2;"), 3);
  });

  it("減算を評価できる", () => {
    assert.equal(vmEvaluate("10 - 3;"), 7);
  });

  it("乗算を評価できる", () => {
    assert.equal(vmEvaluate("3 * 4;"), 12);
  });

  it("除算を評価できる", () => {
    assert.equal(vmEvaluate("10 / 2;"), 5);
  });

  it("剰余を評価できる", () => {
    assert.equal(vmEvaluate("10 % 3;"), 1);
  });

  it("演算子優先順位が正しい", () => {
    assert.equal(vmEvaluate("1 + 2 * 3;"), 7);
  });

  it("括弧によるグループ化が正しい", () => {
    assert.equal(vmEvaluate("(1 + 2) * 3;"), 9);
  });

  it("複数の演算を組み合わせられる", () => {
    assert.equal(vmEvaluate("2 + 3 * 4 - 1;"), 13);
  });

  it("複数の文がある場合、最後の文の値を返す", () => {
    assert.equal(vmEvaluate("1 + 2; 3 + 4;"), 7);
  });

  it("単項マイナスが動く", () => {
    assert.equal(vmEvaluate("-5;"), -5);
  });

  it("真偽値リテラルが動く", () => {
    assert.equal(vmEvaluate("true;"), true);
    assert.equal(vmEvaluate("false;"), false);
  });

  it("null リテラルが動く", () => {
    assert.equal(vmEvaluate("null;"), null);
  });

  it("比較演算が動く", () => {
    assert.equal(vmEvaluate("1 < 2;"), true);
    assert.equal(vmEvaluate("2 > 1;"), true);
    assert.equal(vmEvaluate("1 === 1;"), true);
    assert.equal(vmEvaluate("1 !== 2;"), true);
  });

  it("論理 NOT が動く", () => {
    assert.equal(vmEvaluate("!true;"), false);
    assert.equal(vmEvaluate("!false;"), true);
  });
});

describe("VM - disassemble", () => {
  it("算術のバイトコードをダンプできる", () => {
    const func = compile("1 + 2 * 3;");
    const output = disassemble(func);
    assert.ok(output.includes("LdaConst"));
    assert.ok(output.includes("Mul"));
    assert.ok(output.includes("Add"));
    assert.ok(output.includes("<script>"));
  });

  it("関数のバイトコードをダンプできる", () => {
    const func = compile("function add(a, b) { return a + b; }");
    const output = disassemble(func);
    assert.ok(output.includes("== add"));
    assert.ok(output.includes("LdaLocal"));
    assert.ok(output.includes("Add"));
    assert.ok(output.includes("Return"));
  });

  it("制御フローのジャンプ先が表示される", () => {
    const func = compile("var x = 0; if (true) { x = 1; }");
    const output = disassemble(func);
    assert.ok(output.includes("JumpIfFalse"));
    assert.ok(output.includes("->"));
  });
});

describe("VM - Step 4-2: 変数 + 制御フロー", () => {
  it("var 宣言と変数参照ができる", () => {
    assert.equal(vmEvaluate("var x = 10; x;"), 10);
  });

  it("変数を使った演算ができる", () => {
    assert.equal(vmEvaluate("var x = 10; x + 5;"), 15);
  });

  it("変数同士の演算ができる", () => {
    assert.equal(vmEvaluate("var x = 10; var y = 20; x + y;"), 30);
  });

  it("変数に式の結果を代入できる", () => {
    assert.equal(vmEvaluate("var x = 10; var y = x + 5; y;"), 15);
  });

  it("変数を再代入できる", () => {
    assert.equal(vmEvaluate("var x = 10; x = 20; x;"), 20);
  });

  it("初期化なしの var は undefined になる", () => {
    assert.equal(vmEvaluate("var x; x;"), undefined);
  });

  it("if 文の consequent が実行される", () => {
    assert.equal(vmEvaluate("var x = 0; if (true) { x = 1; } x;"), 1);
  });

  it("if 文の alternate が実行される", () => {
    assert.equal(vmEvaluate("var x = 0; if (false) { x = 1; } else { x = 2; } x;"), 2);
  });

  it("if 文で条件式を評価できる", () => {
    assert.equal(vmEvaluate(`
      var x = 10;
      var y = 0;
      if (x > 5) { y = 1; } else { y = 2; }
      y;
    `), 1);
  });

  it("while で合計を計算できる", () => {
    assert.equal(vmEvaluate(`
      var sum = 0;
      var i = 0;
      while (i < 5) {
        sum = sum + i;
        i = i + 1;
      }
      sum;
    `), 10);
  });

  it("for で合計を計算できる", () => {
    assert.equal(vmEvaluate(`
      var sum = 0;
      for (var i = 0; i < 5; i = i + 1) {
        sum = sum + i;
      }
      sum;
    `), 10);
  });

  it("for のネストができる", () => {
    assert.equal(vmEvaluate(`
      var sum = 0;
      for (var i = 0; i < 3; i = i + 1) {
        for (var j = 0; j < 3; j = j + 1) {
          sum = sum + 1;
        }
      }
      sum;
    `), 9);
  });
});

describe("VM - Step 4-3: 関数", () => {
  it("関数を宣言して呼び出せる", () => {
    assert.equal(vmEvaluate(`
      function add(a, b) {
        return a + b;
      }
      add(3, 4);
    `), 7);
  });

  it("関数は引数をローカルで持つ", () => {
    assert.equal(vmEvaluate(`
      var x = 100;
      function f(x) {
        return x + 1;
      }
      f(10);
    `), 11);
  });

  it("関数の外の変数は変わらない", () => {
    assert.equal(vmEvaluate(`
      var x = 100;
      function f(x) {
        return x + 1;
      }
      f(10);
      x;
    `), 100);
  });

  it("return がない関数は undefined を返す", () => {
    assert.equal(vmEvaluate(`
      function noop() {}
      noop();
    `), undefined);
  });

  it("return で関数を途中で抜けられる", () => {
    assert.equal(vmEvaluate(`
      function early(x) {
        if (x > 0) {
          return x;
        }
        return 0;
      }
      early(5);
    `), 5);
  });

  it("再帰関数が動く", () => {
    assert.equal(vmEvaluate(`
      function factorial(n) {
        if (n <= 1) {
          return 1;
        }
        return n * factorial(n - 1);
      }
      factorial(5);
    `), 120);
  });

  it("引数が足りない場合は undefined になる", () => {
    assert.equal(vmEvaluate(`
      function f(a, b) {
        return b;
      }
      f(1);
    `), undefined);
  });

  it("関数からグローバル変数を参照できる", () => {
    assert.equal(vmEvaluate(`
      var x = 100;
      function f() {
        return x;
      }
      f();
    `), 100);
  });
});

describe("VM - Step 4-5: 文字列 + console.log", () => {
  it("文字列リテラルを評価できる", () => {
    assert.equal(vmEvaluate('"hello";'), "hello");
  });

  it("文字列連結ができる", () => {
    assert.equal(vmEvaluate('"hello" + " " + "world";'), "hello world");
  });

  it("文字列と変数の連結ができる", () => {
    assert.equal(vmEvaluate('var name = "world"; "hello " + name;'), "hello world");
  });

  it("console.log が動く", () => {
    const logs: unknown[] = [];
    vmEvaluate('console.log("hello");', { log: (...args: unknown[]) => logs.push(...args) });
    assert.deepEqual(logs, ["hello"]);
  });

  it("console.log が複数引数を受け取れる", () => {
    const logs: unknown[][] = [];
    vmEvaluate('console.log(1, 2, 3);', { log: (...args: unknown[]) => logs.push(args) });
    assert.deepEqual(logs, [[1, 2, 3]]);
  });

  it("console.log が数値を出力できる", () => {
    const logs: unknown[] = [];
    vmEvaluate('console.log(42);', { log: (...args: unknown[]) => logs.push(...args) });
    assert.deepEqual(logs, [42]);
  });
});

describe("VM - Step 4-6: Phase 2 構文", () => {
  it("オブジェクトリテラルが動く", () => {
    assert.equal(vmEvaluate("var p = { x: 10, y: 20 }; p.x + p.y;"), 30);
  });

  it("ブラケットアクセスが動く", () => {
    assert.equal(vmEvaluate('var p = { x: 10 }; p["x"];'), 10);
  });

  it("プロパティ代入が動く", () => {
    assert.equal(vmEvaluate("var p = { x: 10 }; p.x = 99; p.x;"), 99);
  });

  it("配列リテラルが動く", () => {
    assert.equal(vmEvaluate("var arr = [10, 20, 30]; arr[1];"), 20);
  });

  it("配列の length が動く", () => {
    assert.equal(vmEvaluate("var arr = [1, 2, 3]; arr.length;"), 3);
  });

  it("typeof が動く", () => {
    assert.equal(vmEvaluate('typeof 42;'), "number");
    assert.equal(vmEvaluate('typeof "hello";'), "string");
    assert.equal(vmEvaluate("typeof true;"), "boolean");
    assert.equal(vmEvaluate("typeof undefined;"), "undefined");
    assert.equal(vmEvaluate("typeof null;"), "object");
  });

  it("throw / try / catch が動く", () => {
    assert.equal(vmEvaluate(`
      var result = 0;
      try {
        throw "error";
      } catch (e) {
        result = e;
      }
      result;
    `), "error");
  });

  it("finally が動く", () => {
    assert.equal(vmEvaluate(`
      var result = 0;
      try {
        result = 1;
      } finally {
        result = result + 10;
      }
      result;
    `), 11);
  });
});
