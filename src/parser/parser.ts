import type { Token, TokenType } from "../lexer/token.js";
import { tokenize } from "../lexer/lexer.js";
import type { Program, Expression, Statement } from "./ast.js";

export function parse(source: string): Program {
  const tokens = tokenize(source);
  let pos = 0;

  function current(): Token {
    return tokens[pos];
  }

  function peek(): Token {
    return tokens[pos + 1] ?? tokens[tokens.length - 1]; // EOF fallback
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
    // 空文: ;
    if (current().type === "Semicolon") {
      eat("Semicolon");
      return { type: "EmptyStatement" } as any;
    }
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
    if (current().type === "Async" && peek().type === "Function") return parseAsyncFunctionDeclaration();
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
    if (current().type === "Async" && peek().type === "Function") return parseAsyncFunctionDeclaration();
    if (current().type === "Return") return parseReturnStatement();
    if (current().type === "Throw") return parseThrowStatement();
    if (current().type === "Try") return parseTryStatement();
    if (current().type === "Break") {
      eat("Break");
      const label = (current().type === "Identifier") ? eat("Identifier").value : null;
      if (current().type === "Semicolon") eat("Semicolon");
      return { type: "BreakStatement", label };
    }
    if (current().type === "Continue") {
      eat("Continue");
      const label = (current().type === "Identifier") ? eat("Identifier").value : null;
      if (current().type === "Semicolon") eat("Semicolon");
      return { type: "ContinueStatement", label };
    }
    if (current().type === "If") return parseIfStatement();
    if (current().type === "While") return parseWhileStatement();
    if (current().type === "Do") return parseDoWhileStatement();
    if (current().type === "For") return parseForStatement();
    if (current().type === "Switch") return parseSwitchStatement();
    if (current().type === "LeftBrace") return parseBlockStatement();

    // ラベル付き文: Identifier ':' Statement
    if (current().type === "Identifier" && tokens[pos + 1]?.type === "Colon") {
      const label = eat("Identifier").value;
      eat("Colon");
      const body = parseStatement();
      return { type: "LabeledStatement", label, body };
    }

    const expression = parseExpression();
    if (current().type === "Semicolon") eat("Semicolon");
    // ASI: セミコロンがなくても } や EOF の前なら許容
    return { type: "ExpressionStatement", expression };
  }

  // VariableDeclaration = ('var' | 'let' | 'const') Declarator (',' Declarator)* ';'
  function parseVariableDeclaration(): Statement {
    const kindToken = eat(current().type);
    const kind = kindToken.value as "var" | "let" | "const";
    const declarations: any[] = [];

    // 最初の宣言子
    const id = parseBindingPattern();
    let init: Expression | null = null;
    if (current().type === "Equals") {
      eat("Equals");
      init = parseAssignment();
    }
    if (kind === "const" && init === null) {
      throw new SyntaxError("Missing initializer in const declaration");
    }
    declarations.push({ type: "VariableDeclarator", id, init });

    // 追加の宣言子
    while (current().type === "Comma") {
      eat("Comma");
      const nextId = parseBindingPattern();
      let nextInit: Expression | null = null;
      if (current().type === "Equals") {
        eat("Equals");
        nextInit = parseAssignment();
      }
      if (kind === "const" && nextInit === null) {
        throw new SyntaxError("Missing initializer in const declaration");
      }
      declarations.push({ type: "VariableDeclarator", id: nextId, init: nextInit });
    }

    if (current().type === "Semicolon") eat("Semicolon"); // ASI
    return {
      type: "VariableDeclaration",
      declarations,
      kind,
    };
  }

  // AsyncFunctionDeclaration = 'async' 'function' Identifier '(' params ')' BlockStatement
  function parseAsyncFunctionDeclaration(): Statement {
    eat("Async");
    eat("Function");
    const id = parseIdentifier();
    eat("LeftParen");
    resetParamState();
    const params: any[] = [];
    if (current().type !== "RightParen") {
      params.push(parseParam());
      while (current().type === "Comma") { eat("Comma"); params.push(parseParam()); }
    }
    eat("RightParen");
    const body = parseBlockStatement() as any;
    return { type: "FunctionDeclaration", id, params, body, async: true } as any;
  }

  // FunctionDeclaration = 'function' Identifier '(' params ')' BlockStatement
  function parseFunctionDeclaration(): Statement {
    eat("Function");
    const generator = current().type === "Star";
    if (generator) eat("Star");
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
    return { type: "FunctionDeclaration", id, params, body, generator } as any;
  }

  // ClassDeclaration = 'class' Identifier ('extends' Expression)? '{' ClassElement* '}'
  function parseClassDeclaration(): Statement {
    eat("Class");
    const id = parseIdentifier();

    let superClass: Expression | null = null;
    if (current().type === "Extends") {
      eat("Extends");
      superClass = parseAssignment();
    }

    const classBody = parseClassBody();
    return { type: "ClassDeclaration", id, superClass, body: classBody };
  }

  // ClassBody = '{' ClassElement* '}'
  function parseClassBody(): any {
    eat("LeftBrace");
    const body: any[] = [];
    while (current().type !== "RightBrace") {
      if (current().type === "Semicolon") { eat("Semicolon"); continue; }

      let isStatic = false;
      if (current().type === "Identifier" && current().value === "static" &&
          tokens[pos + 1]?.type !== "LeftParen") {
        isStatic = true;
        eat("Identifier");
      }

      let key: any;
      let computed = false;
      let isGenerator = false;

      // generator method: class C { *gen() {} }
      if (current().type === "Star") {
        eat("Star");
        isGenerator = true;
      }

      if (current().type === "LeftBracket") {
        eat("LeftBracket"); key = parseAssignment(); eat("RightBracket"); computed = true;
      } else if (current().type === "PrivateIdentifier") {
        key = { type: "PrivateIdentifier", name: eat("PrivateIdentifier").value };
      } else if (current().type === "String") {
        key = { type: "Literal", value: eat("String").value };
      } else if (current().type === "Number") {
        key = { type: "Literal", value: Number(eat("Number").value) };
      } else {
        key = parsePropertyKey();
      }

      // getter/setter
      if ((key.name === "get" || key.name === "set") && !computed &&
          (current().type === "Identifier" || current().type === "PrivateIdentifier" ||
           current().type === "LeftBracket" || current().type === "String" || current().type === "Number" ||
           KEYWORD_TYPES.has(current().type)) &&
          key.type !== "PrivateIdentifier") {
        const kind = key.name as "get" | "set";
        computed = false;
        if (current().type === "LeftBracket") {
          eat("LeftBracket"); key = parseAssignment(); eat("RightBracket"); computed = true;
        } else if (current().type === "PrivateIdentifier") {
          key = { type: "PrivateIdentifier", name: eat("PrivateIdentifier").value };
        } else if (current().type === "String") {
          key = { type: "Literal", value: eat("String").value };
        } else if (current().type === "Number") {
          key = { type: "Literal", value: Number(eat("Number").value) };
        } else {
          key = parsePropertyKey();
        }
        eat("LeftParen");
        resetParamState();
        const params: any[] = [];
        if (current().type !== "RightParen") {
          params.push(parseParam());
          while (current().type === "Comma") { eat("Comma"); params.push(parseParam()); }
        }
        eat("RightParen");
        const mbody = parseBlockStatement() as { type: "BlockStatement"; body: Statement[] };
        body.push({ type: "MethodDefinition", key, value: { type: "FunctionExpression", id: null, params, body: mbody }, kind, computed, static: isStatic });
        continue;
      }

      // メソッド
      if (current().type === "LeftParen" || isGenerator) {
        const kind = !computed && key.type !== "PrivateIdentifier" && key.name === "constructor" ? "constructor" : "method";
        eat("LeftParen");
        resetParamState();
        const params: any[] = [];
        if (current().type !== "RightParen") {
          params.push(parseParam());
          while (current().type === "Comma") { eat("Comma"); params.push(parseParam()); }
        }
        eat("RightParen");
        const mbody = parseBlockStatement() as { type: "BlockStatement"; body: Statement[] };
        body.push({ type: "MethodDefinition", key, value: { type: "FunctionExpression", id: null, params, body: mbody, generator: isGenerator } as any, kind, computed, static: isStatic });
        continue;
      }

      // フィールド宣言
      let fieldValue: Expression | null = null;
      if (current().type === "Equals") { eat("Equals"); fieldValue = parseAssignment(); }
      if (current().type === "Semicolon") eat("Semicolon");
      body.push({ type: "PropertyDefinition", key, value: fieldValue, computed, static: isStatic });
    }
    eat("RightBrace");
    return { type: "ClassBody", body };
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

  function parseDoWhileStatement(): Statement {
    eat("Do");
    const body = parseStatement();
    eat("While");
    eat("LeftParen");
    const test = parseExpression();
    eat("RightParen");
    if (current().type === "Semicolon") eat("Semicolon");
    return { type: "DoWhileStatement", test, body };
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

      // for...in
      if (current().type === "In") {
        eat("In");
        const right = parseExpression();
        eat("RightParen");
        const body = parseStatement();
        const left: any = {
          type: "VariableDeclaration",
          declarations: [{ type: "VariableDeclarator", id, init: null }],
          kind,
        };
        return { type: "ForInStatement", left, right, body };
      }

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

  function parseSwitchStatement(): Statement {
    eat("Switch");
    eat("LeftParen");
    const discriminant = parseExpression();
    eat("RightParen");
    eat("LeftBrace");
    const cases: any[] = [];
    while (current().type !== "RightBrace") {
      let test: any = null;
      if (current().type === "Case") {
        eat("Case");
        test = parseExpression();
      } else {
        eat("Default");
      }
      eat("Colon");
      const consequent: any[] = [];
      while (current().type !== "Case" && current().type !== "Default" && current().type !== "RightBrace") {
        consequent.push(parseStatementOrDeclaration());
      }
      cases.push({ type: "SwitchCase", test, consequent });
    }
    eat("RightBrace");
    return { type: "SwitchStatement", discriminant, cases };
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
    const pattern = parseBindingPattern();
    // デフォルト引数: param = defaultValue
    if (current().type === "Equals") {
      eat("Equals");
      const right = parseAssignment();
      return { type: "AssignmentPattern", left: pattern, right };
    }
    return pattern;
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

  // ObjectPattern = '{' (Property | RestElement)* '}'
  function parseObjectPattern(): any {
    eat("LeftBrace");
    const properties: any[] = [];
    while (current().type !== "RightBrace") {
      if (current().type === "DotDotDot") {
        eat("DotDotDot");
        properties.push({ type: "RestElement", argument: parseBindingPattern() });
        if (current().type === "Comma") eat("Comma");
        break; // rest は最後
      }
      const key = parseIdentifier();
      let value: any;
      if (current().type === "Colon") {
        eat("Colon");
        value = parseBindingPattern();
      } else {
        value = { type: "Identifier", name: key.name };
      }
      // デフォルト値: { a = 1 }
      if (current().type === "Equals") {
        eat("Equals");
        const defaultValue = parseAssignment();
        value = { type: "AssignmentPattern", left: value, right: defaultValue };
      }
      properties.push({ type: "Property", key, value, kind: "init" });
      if (current().type === "Comma") eat("Comma");
    }
    eat("RightBrace");
    return { type: "ObjectPattern", properties };
  }

  // ArrayPattern = '[' (Pattern | RestElement)* ']'
  function parseArrayPattern(): any {
    eat("LeftBracket");
    const elements: any[] = [];
    while (current().type !== "RightBracket") {
      if (current().type === "Comma") {
        // 穴あき: [, , x] → [undefined, undefined, x]
        eat("Comma");
        elements.push(null);
        continue;
      }
      if (current().type === "DotDotDot") {
        eat("DotDotDot");
        elements.push({ type: "RestElement", argument: parseBindingPattern() });
        break; // rest は最後
      }
      let elem = parseBindingPattern();
      // デフォルト値: [a = 1]
      if (current().type === "Equals") {
        eat("Equals");
        const defaultValue = parseAssignment();
        elem = { type: "AssignmentPattern", left: elem, right: defaultValue };
      }
      elements.push(elem);
      if (current().type === "Comma") eat("Comma");
    }
    eat("RightBracket");
    return { type: "ArrayPattern", elements };
  }

  function parseIdentifier() {
    const token = eat("Identifier");
    return { type: "Identifier" as const, name: token.value };
  }

  // プロパティキー位置では予約語も識別子として許可
  const KEYWORD_TYPES: Set<string> = new Set([
    "Var", "Let", "Const", "If", "Else", "True", "False", "Null",
    "While", "For", "Function", "Return", "Break", "Continue",
    "Typeof", "Throw", "Try", "Catch", "Finally", "New", "This",
    "Class", "Extends", "Super", "Of", "In", "Instanceof",
    "Do", "Switch", "Case", "Default", "Delete", "Void", "Yield",
  ]);

  function parsePropertyKey(): { type: "Identifier"; name: string } {
    if (current().type === "Identifier") {
      return parseIdentifier();
    }
    if (KEYWORD_TYPES.has(current().type)) {
      const token = eat(current().type);
      return { type: "Identifier", name: token.value };
    }
    // fallback: parseIdentifier でエラーを出す
    return parseIdentifier();
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

  // Assignment = YieldExpression | ArrowFunction | LogicalOr ('=' Assignment)?
  function parseAssignment(): Expression {
    // await expression
    if (current().type === "Await") {
      eat("Await");
      const argument = parseAssignment();
      return { type: "AwaitExpression", argument } as any;
    }
    // yield expression
    if (current().type === "Yield") {
      eat("Yield");
      const delegate = current().type === "Star";
      if (delegate) eat("Star");
      // yield の引数: 次のトークンが文末系でなければ式をパース
      let argument: Expression | null = null;
      if (current().type !== "Semicolon" && current().type !== "RightParen" &&
          current().type !== "RightBracket" && current().type !== "RightBrace" &&
          current().type !== "Comma" && current().type !== "Colon" && current().type !== "EOF") {
        argument = parseAssignment();
      }
      return { type: "YieldExpression", argument, delegate } as any;
    }
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

    let left = parseLogicalOr();

    // 三項演算子: test ? consequent : alternate
    if (current().type === "Question") {
      eat("Question");
      const consequent = parseAssignment();
      eat("Colon");
      const alternate = parseAssignment();
      left = { type: "ConditionalExpression", test: left, consequent, alternate };
    }

    // 代入演算子
    const assignOps = ["Equals", "PlusEquals", "MinusEquals", "StarEquals", "SlashEquals", "PercentEquals"];
    if (assignOps.includes(current().type)) {
      const opToken = eat(current().type);
      const operator = opToken.value;
      const right = parseAssignment();
      if (operator === "=") {
        if (left.type === "ObjectExpression") {
          return { type: "AssignmentExpression", operator, left: exprToObjectPattern(left), right };
        }
        if (left.type === "ArrayExpression") {
          return { type: "AssignmentExpression", operator, left: exprToArrayPattern(left), right };
        }
      }
      if (left.type !== "Identifier" && left.type !== "MemberExpression") {
        throw new SyntaxError("Invalid left-hand side in assignment");
      }
      return { type: "AssignmentExpression", operator, left, right };
    }
    return left;
  }

  // カバー文法: ObjectExpression → ObjectPattern に変換
  function exprToPattern(expr: any): any {
    if (!expr) return null;
    if (expr.type === "Identifier") return expr;
    if (expr.type === "MemberExpression") return expr;
    if (expr.type === "ObjectExpression") return exprToObjectPattern(expr);
    if (expr.type === "ArrayExpression") return exprToArrayPattern(expr);
    if (expr.type === "AssignmentExpression" && expr.operator === "=") {
      return { type: "AssignmentPattern", left: exprToPattern(expr.left), right: expr.right };
    }
    if (expr.type === "SpreadElement") {
      return { type: "RestElement", argument: exprToPattern(expr.argument) };
    }
    throw new SyntaxError("Invalid destructuring assignment target");
  }

  function exprToObjectPattern(expr: any): any {
    const properties = expr.properties.map((prop: any) => {
      if (prop.type === "SpreadElement") {
        return { type: "RestElement", argument: exprToPattern(prop.argument) };
      }
      const value = exprToPattern(prop.value);
      return { type: "Property", key: prop.key, value, kind: "init" };
    });
    return { type: "ObjectPattern", properties };
  }

  function exprToArrayPattern(expr: any): any {
    const elements = expr.elements.map((el: any) => exprToPattern(el));
    return { type: "ArrayPattern", elements };
  }

  // 先読みで (ident, ident, ...) => パターンかどうかを判定
  function isArrowParams(): boolean {
    let i = pos + 1; // LeftParen の次
    // () => のケース
    if (tokens[i]?.type === "RightParen" && tokens[i + 1]?.type === "Arrow") return true;
    // 括弧のネスト深度を追跡して ) => を探す
    let depth = 1;
    while (i < tokens.length && depth > 0) {
      const t = tokens[i]?.type;
      if (t === "LeftParen" || t === "LeftBracket" || t === "LeftBrace") depth++;
      else if (t === "RightParen" || t === "RightBracket" || t === "RightBrace") depth--;
      if (depth === 0) {
        return tokens[i + 1]?.type === "Arrow";
      }
      i++;
    }
    return false;
  }

  // アロー関数のパラメータリストをパース
  function parseArrowParams(): any[] {
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
    return params;
  }

  // アロー関数の本体をパース
  function parseArrowBody(params: any[]): Expression {
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
    while (current().type === "PipePipe" || current().type === "QuestionQuestion") {
      const operator = eat(current().type).value;
      const right = parseLogicalAnd();
      left = { type: "LogicalExpression", operator, left, right };
    }
    return left;
  }

  // LogicalAnd = BitwiseOr ('&&' BitwiseOr)*
  function parseLogicalAnd(): Expression {
    let left = parseBitwiseOr();
    while (current().type === "AmpersandAmpersand") {
      const operator = eat("AmpersandAmpersand").value;
      const right = parseBitwiseOr();
      left = { type: "LogicalExpression", operator, left, right };
    }
    return left;
  }

  function parseBitwiseOr(): Expression {
    let left = parseBitwiseXor();
    while (current().type === "Pipe") {
      eat("Pipe"); const right = parseBitwiseXor();
      left = { type: "BinaryExpression", operator: "|", left, right };
    }
    return left;
  }

  function parseBitwiseXor(): Expression {
    let left = parseBitwiseAnd();
    while (current().type === "Caret") {
      eat("Caret"); const right = parseBitwiseAnd();
      left = { type: "BinaryExpression", operator: "^", left, right };
    }
    return left;
  }

  function parseBitwiseAnd(): Expression {
    let left = parseEquality();
    while (current().type === "Ampersand") {
      eat("Ampersand"); const right = parseEquality();
      left = { type: "BinaryExpression", operator: "&", left, right };
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

  // Comparison = Shift (('<' | '>' | '<=' | '>=') Shift)*
  function parseComparison(): Expression {
    let left = parseShift();
    while (
      current().type === "Less" ||
      current().type === "Greater" ||
      current().type === "LessEqual" ||
      current().type === "GreaterEqual" ||
      current().type === "In" ||
      current().type === "Instanceof"
    ) {
      const operator = eat(current().type).value;
      const right = parseShift();
      left = { type: "BinaryExpression", operator, left, right };
    }
    return left;
  }

  // Shift = Additive (('<<' | '>>' | '>>>') Additive)*
  function parseShift(): Expression {
    let left = parseAdditive();
    while (current().type === "ShiftLeft" || current().type === "ShiftRight" || current().type === "UnsignedShiftRight") {
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

  // Multiplicative = Exponent (('*' | '/' | '%') Exponent)*
  function parseMultiplicative(): Expression {
    let left = parseExponent();
    while (
      current().type === "Star" ||
      current().type === "Slash" ||
      current().type === "Percent"
    ) {
      const operator = eat(current().type).value;
      const right = parseExponent();
      left = { type: "BinaryExpression", operator, left, right };
    }
    return left;
  }

  // Exponent = Unary ('**' Exponent)?  (right-associative)
  function parseExponent(): Expression {
    const left = parseUnary();
    if (current().type === "StarStar") {
      eat("StarStar");
      const right = parseExponent(); // right-associative
      return { type: "BinaryExpression", operator: "**", left, right };
    }
    return left;
  }

  // Unary / Update
  function parseUnary(): Expression {
    if (current().type === "Await") {
      eat("Await");
      const argument = parseUnary();
      return { type: "AwaitExpression", argument } as any;
    }
    if (current().type === "Bang" || current().type === "Tilde") {
      const operator = eat(current().type).value;
      const argument = parseUnary();
      return { type: "UnaryExpression", operator, prefix: true, argument };
    }
    if (current().type === "Minus") {
      const operator = eat("Minus").value;
      const argument = parseUnary();
      return { type: "UnaryExpression", operator, prefix: true, argument };
    }
    if (current().type === "PlusPlus" || current().type === "MinusMinus") {
      const operator = eat(current().type).value as "++" | "--";
      const argument = parseUnary();
      return { type: "UpdateExpression", operator, argument: argument as any, prefix: true };
    }
    if (current().type === "Typeof" || current().type === "Delete" || current().type === "Void") {
      const operator = eat(current().type).value;
      const argument = parseUnary();
      return { type: "UnaryExpression", operator, prefix: true, argument };
    }
    if (current().type === "New") {
      return parseNewExpression();
    }
    return parseCallExpression();
  }

  // NewExpression = 'new' Primary Arguments? ('.' Identifier | '(' args ')' | '[' expr ']')*
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
    let expr: Expression = { type: "NewExpression", callee, arguments: args };
    // new Foo().bar().baz() のチェーンを処理
    while (true) {
      if (current().type === "LeftParen") {
        eat("LeftParen");
        const callArgs = parseArguments();
        eat("RightParen");
        expr = { type: "CallExpression", callee: expr, arguments: callArgs };
      } else if (current().type === "Dot" || current().type === "QuestionDot") {
        const optional = current().type === "QuestionDot";
        eat(current().type);
        const property = parsePropertyKey();
        expr = { type: "MemberExpression", object: expr, property, computed: false, optional } as any;
      } else if (current().type === "LeftBracket") {
        eat("LeftBracket");
        const prop = parseExpression();
        eat("RightBracket");
        expr = { type: "MemberExpression", object: expr, property: prop, computed: true } as any;
      } else {
        break;
      }
    }
    return expr;
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
      } else if (current().type === "Dot" || current().type === "QuestionDot") {
        const optional = current().type === "QuestionDot";
        eat(current().type);
        let property: any;
        if (current().type === "PrivateIdentifier") {
          const tok = eat("PrivateIdentifier");
          property = { type: "PrivateIdentifier", name: tok.value };
        } else {
          property = parsePropertyKey();
        }
        expr = { type: "MemberExpression", object: expr, property, computed: false, optional } as any;
      } else if (current().type === "LeftBracket") {
        eat("LeftBracket");
        const property = parseExpression();
        eat("RightBracket");
        expr = { type: "MemberExpression", object: expr, property, computed: true };
      } else if (current().type === "NoSubstitutionTemplate" || current().type === "TemplateHead") {
        // Tagged template literal: tag`...`
        let quasi: any;
        if (current().type === "NoSubstitutionTemplate") {
          const tok = eat("NoSubstitutionTemplate");
          quasi = { type: "TemplateLiteral", quasis: [{ type: "TemplateElement", value: { raw: tok.value, cooked: tok.value }, tail: true }], expressions: [] };
        } else {
          quasi = parseTemplateLiteral();
        }
        expr = { type: "TaggedTemplateExpression", tag: expr, quasi } as any;
      } else {
        break;
      }
    }
    // postfix ++/--
    if (current().type === "PlusPlus" || current().type === "MinusMinus") {
      const operator = eat(current().type).value as "++" | "--";
      return { type: "UpdateExpression", operator, argument: expr as any, prefix: false };
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
      case "Async":
        if (peek().type === "Function") {
          // async function expression
          eat("Async");
          eat("Function");
          let id: any = null;
          if (current().type === "Identifier") id = parseIdentifier();
          eat("LeftParen");
          resetParamState();
          const params: any[] = [];
          if (current().type !== "RightParen") {
            params.push(parseParam());
            while (current().type === "Comma") { eat("Comma"); params.push(parseParam()); }
          }
          eat("RightParen");
          const body = parseBlockStatement() as any;
          return { type: "FunctionExpression", id, params, body, async: true } as any;
        }
        // async arrow: async (params) => body or async ident => body
        if (peek().type === "Identifier" && tokens[pos + 2]?.type === "Arrow") {
          eat("Async");
          const param = parseIdentifier();
          eat("Arrow");
          const arrowBody = current().type === "LeftBrace" ? parseBlockStatement() : parseAssignment();
          return { type: "ArrowFunctionExpression", params: [param], body: arrowBody, async: true } as any;
        }
        if (peek().type === "LeftParen") {
          // async (...) => body — try as async arrow
          eat("Async");
          eat("LeftParen");
          resetParamState();
          const arrowParams: any[] = [];
          if (current().type !== "RightParen") {
            arrowParams.push(parseParam());
            while (current().type === "Comma") { eat("Comma"); arrowParams.push(parseParam()); }
          }
          eat("RightParen");
          if (current().type === "Arrow") {
            eat("Arrow");
            const arrowBody = current().type === "LeftBrace" ? parseBlockStatement() : parseAssignment();
            return { type: "ArrowFunctionExpression", params: arrowParams, body: arrowBody, async: true } as any;
          }
          // not an async arrow — fall through (unlikely)
        }
        // fallthrough: treat "async" as identifier
        eat("Async");
        return { type: "Identifier", name: "async" };
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
      case "Class":
        return parseClassExpression();
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

  // ClassExpression = 'class' Identifier? ('extends' Expression)? '{' ClassElement* '}'
  function parseClassExpression(): Expression {
    eat("Class");
    let id: { type: "Identifier"; name: string } | null = null;
    if (current().type === "Identifier") {
      id = parseIdentifier();
    }
    let superClass: Expression | null = null;
    if (current().type === "Extends") {
      eat("Extends");
      superClass = parseAssignment();
    }
    const classBody = parseClassBody();
    return { type: "ClassExpression", id, superClass, body: classBody } as any;
  }

  // FunctionExpression = 'function' Identifier? '(' params ')' BlockStatement
  function parseFunctionExpression(): Expression {
    eat("Function");
    const generator = current().type === "Star";
    if (generator) eat("Star");
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
    return { type: "FunctionExpression", id, params, body, generator } as any;
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
      let key: any;
      let propKind: "init" | "get" | "set" = "init";
      let computed = false;
      let isGenerator = false;

      // generator method: { *foo() {} }
      if (current().type === "Star") {
        eat("Star");
        isGenerator = true;
      }

      // computed property: [expr]
      if (current().type === "LeftBracket") {
        eat("LeftBracket");
        key = parseAssignment();
        eat("RightBracket");
        computed = true;
      } else if (current().type === "Identifier" || KEYWORD_TYPES.has(current().type)) {
        const t = eat(current().type);
        // getter/setter: get name() {} / set name(v) {}
        if ((t.value === "get" || t.value === "set") &&
            (current().type === "Identifier" || KEYWORD_TYPES.has(current().type) || current().type === "LeftBracket" || current().type === "String" || current().type === "Number")) {
          propKind = t.value as "get" | "set";
          if (current().type === "LeftBracket") {
            eat("LeftBracket"); key = parseAssignment(); eat("RightBracket"); computed = true;
          } else if (current().type === "String") {
            key = { type: "Literal", value: eat("String").value };
          } else if (current().type === "Number") {
            key = { type: "Literal", value: Number(eat("Number").value) };
          } else {
            const kt = eat(current().type);
            key = { type: "Identifier", name: kt.value };
          }
          eat("LeftParen");
          resetParamState();
          const params: any[] = [];
          if (current().type !== "RightParen") {
            params.push(parseParam());
            while (current().type === "Comma") { eat("Comma"); params.push(parseParam()); }
          }
          eat("RightParen");
          const body = parseBlockStatement();
          const value: Expression = { type: "FunctionExpression", id: null, params, body } as any;
          properties.push({ type: "Property", key, value, kind: propKind, computed });
          if (current().type === "Comma") eat("Comma");
          continue;
        }
        key = { type: "Identifier", name: t.value };
      } else if (current().type === "String") {
        key = { type: "Literal", value: eat("String").value };
      } else if (current().type === "Number") {
        key = { type: "Literal", value: Number(eat("Number").value) };
      } else {
        throw new SyntaxError(
          `Unexpected token ${current().type} as object key at line ${current().line}, column ${current().column}`
        );
      }
      let value: Expression;
      if (current().type === "LeftParen" || isGenerator) {
        // メソッド省略記法: { foo() {} } or { *foo() {} }
        eat("LeftParen");
        resetParamState();
        const params: any[] = [];
        if (current().type !== "RightParen") {
          params.push(parseParam());
          while (current().type === "Comma") { eat("Comma"); params.push(parseParam()); }
        }
        eat("RightParen");
        const body = parseBlockStatement();
        value = { type: "FunctionExpression", id: null, params, body, generator: isGenerator } as any;
      } else if (current().type === "Colon") {
        eat("Colon");
        value = parseAssignment();
      } else {
        // ショートハンド: { a } → { a: a }
        if (key.type !== "Identifier") {
          throw new SyntaxError("Shorthand property must be an identifier");
        }
        value = { type: "Identifier", name: key.name };
      }
      properties.push({ type: "Property", key, value, kind: propKind, computed });
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
