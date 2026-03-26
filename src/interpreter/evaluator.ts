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

type JSFunction = {
  [JS_FUNCTION_BRAND]: true;
  params: Identifier[];
  body: BlockStatement;
  closure: Environment;
};

function isJSFunction(value: unknown): value is JSFunction {
  return typeof value === "object" && value !== null && JS_FUNCTION_BRAND in value;
}

type ConsoleOptions = {
  log: (...args: unknown[]) => void;
};

export function evaluate(source: string, consoleOpts?: ConsoleOptions): unknown {
  const ast = parse(source);
  const env = new Environment(null, true); // グローバルは関数スコープ扱い
  env.defineReadOnly("undefined", undefined);

  // console オブジェクトを組み込み
  const consoleObj: Record<string, (...args: unknown[]) => void> = {
    log: consoleOpts?.log ?? console.log,
  };
  env.defineReadOnly("console", consoleObj);

  // 組み込みコンストラクタ
  env.defineReadOnly("Error", { __nativeConstructor: true, name: "Error" });

  return evalProgram(ast, env);
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
        if (!varEnv.hasOwn(decl.id.name)) {
          varEnv.define(decl.id.name, undefined);
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
          if (!varEnv.hasOwn(decl.id.name)) {
            varEnv.define(decl.id.name, undefined);
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
      };
      env.define(stmt.id.name, fn);
    }
  }
}

function evalStatement(stmt: Statement, env: Environment): unknown {
  switch (stmt.type) {
    case "ExpressionStatement":
      return evalExpression(stmt.expression, env);
    case "VariableDeclaration": {
      for (const decl of stmt.declarations) {
        const value = decl.init ? evalExpression(decl.init, env) : undefined;
        if (stmt.kind === "const") {
          env.defineConst(decl.id.name, value);
        } else if (stmt.kind === "let") {
          env.define(decl.id.name, value);
        } else {
          // var: 関数/グローバルスコープに定義（ブロックを貫通）
          const varEnv = env.findVarScope();
          if (decl.init) {
            varEnv.define(decl.id.name, value);
          } else if (!varEnv.hasOwn(decl.id.name)) {
            varEnv.define(decl.id.name, undefined);
          }
        }
      }
      return undefined;
    }
    case "FunctionDeclaration": {
      // 既にホイスティングで登録済みなので何もしない
      return undefined;
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
    case "BlockStatement": {
      // ブロックスコープ: let/const が閉じるように子環境を作る
      const blockEnv = new Environment(env);
      // ブロック内の let/const を TDZ で事前登録 + 重複チェック
      for (const s of stmt.body) {
        if (s.type === "VariableDeclaration" && s.kind !== "var") {
          for (const decl of s.declarations) {
            if (blockEnv.hasOwn(decl.id.name)) {
              throw new SyntaxError(`Identifier '${decl.id.name}' has already been declared`);
            }
            blockEnv.declareTDZ(decl.id.name);
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
      };
      // 名前付き関数式の場合、自身のスコープで自分を参照可能にする
      if (expr.id) {
        const fnEnv = new Environment(env);
        fnEnv.define(expr.id.name, fn);
        fn.closure = fnEnv;
      }
      return fn;
    }
    case "NewExpression":
      return evalNewExpression(expr, env);
    case "ObjectExpression": {
      const obj: Record<string, unknown> = {};
      for (const prop of expr.properties) {
        const key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value);
        obj[key] = evalExpression(prop.value, env);
      }
      return obj;
    }
    case "ArrayExpression": {
      return expr.elements.map((el) => evalExpression(el, env));
    }
    case "MemberExpression": {
      const obj = evalExpression(expr.object, env) as Record<string, unknown>;
      const key = resolveMemberKey(expr, env);
      return obj[key];
    }
    case "AssignmentExpression": {
      if (expr.left.type === "MemberExpression") {
        // ECMAScript: 左辺 (object, key) を先に評価、その後に右辺を評価
        const obj = evalExpression(expr.left.object, env) as Record<string, unknown>;
        const key = resolveMemberKey(expr.left, env);
        const value = evalExpression(expr.right, env);
        obj[key] = value;
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
  const args = expr.arguments.map((arg) => evalExpression(arg, env));

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

  // 新しいオブジェクトを作成
  const newObj: Record<string, unknown> = {};

  // 関数スコープを作成し this を新オブジェクトにバインド
  const fnEnv = new Environment(constructor.closure, true);
  fnEnv.setThis(newObj);
  for (let i = 0; i < constructor.params.length; i++) {
    fnEnv.define(constructor.params[i].name, args[i] ?? undefined);
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
    fn = (thisValue as Record<string, unknown>)[key];
  } else {
    fn = evalExpression(expr.callee, env);
  }

  const args = expr.arguments.map((arg) => evalExpression(arg, env));

  // ネイティブ関数 (console.log 等)
  if (typeof fn === "function") {
    return (fn as Function)(...args);
  }

  if (!isJSFunction(fn)) {
    throw new TypeError(`${typeof fn} is not a function`);
  }

  const jsFn = fn;

  // 新しいスコープを作成（親 = 関数定義時のスコープ = クロージャ）
  const fnEnv = new Environment(jsFn.closure, true); // 関数スコープ
  fnEnv.setThis(thisValue);

  // 仮引数に実引数をバインド
  for (let i = 0; i < jsFn.params.length; i++) {
    fnEnv.define(jsFn.params[i].name, args[i] ?? undefined);
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
