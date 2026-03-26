// ESTree 準拠の AST ノード定義
// https://github.com/estree/estree

export type Program = {
  type: "Program";
  body: Statement[];
};

export type Statement =
  | ExpressionStatement
  | VariableDeclaration
  | FunctionDeclaration
  | ClassDeclaration
  | ReturnStatement
  | BreakStatement
  | ContinueStatement
  | ThrowStatement
  | TryStatement
  | IfStatement
  | WhileStatement
  | ForStatement
  | ForOfStatement
  | BlockStatement;

export type ExpressionStatement = {
  type: "ExpressionStatement";
  expression: Expression;
};

export type VariableDeclaration = {
  type: "VariableDeclaration";
  declarations: VariableDeclarator[];
  kind: "var" | "let" | "const";
};

export type VariableDeclarator = {
  type: "VariableDeclarator";
  id: Pattern;
  init: Expression | null;
};

export type Pattern = Identifier | ObjectPattern | ArrayPattern;

export type ObjectPattern = {
  type: "ObjectPattern";
  properties: AssignmentProperty[];
};

export type AssignmentProperty = {
  type: "Property";
  key: Identifier;
  value: Pattern;
  kind: "init";
};

export type ArrayPattern = {
  type: "ArrayPattern";
  elements: (Pattern | null)[];
};

export type IfStatement = {
  type: "IfStatement";
  test: Expression;
  consequent: Statement;
  alternate: Statement | null;
};

export type FunctionDeclaration = {
  type: "FunctionDeclaration";
  id: Identifier;
  params: Identifier[];
  body: BlockStatement;
};

export type ClassDeclaration = {
  type: "ClassDeclaration";
  id: Identifier;
  superClass: Expression | null;
  body: ClassBody;
};

export type ClassBody = {
  type: "ClassBody";
  body: MethodDefinition[];
};

export type MethodDefinition = {
  type: "MethodDefinition";
  key: Identifier;
  value: FunctionExpression;
  kind: "constructor" | "method";
  static: false;
};

export type ReturnStatement = {
  type: "ReturnStatement";
  argument: Expression | null;
};

export type ThrowStatement = {
  type: "ThrowStatement";
  argument: Expression;
};

export type TryStatement = {
  type: "TryStatement";
  block: BlockStatement;
  handler: CatchClause | null;
  finalizer: BlockStatement | null;
};

export type CatchClause = {
  type: "CatchClause";
  param: Identifier;
  body: BlockStatement;
};

export type BreakStatement = {
  type: "BreakStatement";
  label: null;
};

export type ContinueStatement = {
  type: "ContinueStatement";
  label: null;
};

export type WhileStatement = {
  type: "WhileStatement";
  test: Expression;
  body: Statement;
};

export type ForStatement = {
  type: "ForStatement";
  init: VariableDeclaration | Expression | null;
  test: Expression | null;
  update: Expression | null;
  body: Statement;
};

export type ForOfStatement = {
  type: "ForOfStatement";
  left: VariableDeclaration;
  right: Expression;
  body: Statement;
};

export type BlockStatement = {
  type: "BlockStatement";
  body: Statement[];
};

export type Expression =
  | Literal
  | Identifier
  | ThisExpression
  | ObjectExpression
  | ArrayExpression
  | MemberExpression
  | CallExpression
  | NewExpression
  | FunctionExpression
  | ArrowFunctionExpression
  | SequenceExpression
  | TemplateLiteral
  | BinaryExpression
  | LogicalExpression
  | UnaryExpression
  | UpdateExpression
  | AssignmentExpression;

export type UpdateExpression = {
  type: "UpdateExpression";
  operator: "++" | "--";
  argument: Identifier | MemberExpression;
  prefix: boolean;
};

export type ThisExpression = {
  type: "ThisExpression";
};

export type NewExpression = {
  type: "NewExpression";
  callee: Expression;
  arguments: Expression[];
};

export type FunctionExpression = {
  type: "FunctionExpression";
  id: Identifier | null;
  params: Identifier[];
  body: BlockStatement;
};

export type ArrowFunctionExpression = {
  type: "ArrowFunctionExpression";
  params: Identifier[];
  body: BlockStatement | Expression;
  expression: boolean; // true = 式本体, false = ブロック本体
};

export type TemplateLiteral = {
  type: "TemplateLiteral";
  quasis: TemplateElement[];
  expressions: Expression[];
};

export type TemplateElement = {
  type: "TemplateElement";
  value: { raw: string; cooked: string };
  tail: boolean;
};

export type SpreadElement = {
  type: "SpreadElement";
  argument: Expression;
};

export type RestElement = {
  type: "RestElement";
  argument: Identifier;
};

export type SequenceExpression = {
  type: "SequenceExpression";
  expressions: Expression[];
};

export type ObjectExpression = {
  type: "ObjectExpression";
  properties: Property[];
};

export type Property = {
  type: "Property";
  key: Identifier | Literal;
  value: Expression;
  kind: "init";
};

export type ArrayExpression = {
  type: "ArrayExpression";
  elements: Expression[];
};

export type MemberExpression = {
  type: "MemberExpression";
  object: Expression;
  property: Expression;
  computed: boolean;
};

export type CallExpression = {
  type: "CallExpression";
  callee: Expression;
  arguments: Expression[];
};

export type Literal = {
  type: "Literal";
  value: number | string | boolean | null;
};

export type Identifier = {
  type: "Identifier";
  name: string;
};

export type BinaryExpression = {
  type: "BinaryExpression";
  operator: string;
  left: Expression;
  right: Expression;
};

export type LogicalExpression = {
  type: "LogicalExpression";
  operator: string;
  left: Expression;
  right: Expression;
};

export type UnaryExpression = {
  type: "UnaryExpression";
  operator: string;
  prefix: boolean;
  argument: Expression;
};

export type AssignmentExpression = {
  type: "AssignmentExpression";
  operator: string;
  left: Identifier | MemberExpression | ObjectPattern | ArrayPattern;
  right: Expression;
};
