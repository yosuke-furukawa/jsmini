import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "./lexer.js";

describe("Lexer - Step 1-1: 数値リテラルと四則演算", () => {
  it("単一の数値リテラルをトークン化できる", () => {
    const tokens = tokenize("42");
    assert.equal(tokens.length, 2); // Number, EOF
    assert.equal(tokens[0].type, "Number");
    assert.equal(tokens[0].value, "42");
    assert.equal(tokens[1].type, "EOF");
  });

  it("四則演算子をトークン化できる", () => {
    const tokens = tokenize("1 + 2");
    assert.equal(tokens.length, 4); // Number, Plus, Number, EOF
    assert.equal(tokens[0].type, "Number");
    assert.equal(tokens[0].value, "1");
    assert.equal(tokens[1].type, "Plus");
    assert.equal(tokens[2].type, "Number");
    assert.equal(tokens[2].value, "2");
    assert.equal(tokens[3].type, "EOF");
  });

  it("全ての算術演算子を認識できる", () => {
    const tokens = tokenize("+ - * / %");
    assert.equal(tokens[0].type, "Plus");
    assert.equal(tokens[1].type, "Minus");
    assert.equal(tokens[2].type, "Star");
    assert.equal(tokens[3].type, "Slash");
    assert.equal(tokens[4].type, "Percent");
  });

  it("括弧をトークン化できる", () => {
    const tokens = tokenize("(1 + 2)");
    assert.equal(tokens[0].type, "LeftParen");
    assert.equal(tokens[1].type, "Number");
    assert.equal(tokens[2].type, "Plus");
    assert.equal(tokens[3].type, "Number");
    assert.equal(tokens[4].type, "RightParen");
  });

  it("セミコロンをトークン化できる", () => {
    const tokens = tokenize("1 + 2;");
    assert.equal(tokens[tokens.length - 2].type, "Semicolon");
  });

  it("空白と改行をスキップする", () => {
    const tokens = tokenize("  1  +  2  \n  *  3  ");
    const types = tokens.map((t) => t.type);
    assert.deepEqual(types, [
      "Number",
      "Plus",
      "Number",
      "Star",
      "Number",
      "EOF",
    ]);
  });

  it("複数桁の数値を認識できる", () => {
    const tokens = tokenize("123 + 456");
    assert.equal(tokens[0].value, "123");
    assert.equal(tokens[2].value, "456");
  });

  it("小数を認識できる", () => {
    const tokens = tokenize("3.14");
    assert.equal(tokens[0].type, "Number");
    assert.equal(tokens[0].value, "3.14");
  });
});

describe("Lexer - Step 1-2: var と変数参照", () => {
  it("識別子をトークン化できる", () => {
    const tokens = tokenize("x");
    assert.equal(tokens[0].type, "Identifier");
    assert.equal(tokens[0].value, "x");
  });

  it("var キーワードを認識できる", () => {
    const tokens = tokenize("var x = 10;");
    assert.equal(tokens[0].type, "Var");
    assert.equal(tokens[0].value, "var");
    assert.equal(tokens[1].type, "Identifier");
    assert.equal(tokens[1].value, "x");
    assert.equal(tokens[2].type, "Equals");
    assert.equal(tokens[3].type, "Number");
    assert.equal(tokens[3].value, "10");
    assert.equal(tokens[4].type, "Semicolon");
  });

  it("複数文字の識別子を認識できる", () => {
    const tokens = tokenize("myVar");
    assert.equal(tokens[0].type, "Identifier");
    assert.equal(tokens[0].value, "myVar");
  });

  it("アンダースコア始まりの識別子を認識できる", () => {
    const tokens = tokenize("_foo");
    assert.equal(tokens[0].type, "Identifier");
    assert.equal(tokens[0].value, "_foo");
  });

  it("数字を含む識別子を認識できる", () => {
    const tokens = tokenize("x1");
    assert.equal(tokens[0].type, "Identifier");
    assert.equal(tokens[0].value, "x1");
  });
});

describe("Lexer - Step 1-3: 比較・論理演算 + if/else", () => {
  it("比較演算子を認識できる", () => {
    const tokens = tokenize("< > <= >= == === != !==");
    assert.equal(tokens[0].type, "Less");
    assert.equal(tokens[1].type, "Greater");
    assert.equal(tokens[2].type, "LessEqual");
    assert.equal(tokens[3].type, "GreaterEqual");
    assert.equal(tokens[4].type, "EqualEqual");
    assert.equal(tokens[5].type, "EqualEqualEqual");
    assert.equal(tokens[6].type, "BangEqual");
    assert.equal(tokens[7].type, "BangEqualEqual");
  });

  it("論理演算子を認識できる", () => {
    const tokens = tokenize("&& || !");
    assert.equal(tokens[0].type, "AmpersandAmpersand");
    assert.equal(tokens[1].type, "PipePipe");
    assert.equal(tokens[2].type, "Bang");
  });

  it("波括弧を認識できる", () => {
    const tokens = tokenize("{ }");
    assert.equal(tokens[0].type, "LeftBrace");
    assert.equal(tokens[1].type, "RightBrace");
  });

  it("if/else キーワードを認識できる", () => {
    const tokens = tokenize("if else");
    assert.equal(tokens[0].type, "If");
    assert.equal(tokens[1].type, "Else");
  });

  it("true/false/null キーワードを認識できる", () => {
    const tokens = tokenize("true false null");
    assert.equal(tokens[0].type, "True");
    assert.equal(tokens[1].type, "False");
    assert.equal(tokens[2].type, "Null");
  });

  it("undefined は予約語ではなく識別子として扱う", () => {
    const tokens = tokenize("undefined");
    assert.equal(tokens[0].type, "Identifier");
    assert.equal(tokens[0].value, "undefined");
  });
});

describe("Lexer - コメント", () => {
  it("単行コメントをスキップする", () => {
    const tokens = tokenize("1 + 2; // this is a comment");
    assert.equal(tokens.length, 5); // Number, Plus, Number, Semicolon, EOF
    assert.equal(tokens[0].type, "Number");
    assert.equal(tokens[3].type, "Semicolon");
    assert.equal(tokens[4].type, "EOF");
  });

  it("単行コメントだけの行をスキップする", () => {
    const tokens = tokenize("// comment\n1;");
    assert.equal(tokens.length, 3); // Number, Semicolon, EOF
    assert.equal(tokens[0].type, "Number");
    assert.equal(tokens[0].value, "1");
  });

  it("複数行コメントをスキップする", () => {
    const tokens = tokenize("1 + /* comment */ 2;");
    assert.equal(tokens.length, 5); // Number, Plus, Number, Semicolon, EOF
    assert.equal(tokens[0].value, "1");
    assert.equal(tokens[2].value, "2");
  });

  it("複数行にまたがるブロックコメントをスキップする", () => {
    const tokens = tokenize("1 + /*\n  multi\n  line\n*/ 2;");
    assert.equal(tokens.length, 5);
    assert.equal(tokens[2].value, "2");
  });

  it("コメントのみのソースは EOF だけになる", () => {
    const tokens = tokenize("// just a comment");
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].type, "EOF");
  });
});

describe("Lexer - Step 2-1: オブジェクトリテラル", () => {
  it("コロンをトークン化できる", () => {
    const tokens = tokenize("{ x: 10 }");
    assert.equal(tokens.length, 6);
    assert.equal(tokens[0].type, "LeftBrace");
    assert.equal(tokens[1].type, "Identifier");
    assert.equal(tokens[2].type, "Colon");
    assert.equal(tokens[3].type, "Number");
    assert.equal(tokens[4].type, "RightBrace");
    assert.equal(tokens[5].type, "EOF");
  });
});
