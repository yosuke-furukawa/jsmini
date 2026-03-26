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
      body.push(parseStatementOrDeclaration());
    }
    return { type: "Program", body };
  }

  // Declaration = LexicalDeclaration (let/const) | FunctionDeclaration
  function isDeclarationStart(): boolean {
    return current().type === "Let" || current().type === "Const" || current().type === "Function" || current().type === "Class";
  }

  // Statement | Declaration — ブロック内やトップレベルで使う
  function parseStatementOrDeclaration(): Statement {
    if (isDeclarationStart()) {
      return parseDeclaration();
    }
    return parseStatement();
  }

  // Declaration のみ
  function parseDeclaration(): Statement {
    if (current().type === "Let" || current().type === "Const") {
      return parseVariableDeclaration();
    }
    if (current().type === "Function") return parseFunctionDeclaration();
    if (current().type === "Class") return parseClassDeclaration();
    throw new SyntaxError(
      `Unexpected token ${current().type} at line ${current().line}, column ${current().column}`
    );
  }

  // Statement のみ — if/while/for の body など、宣言が来てはいけない場所
  function parseStatement(): Statement {
    if (current().type === "Let" || current().type === "Const") {
      throw new SyntaxError(
        `Lexical declaration (${current().value}) not allowed in single-statement context`
      );
    }
    if (current().type === "Var") return parseVariableDeclaration();
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

  // VariableDeclaration = ('var' | 'let' | 'const') Pattern ('=' Expression)? ';'
  function parseVariableDeclaration(): Statement {
    const kindToken = eat(current().type);
    const kind = kindToken.value as "var" | "let" | "const";
    const id = parseBindingPattern();
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
    resetParamState();
    const params: { type: "Identifier"; name: string }[] = [];
    if (current().type !== "RightParen") {
      params.push(parseParam());
      while (current().type === "Comma") {
        eat("Comma");
        params.push(parseParam());
      }
    }
    eat("RightParen");
    const body = parseBlockStatement() as { type: "BlockStatement"; body: Statement[] };
    return { type: "FunctionDeclaration", id, params, body };
  }

  // ClassDeclaration = 'class' Identifier ('extends' Expression)? '{' MethodDefinition* '}'
  function parseClassDeclaration(): Statement {
    eat("Class");
    const id = parseIdentifier();

    let superClass: Expression | null = null;
    if (current().type === "Extends") {
      eat("Extends");
      superClass = parseAssignment();
    }

    eat("LeftBrace");
    const methods: any[] = [];
    while (current().type !== "RightBrace") {
      const key = parseIdentifier();
      eat("LeftParen");
      resetParamState();
      const params: any[] = [];
      if (current().type !== "RightParen") {
        params.push(parseParam());
        while (current().type === "Comma") {
          eat("Comma");
          params.push(parseParam());
        }
      }
      eat("RightParen");
      const body = parseBlockStatement() as { type: "BlockStatement"; body: Statement[] };

      const kind = key.name === "constructor" ? "constructor" : "method";
      methods.push({
        type: "MethodDefinition",
        key,
        value: { type: "FunctionExpression", id: null, params, body },
        kind,
        static: false,
      });
    }
    eat("RightBrace");

    return {
      type: "ClassDeclaration",
      id,
      superClass,
      body: { type: "ClassBody", body: methods },
    };
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

  // ForStatement or ForOfStatement
  function parseForStatement(): Statement {
    eat("For");
    eat("LeftParen");

    // for (var/let/const ...  of  expr) → ForOfStatement
    // for (var/let/const ... ;    ...) → ForStatement
    if (current().type === "Var" || current().type === "Let" || current().type === "Const") {
      const kindToken = eat(current().type);
      const kind = kindToken.value as "var" | "let" | "const";
      const id = parseBindingPattern();

      // for...of
      if (current().type === "Of") {
        eat("Of");
        const right = parseExpression();
        eat("RightParen");
        const body = parseStatement();
        const left: any = {
          type: "VariableDeclaration",
          declarations: [{ type: "VariableDeclarator", id, init: null }],
          kind,
        };
        return { type: "ForOfStatement", left, right, body };
      }

      // 通常の for — init は VariableDeclaration (複数宣言子対応)
      let firstInit: Expression | null = null;
      if (current().type === "Equals") {
        eat("Equals");
        firstInit = parseAssignment();
      }
      const declarations: any[] = [{ type: "VariableDeclarator", id, init: firstInit }];
      while (current().type === "Comma") {
        eat("Comma");
        const nextId = parseBindingPattern();
        let nextInit: Expression | null = null;
        if (current().type === "Equals") {
          eat("Equals");
          nextInit = parseAssignment();
        }
        declarations.push({ type: "VariableDeclarator", id: nextId, init: nextInit });
      }
      eat("Semicolon");
      const varDecl: any = {
        type: "VariableDeclaration",
        declarations,
        kind,
      };

      let test: Expression | null = null;
      if (current().type !== "Semicolon") test = parseExpression();
      eat("Semicolon");
      let update: Expression | null = null;
      if (current().type !== "RightParen") update = parseExpression();
      eat("RightParen");
      const body = parseStatement();
      return { type: "ForStatement", init: varDecl, test, update, body };
    }

    // init が式 or 空
    let init: any = null;
    if (current().type !== "Semicolon") {
      init = parseExpression();
      eat("Semicolon");
    } else {
      eat("Semicolon");
    }

    let test: Expression | null = null;
    if (current().type !== "Semicolon") test = parseExpression();
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
      body.push(parseStatementOrDeclaration());
    }
    eat("RightBrace");
    return { type: "BlockStatement", body };
  }

  // パラメータ1つをパース（...rest 対応）
  let _lastParamWasRest = false;
  function parseParam(): any {
    if (_lastParamWasRest) {
      throw new SyntaxError("Rest parameter must be last formal parameter");
    }
    if (current().type === "DotDotDot") {
      eat("DotDotDot");
      _lastParamWasRest = true;
      return { type: "RestElement", argument: parseIdentifier() };
    }
    return parseBindingPattern();
  }
  function resetParamState(): void {
    _lastParamWasRest = false;
  }

  // Pattern = Identifier | ObjectPattern | ArrayPattern
  function parseBindingPattern(): any {
    if (current().type === "LeftBrace") return parseObjectPattern();
    if (current().type === "LeftBracket") return parseArrayPattern();
    return parseIdentifier();
  }

  // ObjectPattern = '{' (Identifier (',' Identifier)*)? '}'
  // ネスト対応: { a: { b } } → key: a, value: ObjectPattern
  function parseObjectPattern(): any {
    eat("LeftBrace");
    const properties: any[] = [];
    while (current().type !== "RightBrace") {
      const key = parseIdentifier();
      let value: any;
      if (current().type === "Colon") {
        eat("Colon");
        value = parseBindingPattern();
      } else {
        value = { type: "Identifier", name: key.name };
      }
      properties.push({ type: "Property", key, value, kind: "init" });
      if (current().type === "Comma") eat("Comma");
    }
    eat("RightBrace");
    return { type: "ObjectPattern", properties };
  }

  // ArrayPattern = '[' (Pattern (',' Pattern)*)? ']'
  function parseArrayPattern(): any {
    eat("LeftBracket");
    const elements: any[] = [];
    while (current().type !== "RightBracket") {
      elements.push(parseBindingPattern());
      if (current().type === "Comma") eat("Comma");
    }
    eat("RightBracket");
    return { type: "ArrayPattern", elements };
  }

  function parseIdentifier() {
    const token = eat("Identifier");
    return { type: "Identifier" as const, name: token.value };
  }

  // Expression = Assignment (',' Assignment)*
  function parseExpression(): Expression {
    let expr = parseAssignment();
    if (current().type === "Comma") {
      const expressions: Expression[] = [expr];
      while (current().type === "Comma") {
        eat("Comma");
        expressions.push(parseAssignment());
      }
      return { type: "SequenceExpression", expressions };
    }
    return expr;
  }

  // Assignment = ArrowFunction | LogicalOr ('=' Assignment)?
  function parseAssignment(): Expression {
    // 単一引数アロー: `ident =>`
    if (current().type === "Identifier" && tokens[pos + 1]?.type === "Arrow") {
      const param = parseIdentifier();
      eat("Arrow");
      return parseArrowBody([param]);
    }

    // 括弧付きアロー: `() =>`, `(a) =>`, `(a, b) =>` を先読みで判定
    if (current().type === "LeftParen" && isArrowParams()) {
      const params = parseArrowParams();
      eat("Arrow");
      return parseArrowBody(params);
    }

    const left = parseLogicalOr();

    if (current().type === "Equals") {
      eat("Equals");
      const right = parseAssignment();
      // カバー文法: ObjectExpression / ArrayExpression をパターンに変換
      if (left.type === "ObjectExpression") {
        return { type: "AssignmentExpression", operator: "=", left: exprToObjectPattern(left), right };
      }
      if (left.type === "ArrayExpression") {
        return { type: "AssignmentExpression", operator: "=", left: exprToArrayPattern(left), right };
      }
      if (left.type !== "Identifier" && left.type !== "MemberExpression") {
        throw new SyntaxError("Invalid left-hand side in assignment");
      }
      return { type: "AssignmentExpression", operator: "=", left, right };
    }
    return left;
  }

  // カバー文法: ObjectExpression → ObjectPattern に変換
  function exprToObjectPattern(expr: any): any {
    const properties = expr.properties.map((prop: any) => {
      // { a: expr } → { key: a, value: Pattern }
      // { a } → shorthand: { key: a, value: Identifier(a) }
      let value: any;
      if (prop.value.type === "Identifier") {
        value = prop.value;
      } else if (prop.value.type === "ObjectExpression") {
        value = exprToObjectPattern(prop.value);
      } else if (prop.value.type === "ArrayExpression") {
        value = exprToArrayPattern(prop.value);
      } else {
        throw new SyntaxError("Invalid destructuring assignment target");
      }
      return { type: "Property", key: prop.key, value, kind: "init" };
    });
    return { type: "ObjectPattern", properties };
  }

  // カバー文法: ArrayExpression → ArrayPattern に変換
  function exprToArrayPattern(expr: any): any {
    const elements = expr.elements.map((el: any) => {
      if (!el) return null;
      if (el.type === "Identifier") return el;
      if (el.type === "ObjectExpression") return exprToObjectPattern(el);
      if (el.type === "ArrayExpression") return exprToArrayPattern(el);
      throw new SyntaxError("Invalid destructuring assignment target");
    });
    return { type: "ArrayPattern", elements };
  }

  // 先読みで (ident, ident, ...) => パターンかどうかを判定
  function isArrowParams(): boolean {
    let i = pos + 1; // LeftParen の次
    // () => のケース
    if (tokens[i]?.type === "RightParen" && tokens[i + 1]?.type === "Arrow") return true;
    // (ident) => or (ident, ident, ...) => のケース
    while (i < tokens.length) {
      if (tokens[i]?.type !== "Identifier") return false;
      i++;
      if (tokens[i]?.type === "RightParen") {
        return tokens[i + 1]?.type === "Arrow";
      }
      if (tokens[i]?.type === "Comma") {
        i++;
        continue;
      }
      return false;
    }
    return false;
  }

  // アロー関数のパラメータリストをパース
  function parseArrowParams(): { type: "Identifier"; name: string }[] {
    eat("LeftParen");
    resetParamState();
    const params: { type: "Identifier"; name: string }[] = [];
    if (current().type !== "RightParen") {
      params.push(parseParam());
      while (current().type === "Comma") {
        eat("Comma");
        params.push(parseParam());
      }
    }
    eat("RightParen");
    return params;
  }

  // アロー関数の本体をパース
  function parseArrowBody(params: { type: "Identifier"; name: string }[]): Expression {
    if (current().type === "LeftBrace") {
      const body = parseBlockStatement() as { type: "BlockStatement"; body: Statement[] };
      return { type: "ArrowFunctionExpression", params, body, expression: false };
    }
    const body = parseAssignment();
    return { type: "ArrowFunctionExpression", params, body, expression: true };
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
    let args: any[] = [];
    if (current().type === "LeftParen") {
      eat("LeftParen");
      args = parseArguments();
      eat("RightParen");
    }
    return { type: "NewExpression", callee, arguments: args };
  }

  // 引数リストのパース（SpreadElement 対応）
  function parseArguments(): any[] {
    const args: any[] = [];
    if (current().type !== "RightParen") {
      args.push(parseCallArgument());
      while (current().type === "Comma") {
        eat("Comma");
        args.push(parseCallArgument());
      }
    }
    return args;
  }

  function parseCallArgument(): any {
    if (current().type === "DotDotDot") {
      eat("DotDotDot");
      return { type: "SpreadElement", argument: parseAssignment() };
    }
    return parseAssignment();
  }

  // CallExpression = Primary (('(' Arguments ')') | ('.' Identifier) | ('[' Expression ']'))*
  function parseCallExpression(): Expression {
    let expr = parsePrimary();
    while (true) {
      if (current().type === "LeftParen") {
        eat("LeftParen");
        const args = parseArguments();
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
      case "Super":
        eat("Super");
        return { type: "Identifier", name: "__super__" };
      case "Function":
        return parseFunctionExpression();
      case "NoSubstitutionTemplate":
        eat("NoSubstitutionTemplate");
        return {
          type: "TemplateLiteral",
          quasis: [{ type: "TemplateElement", value: { raw: token.value, cooked: token.value }, tail: true }],
          expressions: [],
        };
      case "TemplateHead":
        return parseTemplateLiteral();
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
    resetParamState();
    const params: { type: "Identifier"; name: string }[] = [];
    if (current().type !== "RightParen") {
      params.push(parseParam());
      while (current().type === "Comma") {
        eat("Comma");
        params.push(parseParam());
      }
    }
    eat("RightParen");
    const body = parseBlockStatement() as { type: "BlockStatement"; body: Statement[] };
    return { type: "FunctionExpression", id, params, body };
  }

  // TemplateLiteral = TemplateHead Expression (TemplateMiddle Expression)* TemplateTail
  function parseTemplateLiteral(): Expression {
    const quasis: { type: "TemplateElement"; value: { raw: string; cooked: string }; tail: boolean }[] = [];
    const expressions: Expression[] = [];

    const head = eat("TemplateHead");
    quasis.push({ type: "TemplateElement", value: { raw: head.value, cooked: head.value }, tail: false });
    expressions.push(parseExpression());

    while (current().type === "TemplateMiddle") {
      const mid = eat("TemplateMiddle");
      quasis.push({ type: "TemplateElement", value: { raw: mid.value, cooked: mid.value }, tail: false });
      expressions.push(parseExpression());
    }

    const tail = eat("TemplateTail");
    quasis.push({ type: "TemplateElement", value: { raw: tail.value, cooked: tail.value }, tail: true });

    return { type: "TemplateLiteral", quasis, expressions };
  }

  // ObjectExpression = '{' (Property | SpreadElement (',' ...))* '}'
  function parseObjectExpression(): Expression {
    eat("LeftBrace");
    const properties: any[] = [];
    while (current().type !== "RightBrace") {
      // SpreadElement: { ...obj }
      if (current().type === "DotDotDot") {
        eat("DotDotDot");
        properties.push({ type: "SpreadElement", argument: parseAssignment() });
        if (current().type === "Comma") eat("Comma");
        continue;
      }
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
      let value: Expression;
      if (current().type === "Colon") {
        eat("Colon");
        value = parseAssignment();
      } else {
        // ショートハンド: { a } → { a: a }
        if (key.type !== "Identifier") {
          throw new SyntaxError("Shorthand property must be an identifier");
        }
        value = { type: "Identifier", name: key.name };
      }
      properties.push({ type: "Property", key, value, kind: "init" });
      if (current().type === "Comma") {
        eat("Comma");
      }
    }
    eat("RightBrace");
    return { type: "ObjectExpression", properties };
  }

  // ArrayExpression = '[' (Element (',' Element)* ','?)? ']'
  function parseArrayElement(): any {
    if (current().type === "DotDotDot") {
      eat("DotDotDot");
      return { type: "SpreadElement", argument: parseAssignment() };
    }
    return parseAssignment();
  }

  function parseArrayExpression(): Expression {
    eat("LeftBracket");
    const elements: any[] = [];
    if (current().type !== "RightBracket") {
      elements.push(parseArrayElement());
      while (current().type === "Comma") {
        eat("Comma");
        if (current().type === "RightBracket") break;
        elements.push(parseArrayElement());
      }
    }
    eat("RightBracket");
    return { type: "ArrayExpression", elements };
  }

  return parseProgram();
}
