import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "./parser.js";

describe("Parser - Step 1-1: 数値リテラルと四則演算", () => {
  it("数値リテラルをパースできる", () => {
    const ast = parse("42;");
    assert.equal(ast.type, "Program");
    assert.equal(ast.body.length, 1);
    const stmt = ast.body[0];
    assert.equal(stmt.type, "ExpressionStatement");
    assert.equal(stmt.expression.type, "Literal");
    assert.equal(stmt.expression.value, 42);
  });

  it("加算をパースできる", () => {
    const ast = parse("1 + 2;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "BinaryExpression");
    assert.equal(expr.operator, "+");
    assert.equal(expr.left.type, "Literal");
    assert.equal(expr.left.value, 1);
    assert.equal(expr.right.type, "Literal");
    assert.equal(expr.right.value, 2);
  });

  it("演算子優先順位: * は + より優先される", () => {
    const ast = parse("1 + 2 * 3;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "BinaryExpression");
    assert.equal(expr.operator, "+");
    assert.equal(expr.left.value, 1);
    assert.equal(expr.right.type, "BinaryExpression");
    assert.equal(expr.right.operator, "*");
    assert.equal(expr.right.left.value, 2);
    assert.equal(expr.right.right.value, 3);
  });

  it("括弧でグループ化できる", () => {
    const ast = parse("(1 + 2) * 3;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "BinaryExpression");
    assert.equal(expr.operator, "*");
    assert.equal(expr.left.type, "BinaryExpression");
    assert.equal(expr.left.operator, "+");
    assert.equal(expr.right.value, 3);
  });

  it("複数の文をパースできる", () => {
    const ast = parse("1 + 2; 3 * 4;");
    assert.equal(ast.body.length, 2);
  });
});

describe("Parser - Step 1-2: var と変数参照", () => {
  it("var 宣言をパースできる", () => {
    const ast = parse("var x = 10;");
    const stmt = ast.body[0];
    assert.equal(stmt.type, "VariableDeclaration");
    assert.equal(stmt.declarations.length, 1);
    assert.equal(stmt.declarations[0].id.type, "Identifier");
    assert.equal(stmt.declarations[0].id.name, "x");
    assert.equal(stmt.declarations[0].init.type, "Literal");
    assert.equal(stmt.declarations[0].init.value, 10);
  });

  it("識別子を式としてパースできる", () => {
    const ast = parse("x;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "Identifier");
    assert.equal(expr.name, "x");
  });

  it("変数を含む演算をパースできる", () => {
    const ast = parse("x + 5;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "BinaryExpression");
    assert.equal(expr.left.type, "Identifier");
    assert.equal(expr.left.name, "x");
    assert.equal(expr.right.value, 5);
  });

  it("代入式をパースできる", () => {
    const ast = parse("x = 20;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "AssignmentExpression");
    assert.equal(expr.operator, "=");
    assert.equal(expr.left.type, "Identifier");
    assert.equal(expr.left.name, "x");
    assert.equal(expr.right.value, 20);
  });

  it("初期化なしの var 宣言をパースできる", () => {
    const ast = parse("var x;");
    const stmt = ast.body[0];
    assert.equal(stmt.type, "VariableDeclaration");
    assert.equal(stmt.declarations[0].init, null);
  });
});

describe("Parser - Step 1-3: 比較・論理演算 + if/else", () => {
  it("比較演算をパースできる", () => {
    const ast = parse("1 < 2;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "BinaryExpression");
    assert.equal(expr.operator, "<");
  });

  it("等価演算をパースできる", () => {
    const ast = parse("x === 10;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "BinaryExpression");
    assert.equal(expr.operator, "===");
  });

  it("論理AND をパースできる", () => {
    const ast = parse("true && false;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "LogicalExpression");
    assert.equal(expr.operator, "&&");
  });

  it("論理OR をパースできる", () => {
    const ast = parse("true || false;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "LogicalExpression");
    assert.equal(expr.operator, "||");
  });

  it("単項 ! をパースできる", () => {
    const ast = parse("!true;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "UnaryExpression");
    assert.equal(expr.operator, "!");
    assert.equal(expr.argument.type, "Literal");
    assert.equal(expr.argument.value, true);
  });

  it("if 文をパースできる", () => {
    const ast = parse("if (x > 5) { var y = 1; }");
    const stmt = ast.body[0];
    assert.equal(stmt.type, "IfStatement");
    assert.equal(stmt.test.type, "BinaryExpression");
    assert.equal(stmt.consequent.type, "BlockStatement");
    assert.equal(stmt.alternate, null);
  });

  it("if/else 文をパースできる", () => {
    const ast = parse("if (x > 5) { var y = 1; } else { var y = 0; }");
    const stmt = ast.body[0];
    assert.equal(stmt.type, "IfStatement");
    assert.notEqual(stmt.alternate, null);
    assert.equal(stmt.alternate.type, "BlockStatement");
  });

  it("boolean リテラルをパースできる", () => {
    const ast = parse("true;");
    assert.equal(ast.body[0].expression.type, "Literal");
    assert.equal(ast.body[0].expression.value, true);
  });

  it("null リテラルをパースできる", () => {
    const ast = parse("null;");
    assert.equal(ast.body[0].expression.type, "Literal");
    assert.equal(ast.body[0].expression.value, null);
  });

  it("演算子優先順位: 比較 > 等価 > AND > OR", () => {
    const ast = parse("true || false && 1 == 2;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "LogicalExpression");
    assert.equal(expr.operator, "||");
    assert.equal(expr.right.type, "LogicalExpression");
    assert.equal(expr.right.operator, "&&");
  });
});

describe("Parser - Step 1-4: while / for", () => {
  it("while 文をパースできる", () => {
    const ast = parse("while (x < 10) { x = x + 1; }");
    const stmt = ast.body[0];
    assert.equal(stmt.type, "WhileStatement");
    assert.equal(stmt.test.type, "BinaryExpression");
    assert.equal(stmt.body.type, "BlockStatement");
  });

  it("for 文をパースできる", () => {
    const ast = parse("for (var i = 0; i < 10; i = i + 1) { x = x + 1; }");
    const stmt = ast.body[0];
    assert.equal(stmt.type, "ForStatement");
    assert.equal(stmt.init.type, "VariableDeclaration");
    assert.equal(stmt.test.type, "BinaryExpression");
    assert.equal(stmt.update.type, "AssignmentExpression");
    assert.equal(stmt.body.type, "BlockStatement");
  });

  it("for の init が式文でもパースできる", () => {
    const ast = parse("for (i = 0; i < 10; i = i + 1) {}");
    const stmt = ast.body[0];
    assert.equal(stmt.type, "ForStatement");
    assert.equal(stmt.init.type, "AssignmentExpression");
  });
});

describe("Parser - Step 1-5: 関数宣言・呼び出し・return", () => {
  it("関数宣言をパースできる", () => {
    const ast = parse("function add(a, b) { return a + b; }");
    const stmt = ast.body[0];
    assert.equal(stmt.type, "FunctionDeclaration");
    assert.equal(stmt.id.name, "add");
    assert.equal(stmt.params.length, 2);
    assert.equal(stmt.params[0].name, "a");
    assert.equal(stmt.params[1].name, "b");
    assert.equal(stmt.body.type, "BlockStatement");
  });

  it("関数呼び出しをパースできる", () => {
    const ast = parse("add(1, 2);");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "CallExpression");
    assert.equal(expr.callee.type, "Identifier");
    assert.equal(expr.callee.name, "add");
    assert.equal(expr.arguments.length, 2);
  });

  it("引数なしの関数呼び出しをパースできる", () => {
    const ast = parse("foo();");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "CallExpression");
    assert.equal(expr.arguments.length, 0);
  });

  it("return 文をパースできる", () => {
    const ast = parse("function foo() { return 42; }");
    const body = ast.body[0].body;
    assert.equal(body.body[0].type, "ReturnStatement");
    assert.equal(body.body[0].argument.type, "Literal");
    assert.equal(body.body[0].argument.value, 42);
  });

  it("return 値なしをパースできる", () => {
    const ast = parse("function foo() { return; }");
    const body = ast.body[0].body;
    assert.equal(body.body[0].type, "ReturnStatement");
    assert.equal(body.body[0].argument, null);
  });
});

describe("Parser - Step 1-6: 文字列リテラル + console.log", () => {
  it("文字列リテラルをパースできる", () => {
    const ast = parse('"hello";');
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "Literal");
    assert.equal(expr.value, "hello");
  });

  it("MemberExpression をパースできる", () => {
    const ast = parse("console.log;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "MemberExpression");
    assert.equal(expr.object.type, "Identifier");
    assert.equal(expr.object.name, "console");
    assert.equal(expr.property.name, "log");
  });

  it("MemberExpression + CallExpression をパースできる", () => {
    const ast = parse('console.log("hello");');
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "CallExpression");
    assert.equal(expr.callee.type, "MemberExpression");
  });
});

describe("Parser - Step 2-1: オブジェクトリテラル", () => {
  it("空のオブジェクトリテラルをパースできる", () => {
    const ast = parse("var x = {};");
    const init = ast.body[0].declarations[0].init;
    assert.equal(init.type, "ObjectExpression");
    assert.equal(init.properties.length, 0);
  });

  it("プロパティ付きオブジェクトリテラルをパースできる", () => {
    const ast = parse("var p = { x: 10, y: 20 };");
    const init = ast.body[0].declarations[0].init;
    assert.equal(init.type, "ObjectExpression");
    assert.equal(init.properties.length, 2);
    assert.equal(init.properties[0].type, "Property");
    assert.equal(init.properties[0].key.name, "x");
    assert.equal(init.properties[0].value.value, 10);
    assert.equal(init.properties[1].key.name, "y");
  });

  it("ブラケット記法をパースできる", () => {
    const ast = parse('obj["x"];');
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "MemberExpression");
    assert.equal(expr.computed, true);
    assert.equal(expr.property.type, "Literal");
    assert.equal(expr.property.value, "x");
  });

  it("MemberExpression への代入をパースできる", () => {
    const ast = parse("obj.x = 10;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "AssignmentExpression");
    assert.equal(expr.left.type, "MemberExpression");
    assert.equal(expr.left.object.name, "obj");
    assert.equal(expr.left.property.name, "x");
    assert.equal(expr.right.value, 10);
  });

  it("ブラケット記法への代入をパースできる", () => {
    const ast = parse('obj["x"] = 10;');
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "AssignmentExpression");
    assert.equal(expr.left.type, "MemberExpression");
    assert.equal(expr.left.computed, true);
  });

  it("数値キーのオブジェクトをパースできる", () => {
    const ast = parse("var x = { 0: 10, 1: 20 };");
    const init = ast.body[0].declarations[0].init;
    assert.equal(init.type, "ObjectExpression");
    assert.equal(init.properties[0].key.type, "Literal");
    assert.equal(init.properties[0].key.value, 0);
    assert.equal(init.properties[1].key.value, 1);
  });

  it("trailing comma があってもパースできる", () => {
    const ast = parse("var x = { a: 1, b: 2, };");
    const init = ast.body[0].declarations[0].init;
    assert.equal(init.type, "ObjectExpression");
    assert.equal(init.properties.length, 2);
  });
});

describe("Parser - Step 2-2: 配列", () => {
  it("配列リテラルをパースできる", () => {
    const ast = parse("var x = [1, 2, 3];");
    const init = ast.body[0].declarations[0].init;
    assert.equal(init.type, "ArrayExpression");
    assert.equal(init.elements.length, 3);
    assert.equal(init.elements[0].value, 1);
    assert.equal(init.elements[2].value, 3);
  });

  it("空配列をパースできる", () => {
    const ast = parse("var x = [];");
    const init = ast.body[0].declarations[0].init;
    assert.equal(init.type, "ArrayExpression");
    assert.equal(init.elements.length, 0);
  });

  it("trailing comma の配列をパースできる", () => {
    const ast = parse("var x = [1, 2,];");
    const init = ast.body[0].declarations[0].init;
    assert.equal(init.type, "ArrayExpression");
    assert.equal(init.elements.length, 2);
  });

  it("カンマなしの配列はエラーになる", () => {
    assert.throws(() => parse("var x = [1 2];"), /Expected/);
  });
});

describe("Parser - Statement vs Declaration", () => {
  it("if の body に var は書ける", () => {
    assert.doesNotThrow(() => parse("if (true) var x = 1;"));
  });

  it("if の body に let は書けない", () => {
    assert.throws(() => parse("if (true) let x = 1;"), /not allowed/);
  });

  it("if の body に const は書けない", () => {
    assert.throws(() => parse("if (true) const x = 1;"), /not allowed/);
  });

  it("if のブロック内なら let は書ける", () => {
    assert.doesNotThrow(() => parse("if (true) { let x = 1; }"));
  });

  it("while の body に let は書けない", () => {
    assert.throws(() => parse("while (true) let x = 1;"), /not allowed/);
  });

  it("for の body に const は書けない", () => {
    assert.throws(() => parse("for (var i = 0; i < 1; i = i + 1) const x = 1;"), /not allowed/);
  });

  it("トップレベルで let / const は書ける", () => {
    assert.doesNotThrow(() => parse("let x = 1; const y = 2;"));
  });
});

describe("Parser - Step 3: アロー関数", () => {
  it("アロー関数（式本体）をパースできる", () => {
    const ast = parse("var f = (a, b) => a + b;");
    const init = ast.body[0].declarations[0].init;
    assert.equal(init.type, "ArrowFunctionExpression");
    assert.equal(init.expression, true);
    assert.equal(init.params.length, 2);
  });

  it("アロー関数（ブロック本体）をパースできる", () => {
    const ast = parse("var f = (a) => { return a; };");
    const init = ast.body[0].declarations[0].init;
    assert.equal(init.type, "ArrowFunctionExpression");
    assert.equal(init.expression, false);
  });

  it("単一引数アローをパースできる", () => {
    const ast = parse("var f = a => a;");
    const init = ast.body[0].declarations[0].init;
    assert.equal(init.type, "ArrowFunctionExpression");
    assert.equal(init.params.length, 1);
  });

  it("引数なしアローをパースできる", () => {
    const ast = parse("var f = () => 42;");
    const init = ast.body[0].declarations[0].init;
    assert.equal(init.type, "ArrowFunctionExpression");
    assert.equal(init.params.length, 0);
  });
});

describe("Parser - Step 3: テンプレートリテラル", () => {
  it("式埋め込みなしをパースできる", () => {
    const ast = parse("`hello`;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "TemplateLiteral");
    assert.equal(expr.quasis.length, 1);
    assert.equal(expr.expressions.length, 0);
    assert.equal(expr.quasis[0].value.cooked, "hello");
  });

  it("式埋め込みありをパースできる", () => {
    const ast = parse("`a ${x} b`;");
    const expr = ast.body[0].expression;
    assert.equal(expr.type, "TemplateLiteral");
    assert.equal(expr.quasis.length, 2);
    assert.equal(expr.expressions.length, 1);
    assert.equal(expr.quasis[0].value.cooked, "a ");
    assert.equal(expr.quasis[1].value.cooked, " b");
  });
});

describe("Parser - Step 3: クラス", () => {
  it("基本的なクラスをパースできる", () => {
    const ast = parse("class Foo { constructor(x) { this.x = x; } greet() { return 1; } }");
    const stmt = ast.body[0];
    assert.equal(stmt.type, "ClassDeclaration");
    assert.equal(stmt.id.name, "Foo");
    assert.equal(stmt.body.body.length, 2);
    assert.equal(stmt.body.body[0].kind, "constructor");
    assert.equal(stmt.body.body[1].kind, "method");
  });

  it("extends をパースできる", () => {
    const ast = parse("class Bar extends Foo {}");
    const stmt = ast.body[0];
    assert.equal(stmt.type, "ClassDeclaration");
    assert.equal(stmt.superClass.type, "Identifier");
    assert.equal(stmt.superClass.name, "Foo");
  });
});

describe("Parser - Step 3: 分割代入", () => {
  it("オブジェクト分割代入をパースできる", () => {
    const ast = parse("var { x, y } = obj;");
    const id = ast.body[0].declarations[0].id;
    assert.equal(id.type, "ObjectPattern");
    assert.equal(id.properties.length, 2);
  });

  it("配列分割代入をパースできる", () => {
    const ast = parse("var [a, b] = arr;");
    const id = ast.body[0].declarations[0].id;
    assert.equal(id.type, "ArrayPattern");
    assert.equal(id.elements.length, 2);
  });
});

describe("Parser - Step 3: スプレッド / レスト", () => {
  it("配列スプレッドをパースできる", () => {
    const ast = parse("var x = [1, ...arr, 2];");
    const init = ast.body[0].declarations[0].init;
    assert.equal(init.type, "ArrayExpression");
    assert.equal(init.elements[1].type, "SpreadElement");
  });

  it("オブジェクトスプレッドをパースできる", () => {
    const ast = parse("var x = { ...a, y: 1 };");
    const init = ast.body[0].declarations[0].init;
    assert.equal(init.type, "ObjectExpression");
    assert.equal(init.properties[0].type, "SpreadElement");
  });

  it("レストパラメータをパースできる", () => {
    const ast = parse("function f(a, ...rest) {}");
    const params = ast.body[0].params;
    assert.equal(params.length, 2);
    assert.equal(params[1].type, "RestElement");
    assert.equal(params[1].argument.name, "rest");
  });
});

describe("Parser - Step 3: for...of", () => {
  it("for...of をパースできる", () => {
    const ast = parse("for (var x of arr) {}");
    const stmt = ast.body[0];
    assert.equal(stmt.type, "ForOfStatement");
    assert.equal(stmt.left.type, "VariableDeclaration");
    assert.equal(stmt.left.kind, "var");
    assert.equal(stmt.right.type, "Identifier");
  });

  it("for...of で let をパースできる", () => {
    const ast = parse("for (let x of arr) {}");
    const stmt = ast.body[0];
    assert.equal(stmt.type, "ForOfStatement");
    assert.equal(stmt.left.kind, "let");
  });

  it("for...of で分割代入をパースできる", () => {
    const ast = parse("for (var [a, b] of arr) {}");
    const stmt = ast.body[0];
    assert.equal(stmt.type, "ForOfStatement");
    assert.equal(stmt.left.declarations[0].id.type, "ArrayPattern");
  });
});
