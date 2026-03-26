import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./evaluator.js";
describe("Evaluator - Step 3-1: アロー関数", () => {
  it("アロー関数（式本体）が動く", () => {
    assert.equal(evaluate(`
      var add = (a, b) => a + b;
      add(3, 4);
    `), 7);
  });

  it("アロー関数（ブロック本体）が動く", () => {
    assert.equal(evaluate(`
      var add = (a, b) => { return a + b; };
      add(3, 4);
    `), 7);
  });

  it("引数なしのアロー関数が動く", () => {
    assert.equal(evaluate(`
      var f = () => 42;
      f();
    `), 42);
  });

  it("単一引数（括弧省略）のアロー関数が動く", () => {
    assert.equal(evaluate(`
      var double = a => a * 2;
      double(5);
    `), 10);
  });

  it("アロー関数は this を継承する", () => {
    assert.equal(evaluate(`
      var obj = {
        x: 10,
        getX: function getX() {
          var inner = () => this.x;
          return inner();
        }
      };
      obj.getX();
    `), 10);
  });

  it("アロー関数をコールバックとして渡せる", () => {
    assert.equal(evaluate(`
      function apply(f, x) {
        return f(x);
      }
      apply(x => x + 1, 10);
    `), 11);
  });

  it("アロー関数でクロージャが動く", () => {
    assert.equal(evaluate(`
      function makeAdder(n) {
        return (x) => x + n;
      }
      var add5 = makeAdder(5);
      add5(10);
    `), 15);
  });

  it("アロー関数は new できない", () => {
    assert.throws(() => evaluate(`
      var f = () => 1;
      new f();
    `), /not a constructor/);
  });
});

describe("Evaluator - カンマ演算子", () => {
  it("カンマ演算子は右辺の値を返す", () => {
    assert.equal(evaluate("var x = (1, 2, 3); x;"), 3);
  });

  it("カンマ演算子の副作用が実行される", () => {
    assert.equal(evaluate(`
      var x = 0;
      var y = (x = 1, x = 2, x + 10);
      y;
    `), 12);
  });

  it("for の中でカンマ演算子が使える", () => {
    assert.equal(evaluate(`
      var x = 0;
      var y = 0;
      for (x = 1, y = 2; x < 3; x = x + 1) {}
      x + y;
    `), 5);
  });
});

describe("Evaluator - Step 3-2: テンプレートリテラル", () => {
  it("式埋め込みなしのテンプレートリテラル", () => {
    assert.equal(evaluate("`hello`;"), "hello");
  });

  it("式埋め込みありのテンプレートリテラル", () => {
    assert.equal(evaluate('var name = "world"; `hello ${name}`;'), "hello world");
  });

  it("式の計算を埋め込める", () => {
    assert.equal(evaluate("`1 + 2 = ${1 + 2}`;"), "1 + 2 = 3");
  });

  it("複数の式を埋め込める", () => {
    assert.equal(evaluate('var a = "x"; var b = "y"; `${a} and ${b}`;'), "x and y");
  });

  it("空のテンプレートリテラル", () => {
    assert.equal(evaluate("``; "), "");
  });

  it("式のみのテンプレートリテラル", () => {
    assert.equal(evaluate("`${42}`;"), "42");
  });

  it("テンプレートリテラルのネスト", () => {
    assert.equal(evaluate('var x = 1; `a ${`b ${x}`} c`;'), "a b 1 c");
  });
});

describe("Evaluator - Step 3-3: プロトタイプチェーン", () => {
  it("prototype に定義したメソッドがインスタンスから呼べる", () => {
    assert.equal(evaluate(`
      function Animal(name) {
        this.name = name;
      }
      Animal.prototype.speak = function speak() {
        return this.name + " makes a sound";
      };
      var dog = new Animal("Rex");
      dog.speak();
    `), "Rex makes a sound");
  });

  it("インスタンス自身のプロパティが prototype より優先される", () => {
    assert.equal(evaluate(`
      function Foo() {
        this.x = 10;
      }
      Foo.prototype.x = 99;
      var f = new Foo();
      f.x;
    `), 10);
  });

  it("prototype チェーンを辿ってプロパティを探す", () => {
    assert.equal(evaluate(`
      function A() {}
      A.prototype.hello = function hello() { return "hi"; };
      function B() {}
      B.prototype = new A();
      var b = new B();
      b.hello();
    `), "hi");
  });

  it("prototype に存在しないプロパティは undefined", () => {
    assert.equal(evaluate(`
      function Foo() {}
      var f = new Foo();
      f.nonexistent;
    `), undefined);
  });

  it("関数宣言に prototype プロパティが自動で付く", () => {
    assert.equal(evaluate(`
      function Foo() {}
      typeof Foo.prototype;
    `), "object");
  });

  it("prototype にプロパティを後から追加できる", () => {
    assert.equal(evaluate(`
      function Foo() {}
      var f = new Foo();
      Foo.prototype.x = 42;
      f.x;
    `), 42);
  });

  it("null のプロパティアクセスは TypeError", () => {
    assert.throws(() => evaluate("var x = null; x.y;"), /Cannot read properties of null/);
  });

  it("undefined のプロパティアクセスは TypeError", () => {
    assert.throws(() => evaluate("var x; x.y;"), /Cannot read properties of undefined/);
  });
});

describe("Evaluator - Step 3-4: クラス", () => {
  it("基本的なクラスが動く", () => {
    assert.equal(evaluate(`
      class Animal {
        constructor(name) {
          this.name = name;
        }
        speak() {
          return this.name + " makes a sound";
        }
      }
      var a = new Animal("Rex");
      a.speak();
    `), "Rex makes a sound");
  });

  it("extends で継承できる", () => {
    assert.equal(evaluate(`
      class Animal {
        constructor(name) {
          this.name = name;
        }
        speak() {
          return this.name + " makes a sound";
        }
      }
      class Dog extends Animal {
        constructor(name) {
          super(name);
        }
        speak() {
          return this.name + " barks";
        }
      }
      var d = new Dog("Rex");
      d.speak();
    `), "Rex barks");
  });

  it("super() で親コンストラクタを呼べる", () => {
    assert.equal(evaluate(`
      class Base {
        constructor(x) {
          this.x = x;
        }
      }
      class Child extends Base {
        constructor(x, y) {
          super(x);
          this.y = y;
        }
      }
      var c = new Child(10, 20);
      c.x + c.y;
    `), 30);
  });

  it("親クラスのメソッドを継承する", () => {
    assert.equal(evaluate(`
      class Base {
        hello() { return "hi"; }
      }
      class Child extends Base {
        constructor() { super(); }
      }
      var c = new Child();
      c.hello();
    `), "hi");
  });

  it("constructor なしのクラスが動く", () => {
    assert.equal(evaluate(`
      class Foo {
        greet() { return "hello"; }
      }
      var f = new Foo();
      f.greet();
    `), "hello");
  });

  it("constructor なしの extends が動く", () => {
    assert.equal(evaluate(`
      class Base {
        constructor(x) { this.x = x; }
      }
      class Child extends Base {}
      var c = new Child(42);
      c.x;
    `), 42);
  });

  it("class を new なしで呼ぶと TypeError", () => {
    assert.throws(() => evaluate(`
      class Foo {}
      Foo();
    `), /cannot be invoked without 'new'/);
  });
});

describe("Evaluator - Step 3-5: 分割代入", () => {
  it("オブジェクトの分割代入ができる", () => {
    assert.equal(evaluate(`
      var { x, y } = { x: 10, y: 20 };
      x + y;
    `), 30);
  });

  it("配列の分割代入ができる", () => {
    assert.equal(evaluate(`
      var [a, b, c] = [1, 2, 3];
      a + b + c;
    `), 6);
  });

  it("let でオブジェクト分割代入ができる", () => {
    assert.equal(evaluate(`
      let { x } = { x: 42 };
      x;
    `), 42);
  });

  it("const で配列分割代入ができる", () => {
    assert.equal(evaluate(`
      const [a, b] = [10, 20];
      a + b;
    `), 30);
  });

  it("分割代入で存在しないプロパティは undefined", () => {
    assert.equal(evaluate(`
      var { x, y } = { x: 10 };
      y;
    `), undefined);
  });

  it("配列の分割代入で要素が足りない場合は undefined", () => {
    assert.equal(evaluate(`
      var [a, b, c] = [1, 2];
      c;
    `), undefined);
  });

  it("ネストしたオブジェクト分割代入ができる", () => {
    assert.equal(evaluate(`
      var { a: { b } } = { a: { b: 42 } };
      b;
    `), 42);
  });

  it("関数引数でオブジェクト分割代入ができる", () => {
    assert.equal(evaluate(`
      function add({ x, y }) {
        return x + y;
      }
      add({ x: 3, y: 4 });
    `), 7);
  });

  it("関数引数で配列分割代入ができる", () => {
    assert.equal(evaluate(`
      function first([a]) {
        return a;
      }
      first([99, 100]);
    `), 99);
  });

  it("代入式でのオブジェクト分割代入ができる", () => {
    assert.equal(evaluate(`
      var a;
      var b;
      ({ a, b } = { a: 10, b: 20 });
      a + b;
    `), 30);
  });

  it("代入式での配列分割代入ができる", () => {
    assert.equal(evaluate(`
      var a;
      var b;
      [a, b] = [10, 20];
      a + b;
    `), 30);
  });
});

describe("Evaluator - Step 3-6: スプレッド / レスト", () => {
  it("配列スプレッドが動く", () => {
    assert.equal(evaluate(`
      var arr = [1, 2, 3];
      var arr2 = [0, ...arr, 4];
      arr2.length;
    `), 5);
  });

  it("配列スプレッドの値が正しい", () => {
    assert.equal(evaluate(`
      var arr = [1, 2, 3];
      var arr2 = [0, ...arr, 4];
      arr2[0] + arr2[1] + arr2[4];
    `), 5);
  });

  it("関数呼び出しでスプレッドが動く", () => {
    assert.equal(evaluate(`
      function add(a, b, c) { return a + b + c; }
      var args = [1, 2, 3];
      add(...args);
    `), 6);
  });

  it("レストパラメータが動く", () => {
    assert.equal(evaluate(`
      function sum(a, ...rest) {
        var total = a;
        for (var i = 0; i < rest.length; i = i + 1) {
          total = total + rest[i];
        }
        return total;
      }
      sum(1, 2, 3, 4);
    `), 10);
  });

  it("レストパラメータが配列を返す", () => {
    assert.equal(evaluate(`
      function f(a, ...rest) { return rest.length; }
      f(1, 2, 3);
    `), 2);
  });

  it("レストパラメータが余り引数なしなら空配列", () => {
    assert.equal(evaluate(`
      function f(a, ...rest) { return rest.length; }
      f(1);
    `), 0);
  });

  it("オブジェクトスプレッドが動く", () => {
    assert.equal(evaluate(`
      var a = { x: 1 };
      var b = { ...a, y: 2 };
      b.x + b.y;
    `), 3);
  });

  it("オブジェクトスプレッドで上書きが動く", () => {
    assert.equal(evaluate(`
      var a = { x: 1, y: 2 };
      var b = { ...a, y: 99 };
      b.y;
    `), 99);
  });

  it("rest パラメータが末尾でないとエラー", () => {
    assert.throws(() => evaluate(`
      function f(...a, b) {}
    `), /Rest parameter must be last/);
  });
});

describe("Evaluator - Step 3-7: for...of", () => {
  it("配列の for...of が動く", () => {
    assert.equal(evaluate(`
      var sum = 0;
      for (var x of [10, 20, 30]) {
        sum = sum + x;
      }
      sum;
    `), 60);
  });

  it("let を使った for...of が動く", () => {
    assert.equal(evaluate(`
      var sum = 0;
      var arr = [1, 2, 3];
      for (let x of arr) {
        sum = sum + x;
      }
      sum;
    `), 6);
  });

  it("for...of の変数はループ外からアクセスできない (let)", () => {
    assert.throws(() => evaluate(`
      for (let x of [1, 2]) {}
      x;
    `), /not defined/);
  });

  it("for...of で var はスコープを貫通する", () => {
    assert.equal(evaluate(`
      for (var x of [1, 2, 3]) {}
      x;
    `), 3);
  });

  it("const を使った for...of が動く", () => {
    assert.equal(evaluate(`
      var sum = 0;
      for (const x of [1, 2, 3]) {
        sum = sum + x;
      }
      sum;
    `), 6);
  });

  it("const の for...of でループ変数に再代入するとエラー", () => {
    assert.throws(() => evaluate(`
      for (const x of [1, 2, 3]) {
        x = 99;
      }
    `), /Assignment to constant/);
  });

  it("空配列の for...of は body を実行しない", () => {
    assert.equal(evaluate(`
      var count = 0;
      for (var x of []) {
        count = count + 1;
      }
      count;
    `), 0);
  });

  it("for...of で分割代入が動く", () => {
    assert.equal(evaluate(`
      var result = 0;
      var pairs = [[1, 2], [3, 4]];
      for (var [a, b] of pairs) {
        result = result + a + b;
      }
      result;
    `), 10);
  });
});
