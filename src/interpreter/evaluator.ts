import { parse } from "../parser/parser.js";
import type { Program, Statement, Expression, Identifier, BlockStatement, MemberExpression } from "../parser/ast.js";
import { Environment } from "./environment.js";

// MemberExpression のキーを解決する共通ヘルパー
function resolveMemberKey(expr: MemberExpression, env: Environment): string {
  if (expr.computed) {
    return String(evalExpression(expr.property, env));
  }
  return (expr.property as Identifier).name;
}

// Step コールバック (evaluate 実行中のみ有効)
let _currentOnStep: ((info: StepInfo) => void) | null = null;

// return 文の制御フローを例外で表現する
class ReturnSignal {
  value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

// throw 文の制御フローを例外で表現する
class ThrowSignal {
  value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

// 関数オブジェクトの内部表現
const JS_FUNCTION_BRAND = Symbol("JSFunction");
const PROTO_KEY = "__proto__";

type JSObject = Record<string, unknown>;

type JSFunction = {
  [JS_FUNCTION_BRAND]: true;
  params: Identifier[];
  body: BlockStatement;
  closure: Environment;
  isArrow?: boolean;
  isClass?: boolean;
  prototype: JSObject; // Ctor.prototype
  [key: string]: unknown; // 関数もプロパティを持てる
};

function isJSFunction(value: unknown): value is JSFunction {
  return typeof value === "object" && value !== null && JS_FUNCTION_BRAND in value;
}

// プロトタイプチェーンを辿ってプロパティを取得
function getProperty(obj: JSObject, key: string): unknown {
  let current: JSObject | null = obj;
  while (current !== null && current !== undefined) {
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      return current[key];
    }
    current = (current[PROTO_KEY] as JSObject | null) ?? null;
  }
  return undefined;
}

// プロトタイプチェーン上にプロパティがあるか
function hasProperty(obj: JSObject, key: string): boolean {
  let current: JSObject | null = obj;
  while (current !== null && current !== undefined) {
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      return true;
    }
    current = (current[PROTO_KEY] as JSObject | null) ?? null;
  }
  return false;
}

type ConsoleOptions = {
  log: (...args: unknown[]) => void;
};

export type StepInfo = {
  type: string;
  env: { scope: string; variables: Record<string, unknown> }[];
};

type EvalOptions = {
  console?: ConsoleOptions;
  onStep?: (info: StepInfo) => void;
};

export function evaluate(source: string, opts?: ConsoleOptions | EvalOptions): unknown {
  // 後方互換: ConsoleOptions を直接渡された場合
  const options: EvalOptions = opts && "log" in opts ? { console: opts as ConsoleOptions } : (opts as EvalOptions) ?? {};

  const ast = parse(source);
  const env = new Environment(null, true); // グローバルは関数スコープ扱い
  env.defineReadOnly("undefined", undefined);

  // console オブジェクトを組み込み
  const consoleObj: Record<string, (...args: unknown[]) => void> = {
    log: options.console?.log ?? console.log,
  };
  env.defineReadOnly("console", consoleObj);
  const onStep = options.onStep ?? null;

  // 組み込みコンストラクタ
  env.defineReadOnly("Error", { __nativeConstructor: true, name: "Error" });

  _currentOnStep = onStep;
  try {
    return evalProgram(ast, env);
  } finally {
    _currentOnStep = null;
  }
}

function evalProgram(program: Program, env: Environment): unknown {
  hoistVarDeclarations(program.body, env);
  hoistFunctionDeclarations(program.body, env);
  let result: unknown = undefined;
  for (const stmt of program.body) {
    result = evalStatement(stmt, env);
  }
  return result;
}

// var 宣言を事前に undefined で登録する（ホイスティング）
function hoistVarDeclarations(stmts: Statement[], env: Environment): void {
  for (const stmt of stmts) {
    if (stmt.type === "VariableDeclaration" && stmt.kind === "var") {
      const varEnv = env.findVarScope();
      for (const decl of stmt.declarations) {
        for (const name of collectBoundNames(decl.id)) {
          if (!varEnv.hasOwn(name)) {
            varEnv.define(name, undefined);
          }
        }
      }
    } else if (stmt.type === "BlockStatement") {
      hoistVarDeclarations(stmt.body, env);
    } else if (stmt.type === "IfStatement") {
      hoistVarDeclarations([stmt.consequent], env);
      if (stmt.alternate) {
        hoistVarDeclarations([stmt.alternate], env);
      }
    } else if (stmt.type === "WhileStatement") {
      hoistVarDeclarations([stmt.body], env);
    } else if (stmt.type === "ForStatement") {
      if (stmt.init && stmt.init.type === "VariableDeclaration" && stmt.init.kind === "var") {
        const varEnv = env.findVarScope();
        for (const decl of stmt.init.declarations) {
          for (const name of collectBoundNames(decl.id)) {
            if (!varEnv.hasOwn(name)) {
              varEnv.define(name, undefined);
            }
          }
        }
      }
      hoistVarDeclarations([stmt.body], env);
    } else if (stmt.type === "ForOfStatement") {
      if (stmt.left.kind === "var") {
        const varEnv = env.findVarScope();
        for (const decl of stmt.left.declarations) {
          for (const name of collectBoundNames(decl.id)) {
            if (!varEnv.hasOwn(name)) {
              varEnv.define(name, undefined);
            }
          }
        }
      }
      hoistVarDeclarations([stmt.body], env);
    }
  }
}

// 関数宣言を事前に登録する（関数ホイスティング）
function hoistFunctionDeclarations(stmts: Statement[], env: Environment): void {
  for (const stmt of stmts) {
    if (stmt.type === "FunctionDeclaration") {
      const fn: JSFunction = {
        [JS_FUNCTION_BRAND]: true,
        params: stmt.params,
        body: stmt.body,
        closure: env,
        prototype: {},
      };
      env.define(stmt.id.name, fn);
    }
  }
}

function evalClassDeclaration(stmt: Statement & { type: "ClassDeclaration" }, env: Environment): unknown {
  const superClass = stmt.superClass ? evalExpression(stmt.superClass, env) as JSFunction | null : null;

  // constructor メソッドを探す
  const ctorMethod = stmt.body.body.find((m) => m.kind === "constructor");

  // コンストラクタ関数を作成
  let ctorFn: JSFunction;
  if (ctorMethod) {
    ctorFn = {
      [JS_FUNCTION_BRAND]: true,
      params: ctorMethod.value.params,
      body: ctorMethod.value.body,
      closure: env,
      isClass: true,
      prototype: {},
    };
  } else if (superClass) {
    ctorFn = {
      [JS_FUNCTION_BRAND]: true,
      params: superClass.params,
      body: superClass.body,
      closure: superClass.closure,
      isClass: true,
      prototype: {},
    };
  } else {
    ctorFn = {
      [JS_FUNCTION_BRAND]: true,
      params: [],
      body: { type: "BlockStatement", body: [] },
      closure: env,
      isClass: true,
      prototype: {},
    };
  }

  // メソッドを prototype に登録
  for (const method of stmt.body.body) {
    if (method.kind === "method") {
      const fn: JSFunction = {
        [JS_FUNCTION_BRAND]: true,
        params: method.value.params,
        body: method.value.body,
        closure: env,
        prototype: {},
      };
      ctorFn.prototype[method.key.name] = fn;
    }
  }

  // extends: プロトタイプチェーンを接続
  if (superClass) {
    ctorFn.prototype[PROTO_KEY] = superClass.prototype;
    // super を呼べるように __super__ を closure に入れる
    const classEnv = new Environment(env);
    classEnv.define("__super__", superClass);
    ctorFn.closure = classEnv;
    // メソッドの closure も更新
    for (const method of stmt.body.body) {
      if (method.kind === "method") {
        (ctorFn.prototype[method.key.name] as JSFunction).closure = classEnv;
      }
    }
  }

  env.define(stmt.id.name, ctorFn);
  return undefined;
}

// Pattern から束縛される変数名を全て収集する (BoundNames)
function collectBoundNames(pattern: any): string[] {
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "ObjectPattern") {
    const names: string[] = [];
    for (const prop of pattern.properties) {
      names.push(...collectBoundNames(prop.value));
    }
    return names;
  }
  if (pattern.type === "ArrayPattern") {
    const names: string[] = [];
    for (const el of pattern.elements) {
      if (el) names.push(...collectBoundNames(el));
    }
    return names;
  }
  return [];
}

// パターンに対して値を分解して環境に定義する
function bindPattern(pattern: any, value: unknown, env: Environment, kind: "var" | "let" | "const"): void {
  if (pattern.type === "Identifier") {
    if (kind === "const") {
      env.defineConst(pattern.name, value);
    } else if (kind === "let") {
      env.define(pattern.name, value);
    } else {
      const varEnv = env.findVarScope();
      varEnv.define(pattern.name, value);
    }
  } else if (pattern.type === "ObjectPattern") {
    const obj = value as Record<string, unknown>;
    for (const prop of pattern.properties) {
      const propValue = obj ? getProperty(obj as JSObject, prop.key.name) : undefined;
      bindPattern(prop.value, propValue, env, kind);
    }
  } else if (pattern.type === "ArrayPattern") {
    const arr = value as unknown[];
    for (let i = 0; i < pattern.elements.length; i++) {
      if (pattern.elements[i]) {
        bindPattern(pattern.elements[i], arr?.[i], env, kind);
      }
    }
  }
}

// 引数リストを評価（SpreadElement を展開）
function evalArguments(argNodes: any[], env: Environment): unknown[] {
  const result: unknown[] = [];
  for (const arg of argNodes) {
    if (arg.type === "SpreadElement") {
      const arr = evalExpression(arg.argument, env) as unknown[];
      result.push(...arr);
    } else {
      result.push(evalExpression(arg, env));
    }
  }
  return result;
}

// 代入式の分割代入: 既存変数に値を set する
function assignPattern(pattern: any, value: unknown, env: Environment): void {
  if (pattern.type === "Identifier") {
    env.set(pattern.name, value);
  } else if (pattern.type === "ObjectPattern") {
    const obj = value as Record<string, unknown>;
    for (const prop of pattern.properties) {
      const propValue = obj ? getProperty(obj as JSObject, prop.key.name) : undefined;
      assignPattern(prop.value, propValue, env);
    }
  } else if (pattern.type === "ArrayPattern") {
    const arr = value as unknown[];
    for (let i = 0; i < pattern.elements.length; i++) {
      if (pattern.elements[i]) {
        assignPattern(pattern.elements[i], arr?.[i], env);
      }
    }
  }
}

function evalStatement(stmt: Statement, env: Environment): unknown {
  if (_currentOnStep && stmt.type !== "BlockStatement") {
    _currentOnStep({ type: stmt.type, env: env.dump() });
  }
  switch (stmt.type) {
    case "ExpressionStatement":
      return evalExpression(stmt.expression, env);
    case "VariableDeclaration": {
      for (const decl of stmt.declarations) {
        const value = decl.init ? evalExpression(decl.init, env) : undefined;
        if (decl.id.type === "Identifier" && stmt.kind === "var" && !decl.init) {
          // var 再宣言（初期化なし）の no-op 処理
          const varEnv = env.findVarScope();
          if (!varEnv.hasOwn(decl.id.name)) {
            varEnv.define(decl.id.name, undefined);
          }
        } else {
          bindPattern(decl.id, value, env, stmt.kind);
        }
      }
      return undefined;
    }
    case "FunctionDeclaration": {
      // 既にホイスティングで登録済みなので何もしない
      return undefined;
    }
    case "ClassDeclaration": {
      return evalClassDeclaration(stmt, env);
    }
    case "ReturnStatement": {
      const value = stmt.argument ? evalExpression(stmt.argument, env) : undefined;
      throw new ReturnSignal(value);
    }
    case "ThrowStatement": {
      const value = evalExpression(stmt.argument, env);
      throw new ThrowSignal(value);
    }
    case "TryStatement": {
      let result: unknown = undefined;
      let thrown: { error: unknown } | null = null;

      try {
        result = evalStatement(stmt.block, env);
      } catch (e) {
        if (e instanceof ReturnSignal) {
          // return は try/catch を突き抜ける（finally は実行する）
          if (stmt.finalizer) evalStatement(stmt.finalizer, env);
          throw e;
        }

        // ThrowSignal または JS ランタイムエラー (ReferenceError 等)
        const errorValue = e instanceof ThrowSignal ? e.value : e;

        if (stmt.handler) {
          const catchEnv = new Environment(env);
          catchEnv.define(stmt.handler.param.name, errorValue);
          try {
            result = evalStatement(stmt.handler.body, catchEnv);
          } catch (catchError) {
            // catch ブロック内の例外も finally の後に再 throw
            if (stmt.finalizer) evalStatement(stmt.finalizer, env);
            throw catchError;
          }
        } else {
          // catch がない場合、finally の後に再 throw
          thrown = { error: e };
        }
      }

      if (stmt.finalizer) {
        evalStatement(stmt.finalizer, env);
      }

      // catch がなく throw された場合は再 throw
      if (thrown) {
        throw thrown.error;
      }

      return result;
    }
    case "IfStatement": {
      const test = evalExpression(stmt.test, env);
      if (test) {
        return evalStatement(stmt.consequent, env);
      } else if (stmt.alternate) {
        return evalStatement(stmt.alternate, env);
      }
      return undefined;
    }
    case "WhileStatement": {
      while (evalExpression(stmt.test, env)) {
        evalStatement(stmt.body, env);
      }
      return undefined;
    }
    case "ForStatement": {
      // let/const の場合、for 全体を囲むスコープを作る
      const isBlockScoped = stmt.init?.type === "VariableDeclaration" && stmt.init.kind !== "var";
      const forEnv = isBlockScoped ? new Environment(env) : env;

      if (stmt.init) {
        if (stmt.init.type === "VariableDeclaration") {
          evalStatement(stmt.init, forEnv);
        } else {
          evalExpression(stmt.init, forEnv);
        }
      }
      while (!stmt.test || evalExpression(stmt.test, forEnv)) {
        evalStatement(stmt.body, forEnv);
        if (stmt.update) evalExpression(stmt.update, forEnv);
      }
      return undefined;
    }
    case "ForOfStatement": {
      const iterable = evalExpression(stmt.right, env) as unknown[];
      const kind = stmt.left.kind;
      const isBlockScoped = kind !== "var";
      const pattern = stmt.left.declarations[0].id;

      for (const item of iterable) {
        // let/const: 各イテレーションで新しいスコープを作成
        const iterEnv = isBlockScoped ? new Environment(env) : env;
        bindPattern(pattern, item, iterEnv, kind);
        evalStatement(stmt.body, iterEnv);
      }
      return undefined;
    }
    case "BlockStatement": {
      // ブロックスコープ: let/const が閉じるように子環境を作る
      const blockEnv = new Environment(env);
      // ブロック内の let/const を TDZ で事前登録 + 重複チェック
      for (const s of stmt.body) {
        if (s.type === "VariableDeclaration" && s.kind !== "var") {
          for (const decl of s.declarations) {
            for (const name of collectBoundNames(decl.id)) {
              if (blockEnv.hasOwn(name)) {
                throw new SyntaxError(`Identifier '${name}' has already been declared`);
              }
              blockEnv.declareTDZ(name);
            }
          }
        }
      }
      let result: unknown = undefined;
      for (const s of stmt.body) {
        result = evalStatement(s, blockEnv);
      }
      return result;
    }
  }
}

function evalExpression(expr: Expression, env: Environment): unknown {
  switch (expr.type) {
    case "Literal":
      return expr.value;
    case "Identifier":
      return env.get(expr.name);
    case "ThisExpression":
      return env.getThis();
    case "FunctionExpression": {
      const fn: JSFunction = {
        [JS_FUNCTION_BRAND]: true,
        params: expr.params,
        body: expr.body,
        closure: env,
        prototype: {},
      };
      // 名前付き関数式の場合、自身のスコープで自分を参照可能にする
      if (expr.id) {
        const fnEnv = new Environment(env);
        fnEnv.define(expr.id.name, fn);
        fn.closure = fnEnv;
      }
      return fn;
    }
    case "ArrowFunctionExpression": {
      const fn: JSFunction = {
        [JS_FUNCTION_BRAND]: true,
        params: expr.params,
        body: expr.expression
          ? { type: "BlockStatement", body: [{ type: "ReturnStatement", argument: expr.body as Expression }] }
          : expr.body as { type: "BlockStatement"; body: Statement[] },
        closure: env,
        isArrow: true,
        prototype: undefined as any, // アロー関数は prototype を持たない
      };
      return fn;
    }
    case "TemplateLiteral": {
      let result = "";
      for (let i = 0; i < expr.quasis.length; i++) {
        result += expr.quasis[i].value.cooked;
        if (i < expr.expressions.length) {
          result += String(evalExpression(expr.expressions[i], env));
        }
      }
      return result;
    }
    case "SequenceExpression": {
      let result: unknown = undefined;
      for (const e of expr.expressions) {
        result = evalExpression(e, env);
      }
      return result;
    }
    case "NewExpression":
      return evalNewExpression(expr, env);
    case "ObjectExpression": {
      const obj: Record<string, unknown> = {};
      for (const prop of expr.properties) {
        if (prop.type === "SpreadElement") {
          const source = evalExpression(prop.argument, env) as Record<string, unknown>;
          if (source) Object.assign(obj, source);
        } else {
          const key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value);
          obj[key] = evalExpression(prop.value, env);
        }
      }
      return obj;
    }
    case "ArrayExpression": {
      const result: unknown[] = [];
      for (const el of expr.elements) {
        if (el.type === "SpreadElement") {
          const arr = evalExpression(el.argument, env) as unknown[];
          result.push(...arr);
        } else {
          result.push(evalExpression(el, env));
        }
      }
      return result;
    }
    case "MemberExpression": {
      const obj = evalExpression(expr.object, env);
      if (obj === null || obj === undefined) {
        const key = resolveMemberKey(expr, env);
        throw new TypeError(`Cannot read properties of ${obj} (reading '${key}')`);
      }
      const key = resolveMemberKey(expr, env);
      return getProperty(obj as JSObject, key);
    }
    case "AssignmentExpression": {
      if (expr.left.type === "MemberExpression") {
        const obj = evalExpression(expr.left.object, env) as Record<string, unknown>;
        const key = resolveMemberKey(expr.left, env);
        const value = evalExpression(expr.right, env);
        obj[key] = value;
        return value;
      }
      if (expr.left.type === "ObjectPattern" || expr.left.type === "ArrayPattern") {
        const value = evalExpression(expr.right, env);
        assignPattern(expr.left, value, env);
        return value;
      }
      const value = evalExpression(expr.right, env);
      env.set(expr.left.name, value);
      return value;
    }
    case "CallExpression":
      return evalCallExpression(expr, env);
    case "UnaryExpression":
      return evalUnaryExpression(expr, env);
    case "LogicalExpression":
      return evalLogicalExpression(expr, env);
    case "BinaryExpression":
      return evalBinaryExpression(expr, env);
  }
}

function evalNewExpression(
  expr: Expression & { type: "NewExpression" },
  env: Environment,
): unknown {
  const constructor = evalExpression(expr.callee, env);
  const args = evalArguments(expr.arguments, env);

  // 組み込みコンストラクタ (Error 等)
  if (typeof constructor === "object" && constructor !== null && "__nativeConstructor" in constructor) {
    const ctor = constructor as { name: string };
    if (ctor.name === "Error") {
      return { message: args[0] ?? "" };
    }
    throw new Error(`Unknown native constructor: ${ctor.name}`);
  }

  if (!isJSFunction(constructor)) {
    throw new TypeError("Constructor is not a function");
  }

  if (constructor.isArrow) {
    throw new TypeError("Arrow function is not a constructor");
  }

  // 新しいオブジェクトを作成し、prototype チェーンを接続
  const newObj: Record<string, unknown> = {};
  newObj[PROTO_KEY] = constructor.prototype;

  // 関数スコープを作成し this を新オブジェクトにバインド
  const fnEnv = new Environment(constructor.closure, true);
  fnEnv.setThis(newObj);
  for (let i = 0; i < constructor.params.length; i++) {
    const param = constructor.params[i];
    if (param.type === "RestElement") {
      fnEnv.define(param.argument.name, args.slice(i));
    } else {
      bindPattern(param, args[i] ?? undefined, fnEnv, "let");
    }
  }
  hoistVarDeclarations(constructor.body.body, fnEnv);
  hoistFunctionDeclarations(constructor.body.body, fnEnv);

  let returnValue: unknown = undefined;
  try {
    for (const stmt of constructor.body.body) {
      evalStatement(stmt, fnEnv);
    }
  } catch (e) {
    if (e instanceof ReturnSignal) {
      returnValue = e.value;
    } else {
      throw e;
    }
  }

  // コンストラクタがオブジェクトを return したらそれを使う。プリミティブなら this を使う。
  if (returnValue !== undefined && typeof returnValue === "object" && returnValue !== null) {
    return returnValue;
  }
  return newObj;
}

function evalCallExpression(
  expr: Expression & { type: "CallExpression" },
  env: Environment,
): unknown {
  // メソッド呼び出し (obj.method()) の場合、this をバインドする
  let thisValue: unknown = undefined;
  let fn: unknown;
  if (expr.callee.type === "MemberExpression") {
    thisValue = evalExpression(expr.callee.object, env);
    const key = resolveMemberKey(expr.callee, env);
    fn = getProperty(thisValue as JSObject, key);
  } else {
    fn = evalExpression(expr.callee, env);
  }

  const args = evalArguments(expr.arguments, env);

  // super() 呼び出し: 親コンストラクタを現在の this で実行
  if (expr.callee.type === "Identifier" && expr.callee.name === "__super__" && isJSFunction(fn)) {
    const superFn = fn;
    const superEnv = new Environment(superFn.closure, true);
    superEnv.setThis(env.getThis());
    for (let i = 0; i < superFn.params.length; i++) {
      const param = superFn.params[i];
      if (param.type === "RestElement") {
        superEnv.define(param.argument.name, args.slice(i));
      } else {
        bindPattern(param, args[i] ?? undefined, superEnv, "let");
      }
    }
    hoistVarDeclarations(superFn.body.body, superEnv);
    hoistFunctionDeclarations(superFn.body.body, superEnv);
    try {
      for (const s of superFn.body.body) {
        evalStatement(s, superEnv);
      }
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
    return undefined;
  }

  // ネイティブ関数 (console.log 等)
  if (typeof fn === "function") {
    return (fn as Function)(...args);
  }

  if (!isJSFunction(fn)) {
    throw new TypeError(`${typeof fn} is not a function`);
  }

  if (fn.isClass) {
    throw new TypeError("Class constructor cannot be invoked without 'new'");
  }

  const jsFn = fn;

  // 新しいスコープを作成（親 = 関数定義時のスコープ = クロージャ）
  // アロー関数は自身の this を持たない（クロージャの this を継承）
  const fnEnv = new Environment(jsFn.closure, !jsFn.isArrow);
  if (!jsFn.isArrow) {
    fnEnv.setThis(thisValue);
  }

  // 仮引数に実引数をバインド（分割代入 + レスト対応）
  for (let i = 0; i < jsFn.params.length; i++) {
    const param = jsFn.params[i];
    if (param.type === "RestElement") {
      fnEnv.define(param.argument.name, args.slice(i));
    } else {
      bindPattern(param, args[i] ?? undefined, fnEnv, "let");
    }
  }

  // 関数本体内の var と function をホイスト
  hoistVarDeclarations(jsFn.body.body, fnEnv);
  hoistFunctionDeclarations(jsFn.body.body, fnEnv);

  try {
    for (const stmt of jsFn.body.body) {
      evalStatement(stmt, fnEnv);
    }
  } catch (e) {
    if (e instanceof ReturnSignal) {
      return e.value;
    }
    throw e;
  }
  return undefined;
}

function evalUnaryExpression(
  expr: Expression & { type: "UnaryExpression" },
  env: Environment,
): unknown {
  if (expr.operator === "typeof") {
    let value: unknown;
    if (expr.argument.type === "Identifier") {
      try {
        value = env.get(expr.argument.name);
      } catch (e) {
        // TDZ (Cannot access before initialization) は ReferenceError のまま投げる
        if (e instanceof ReferenceError && e.message.includes("before initialization")) {
          throw e;
        }
        // 未定義変数は "undefined" を返す（ReferenceError にしない）
        return "undefined";
      }
    } else {
      value = evalExpression(expr.argument, env);
    }
    if (value === null) return "object";
    if (isJSFunction(value)) return "function";
    return typeof value;
  }

  const argument = evalExpression(expr.argument, env);
  switch (expr.operator) {
    case "!": return !argument;
    case "-": return -(argument as number);
    default:
      throw new Error(`Unknown unary operator: ${expr.operator}`);
  }
}

function evalLogicalExpression(
  expr: Expression & { type: "LogicalExpression" },
  env: Environment,
): unknown {
  const left = evalExpression(expr.left, env);
  switch (expr.operator) {
    case "&&": return left ? evalExpression(expr.right, env) : left;
    case "||": return left ? left : evalExpression(expr.right, env);
    default:
      throw new Error(`Unknown logical operator: ${expr.operator}`);
  }
}

function evalBinaryExpression(
  expr: Expression & { type: "BinaryExpression" },
  env: Environment,
): unknown {
  const left = evalExpression(expr.left, env);
  const right = evalExpression(expr.right, env);
  switch (expr.operator) {
    case "+":
      if (typeof left === "string" || typeof right === "string") {
        return String(left) + String(right);
      }
      return (left as number) + (right as number);
    case "-": return (left as number) - (right as number);
    case "*": return (left as number) * (right as number);
    case "/": return (left as number) / (right as number);
    case "%": return (left as number) % (right as number);
    case "<": return (left as number) < (right as number);
    case ">": return (left as number) > (right as number);
    case "<=": return (left as number) <= (right as number);
    case ">=": return (left as number) >= (right as number);
    case "==": return left == right;
    case "===": return left === right;
    case "!=": return left != right;
    case "!==": return left !== right;
    default:
      throw new Error(`Unknown operator: ${expr.operator}`);
  }
}
