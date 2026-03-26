import type { Token, TokenType } from "../lexer/token.js";
import { tokenize } from "../lexer/lexer.js";
import type { Program, Expression, Statement } from "./ast.js";

export function parse(source: string): Program {
  const tokens = tokenize(source);
  let pos = 0;

  function current(): Token {
    return tokens[pos];
  }

  function eat(type: TokenType): Token {
    const token = current();
    if (token.type !== type) {
      throw new SyntaxError(
        `Expected ${type} but got ${token.type} at line ${token.line}, column ${token.column}`
      );
    }
    pos++;
    return token;
  }

  // Program = Statement*
  function parseProgram(): Program {
    const body: Statement[] = [];
    while (current().type !== "EOF") {
      body.push(parseStatement());
    }
    return { type: "Program", body };
  }

  function parseStatement(): Statement {
    if (current().type === "Var" || current().type === "Let" || current().type === "Const") {
      return parseVariableDeclaration();
    }
    if (current().type === "Function") return parseFunctionDeclaration();
    if (current().type === "Return") return parseReturnStatement();
    if (current().type === "Throw") return parseThrowStatement();
    if (current().type === "Try") return parseTryStatement();
    if (current().type === "If") return parseIfStatement();
    if (current().type === "While") return parseWhileStatement();
    if (current().type === "For") return parseForStatement();
    if (current().type === "LeftBrace") return parseBlockStatement();

    const expression = parseExpression();
    eat("Semicolon");
    return { type: "ExpressionStatement", expression };
  }

  // VariableDeclaration = ('var' | 'let' | 'const') Identifier ('=' Expression)? ';'
  function parseVariableDeclaration(): Statement {
    const kindToken = eat(current().type);
    const kind = kindToken.value as "var" | "let" | "const";
    const id = parseIdentifier();
    let init: Expression | null = null;
    if (current().type === "Equals") {
      eat("Equals");
      init = parseExpression();
    }
    if (kind === "const" && init === null) {
      throw new SyntaxError("Missing initializer in const declaration");
    }
    eat("Semicolon");
    return {
      type: "VariableDeclaration",
      declarations: [{ type: "VariableDeclarator", id, init }],
      kind,
    };
  }

  // FunctionDeclaration = 'function' Identifier '(' params ')' BlockStatement
  function parseFunctionDeclaration(): Statement {
    eat("Function");
    const id = parseIdentifier();
    eat("LeftParen");
    const params: { type: "Identifier"; name: string }[] = [];
    if (current().type !== "RightParen") {
      params.push(parseIdentifier());
      while (current().type === "Comma") {
        eat("Comma");
        params.push(parseIdentifier());
      }
    }
    eat("RightParen");
    const body = parseBlockStatement() as { type: "BlockStatement"; body: Statement[] };
    return { type: "FunctionDeclaration", id, params, body };
  }

  // ReturnStatement = 'return' Expression? ';'
  function parseReturnStatement(): Statement {
    eat("Return");
    let argument: Expression | null = null;
    if (current().type !== "Semicolon" && current().type !== "RightBrace") {
      argument = parseExpression();
    }
    if (current().type === "Semicolon") eat("Semicolon");
    return { type: "ReturnStatement", argument };
  }

  // ThrowStatement = 'throw' Expression ';'
  function parseThrowStatement(): Statement {
    eat("Throw");
    const argument = parseExpression();
    if (current().type === "Semicolon") eat("Semicolon");
    return { type: "ThrowStatement", argument };
  }

  // TryStatement = 'try' Block ('catch' '(' Identifier ')' Block)? ('finally' Block)?
  function parseTryStatement(): Statement {
    eat("Try");
    const block = parseBlockStatement() as { type: "BlockStatement"; body: Statement[] };

    let handler: { type: "CatchClause"; param: { type: "Identifier"; name: string }; body: { type: "BlockStatement"; body: Statement[] } } | null = null;
    if (current().type === "Catch") {
      eat("Catch");
      eat("LeftParen");
      const param = parseIdentifier();
      eat("RightParen");
      const body = parseBlockStatement() as { type: "BlockStatement"; body: Statement[] };
      handler = { type: "CatchClause", param, body };
    }

    let finalizer: { type: "BlockStatement"; body: Statement[] } | null = null;
    if (current().type === "Finally") {
      eat("Finally");
      finalizer = parseBlockStatement() as { type: "BlockStatement"; body: Statement[] };
    }

    if (!handler && !finalizer) {
      throw new SyntaxError("Missing catch or finally after try");
    }
    return { type: "TryStatement", block, handler, finalizer };
  }

  // IfStatement = 'if' '(' Expression ')' Statement ('else' Statement)?
  function parseIfStatement(): Statement {
    eat("If");
    eat("LeftParen");
    const test = parseExpression();
    eat("RightParen");
    const consequent = parseStatement();
    let alternate: Statement | null = null;
    if (current().type === "Else") {
      eat("Else");
      alternate = parseStatement();
    }
    return { type: "IfStatement", test, consequent, alternate };
  }

  // WhileStatement = 'while' '(' Expression ')' Statement
  function parseWhileStatement(): Statement {
    eat("While");
    eat("LeftParen");
    const test = parseExpression();
    eat("RightParen");
    const body = parseStatement();
    return { type: "WhileStatement", test, body };
  }

  // ForStatement = 'for' '(' (var decl | expr | ε) ';' expr? ';' expr? ')' Statement
  function parseForStatement(): Statement {
    eat("For");
    eat("LeftParen");

    // init
    let init: any = null;
    if (current().type === "Var" || current().type === "Let" || current().type === "Const") {
      init = parseVariableDeclaration(); // includes ';'
    } else if (current().type !== "Semicolon") {
      init = parseExpression();
      eat("Semicolon");
    } else {
      eat("Semicolon");
    }

    // test
    let test: Expression | null = null;
    if (current().type !== "Semicolon") {
      test = parseExpression();
    }
    eat("Semicolon");

    // update
    let update: Expression | null = null;
    if (current().type !== "RightParen") {
      update = parseExpression();
    }
    eat("RightParen");

    const body = parseStatement();
    return { type: "ForStatement", init, test, update, body };
  }

  // BlockStatement = '{' Statement* '}'
  function parseBlockStatement(): Statement {
    eat("LeftBrace");
    const body: Statement[] = [];
    while (current().type !== "RightBrace") {
      body.push(parseStatement());
    }
    eat("RightBrace");
    return { type: "BlockStatement", body };
  }

  function parseIdentifier() {
    const token = eat("Identifier");
    return { type: "Identifier" as const, name: token.value };
  }

  // Expression = Assignment
  function parseExpression(): Expression {
    return parseAssignment();
  }

  // Assignment = LogicalOr ('=' Assignment)?
  function parseAssignment(): Expression {
    const left = parseLogicalOr();
    if (current().type === "Equals") {
      eat("Equals");
      const right = parseAssignment();
      if (left.type !== "Identifier" && left.type !== "MemberExpression") {
        throw new SyntaxError("Invalid left-hand side in assignment");
      }
      return { type: "AssignmentExpression", operator: "=", left, right };
    }
    return left;
  }

  // LogicalOr = LogicalAnd ('||' LogicalAnd)*
  function parseLogicalOr(): Expression {
    let left = parseLogicalAnd();
    while (current().type === "PipePipe") {
      const operator = eat("PipePipe").value;
      const right = parseLogicalAnd();
      left = { type: "LogicalExpression", operator, left, right };
    }
    return left;
  }

  // LogicalAnd = Equality ('&&' Equality)*
  function parseLogicalAnd(): Expression {
    let left = parseEquality();
    while (current().type === "AmpersandAmpersand") {
      const operator = eat("AmpersandAmpersand").value;
      const right = parseEquality();
      left = { type: "LogicalExpression", operator, left, right };
    }
    return left;
  }

  // Equality = Comparison (('==' | '===' | '!=' | '!==') Comparison)*
  function parseEquality(): Expression {
    let left = parseComparison();
    while (
      current().type === "EqualEqual" ||
      current().type === "EqualEqualEqual" ||
      current().type === "BangEqual" ||
      current().type === "BangEqualEqual"
    ) {
      const operator = eat(current().type).value;
      const right = parseComparison();
      left = { type: "BinaryExpression", operator, left, right };
    }
    return left;
  }

  // Comparison = Additive (('<' | '>' | '<=' | '>=') Additive)*
  function parseComparison(): Expression {
    let left = parseAdditive();
    while (
      current().type === "Less" ||
      current().type === "Greater" ||
      current().type === "LessEqual" ||
      current().type === "GreaterEqual"
    ) {
      const operator = eat(current().type).value;
      const right = parseAdditive();
      left = { type: "BinaryExpression", operator, left, right };
    }
    return left;
  }

  // Additive = Multiplicative (('+' | '-') Multiplicative)*
  function parseAdditive(): Expression {
    let left = parseMultiplicative();
    while (current().type === "Plus" || current().type === "Minus") {
      const operator = eat(current().type).value;
      const right = parseMultiplicative();
      left = { type: "BinaryExpression", operator, left, right };
    }
    return left;
  }

  // Multiplicative = Unary (('*' | '/' | '%') Unary)*
  function parseMultiplicative(): Expression {
    let left = parseUnary();
    while (
      current().type === "Star" ||
      current().type === "Slash" ||
      current().type === "Percent"
    ) {
      const operator = eat(current().type).value;
      const right = parseUnary();
      left = { type: "BinaryExpression", operator, left, right };
    }
    return left;
  }

  // Unary = ('!' | '-' | 'typeof') Unary | CallExpression
  function parseUnary(): Expression {
    if (current().type === "Bang") {
      const operator = eat("Bang").value;
      const argument = parseUnary();
      return { type: "UnaryExpression", operator, prefix: true, argument };
    }
    if (current().type === "Minus") {
      const operator = eat("Minus").value;
      const argument = parseUnary();
      return { type: "UnaryExpression", operator, prefix: true, argument };
    }
    if (current().type === "Typeof") {
      const operator = eat("Typeof").value;
      const argument = parseUnary();
      return { type: "UnaryExpression", operator, prefix: true, argument };
    }
    if (current().type === "New") {
      return parseNewExpression();
    }
    return parseCallExpression();
  }

  // NewExpression = 'new' Primary Arguments?
  function parseNewExpression(): Expression {
    eat("New");
    // callee は Primary のみ（MemberExpression チェーンはしない）
    const callee = parsePrimary();
    let args: Expression[] = [];
    if (current().type === "LeftParen") {
      eat("LeftParen");
      if (current().type !== "RightParen") {
        args.push(parseExpression());
        while (current().type === "Comma") {
          eat("Comma");
          args.push(parseExpression());
        }
      }
      eat("RightParen");
    }
    return { type: "NewExpression", callee, arguments: args };
  }

  // CallExpression = Primary (('(' Arguments ')') | ('.' Identifier) | ('[' Expression ']'))*
  function parseCallExpression(): Expression {
    let expr = parsePrimary();
    while (true) {
      if (current().type === "LeftParen") {
        eat("LeftParen");
        const args: Expression[] = [];
        if (current().type !== "RightParen") {
          args.push(parseExpression());
          while (current().type === "Comma") {
            eat("Comma");
            args.push(parseExpression());
          }
        }
        eat("RightParen");
        expr = { type: "CallExpression", callee: expr, arguments: args };
      } else if (current().type === "Dot") {
        eat("Dot");
        const property = parseIdentifier();
        expr = { type: "MemberExpression", object: expr, property, computed: false };
      } else if (current().type === "LeftBracket") {
        eat("LeftBracket");
        const property = parseExpression();
        eat("RightBracket");
        expr = { type: "MemberExpression", object: expr, property, computed: true };
      } else {
        break;
      }
    }
    return expr;
  }

  // Primary = Literal | Identifier | ObjectExpression | '(' Expression ')'
  function parsePrimary(): Expression {
    const token = current();
    switch (token.type) {
      case "Number":
        eat("Number");
        return { type: "Literal", value: Number(token.value) };
      case "String":
        eat("String");
        return { type: "Literal", value: token.value };
      case "True":
        eat("True");
        return { type: "Literal", value: true };
      case "False":
        eat("False");
        return { type: "Literal", value: false };
      case "Null":
        eat("Null");
        return { type: "Literal", value: null };
      case "Identifier":
        eat("Identifier");
        return { type: "Identifier", name: token.value };
      case "This":
        eat("This");
        return { type: "ThisExpression" };
      case "Function":
        return parseFunctionExpression();
      case "LeftBrace":
        return parseObjectExpression();
      case "LeftBracket":
        return parseArrayExpression();
      case "LeftParen": {
        eat("LeftParen");
        const expr = parseExpression();
        eat("RightParen");
        return expr;
      }
      default:
        throw new SyntaxError(
          `Unexpected token ${token.type} at line ${token.line}, column ${token.column}`
        );
    }
  }

  // FunctionExpression = 'function' Identifier? '(' params ')' BlockStatement
  function parseFunctionExpression(): Expression {
    eat("Function");
    let id: { type: "Identifier"; name: string } | null = null;
    if (current().type === "Identifier") {
      id = parseIdentifier();
    }
    eat("LeftParen");
    const params: { type: "Identifier"; name: string }[] = [];
    if (current().type !== "RightParen") {
      params.push(parseIdentifier());
      while (current().type === "Comma") {
        eat("Comma");
        params.push(parseIdentifier());
      }
    }
    eat("RightParen");
    const body = parseBlockStatement() as { type: "BlockStatement"; body: Statement[] };
    return { type: "FunctionExpression", id, params, body };
  }

  // ObjectExpression = '{' (Property (',' Property)*)? '}'
  function parseObjectExpression(): Expression {
    eat("LeftBrace");
    const properties: { type: "Property"; key: any; value: Expression; kind: "init" }[] = [];
    while (current().type !== "RightBrace") {
      let key: { type: "Identifier"; name: string } | { type: "Literal"; value: string | number };
      if (current().type === "Identifier") {
        const t = eat("Identifier");
        key = { type: "Identifier", name: t.value };
      } else if (current().type === "String") {
        const t = eat("String");
        key = { type: "Literal", value: t.value };
      } else if (current().type === "Number") {
        const t = eat("Number");
        key = { type: "Literal", value: Number(t.value) };
      } else {
        throw new SyntaxError(
          `Unexpected token ${current().type} as object key at line ${current().line}, column ${current().column}`
        );
      }
      eat("Colon");
      const value = parseExpression();
      properties.push({ type: "Property", key, value, kind: "init" });
      if (current().type === "Comma") {
        eat("Comma");
      }
    }
    eat("RightBrace");
    return { type: "ObjectExpression", properties };
  }

  // ArrayExpression = '[' (Expression (',' Expression)* ','?)? ']'
  function parseArrayExpression(): Expression {
    eat("LeftBracket");
    const elements: Expression[] = [];
    if (current().type !== "RightBracket") {
      elements.push(parseExpression());
      while (current().type === "Comma") {
        eat("Comma");
        if (current().type === "RightBracket") break; // trailing comma
        elements.push(parseExpression());
      }
    }
    eat("RightBracket");
    return { type: "ArrayExpression", elements };
  }

  return parseProgram();
}
