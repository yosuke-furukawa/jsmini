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
  | ReturnStatement
  | ThrowStatement
  | TryStatement
  | IfStatement
  | WhileStatement
  | ForStatement
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
  id: Identifier;
  init: Expression | null;
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
  | BinaryExpression
  | LogicalExpression
  | UnaryExpression
  | AssignmentExpression;

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
  left: Identifier | MemberExpression;
  right: Expression;
};
