import { parse } from "../parser/parser.js";
import type { Program, Statement, Expression, Identifier, BlockStatement, MemberExpression } from "../parser/ast.js";
import { Environment } from "./environment.js";
import {
  ReturnSignal, ThrowSignal, BreakSignal, ContinueSignal,
  JS_FUNCTION_BRAND, PROTO_KEY,
  type JSObject, type JSFunction,
  isJSFunction, createJSFunction, getProperty,
  collectBoundNames, bindPattern, assignPattern,
} from "./values.js";
import { isJSString, createSeqString, jsStringConcat, jsStringEquals, jsStringToString, internString, type JSString } from "../vm/js-string.js";
import { createSymbol, isJSSymbol, SYMBOL_ITERATOR, SYMBOL_TO_PRIMITIVE, SYMBOL_HAS_INSTANCE, SYMBOL_TO_STRING_TAG } from "../vm/js-symbol.js";

// JSString 対応の truthiness 判定 (空文字列は falsy)
function isTruthy(value: unknown): boolean {
  if (isJSString(value)) return value.length > 0;
  return !!value;
}

// Generator を同期的に最後まで実行するヘルパー
function exhaustGen(gen: Generator): unknown {
  let r = gen.next();
  while (!r.done) r = gen.next(undefined);
  return r.value;
}

// ToPrimitive: オブジェクトの valueOf/toString を呼んでプリミティブに変換
function toPrimitive(value: unknown, hint: "number" | "string" = "number"): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (isJSString(value)) return value;
  if (Array.isArray(value)) return value;

  const obj = value as Record<string, unknown>;
  const methods = hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
  for (const name of methods) {
    const method = getProperty(obj, name);
    if (typeof method === "function") {
      const result = (method as Function).call(obj);
      if (result === null || result === undefined || typeof result !== "object" || isJSString(result)) {
        return result;
      }
    }
    if (isJSFunction(method)) {
      const jsFn = method;
      const fnEnv = new Environment(jsFn.closure, true);
      fnEnv.setThis(obj);
      hoistVarDeclarations(jsFn.body.body, fnEnv);
      try {
        for (const s of jsFn.body.body) exhaustGen(evalStatement(s, fnEnv));
      } catch (e) {
        if (e instanceof ReturnSignal) {
          const r = e.value;
          if (r === null || r === undefined || typeof r !== "object" || isJSString(r)) return r;
          continue;
        }
        throw e;
      }
    }
  }
  throw new TypeError("Cannot convert object to primitive value");
}

// MemberExpression のキーを解決する共通ヘルパー
function* resolveMemberKey(expr: MemberExpression, env: Environment): Generator<unknown, string, unknown> {
  if (expr.computed) {
    const key = yield* evalExpression(expr.property, env);
    return isJSSymbol(key) ? key.key : isJSString(key) ? jsStringToString(key) : String(key);
  }
  return (expr.property as Identifier).name;
}

// Step コールバック (evaluate 実行中のみ有効)
let _currentOnStep: ((info: StepInfo) => void) | null = null;

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
  globals?: Record<string, unknown>;
};

export function evaluate(source: string, opts?: ConsoleOptions | EvalOptions): unknown {
  // 後方互換: ConsoleOptions を直接渡された場合
  const options: EvalOptions = opts && "log" in opts ? { console: opts as ConsoleOptions } : (opts as EvalOptions) ?? {};

  const ast = parse(source);
  const env = new Environment(null, true); // グローバルは関数スコープ扱い
  env.defineReadOnly("undefined", undefined);
  env.defineReadOnly("NaN", NaN);
  env.defineReadOnly("Infinity", Infinity);
  env.defineReadOnly("ReferenceError", ReferenceError);
  env.defineReadOnly("TypeError", TypeError);
  env.defineReadOnly("SyntaxError", SyntaxError);
  env.defineReadOnly("RangeError", RangeError);
  env.defineReadOnly("Boolean", Boolean);
  env.defineReadOnly("Number", Number);
  // String: JSString を受け取れるカスタムコンストラクタ
  const StringCtor = function(this: any, v?: unknown) {
    const s = isJSString(v) ? jsStringToString(v) : (v === undefined ? "" : String(v));
    if (new.target) return new String(s);
    return internString(s);
  } as unknown as StringConstructor;
  StringCtor.fromCharCode = (...codes: number[]) => internString(String.fromCharCode(...codes));
  (StringCtor as any).prototype = String.prototype;
  env.defineReadOnly("String", StringCtor);
  env.defineReadOnly("Array", Array);
  env.defineReadOnly("Function", Function);

  // グローバル関数
  env.defineReadOnly("isNaN", (v: unknown) => Number.isNaN(Number(v)));
  env.defineReadOnly("isFinite", (v: unknown) => Number.isFinite(Number(v)));
  env.defineReadOnly("parseInt", (s: unknown, radix?: number) => parseInt(isJSString(s) ? jsStringToString(s) : String(s), radix));
  env.defineReadOnly("parseFloat", (s: unknown) => parseFloat(isJSString(s) ? jsStringToString(s) : String(s)));

  // Math
  env.defineReadOnly("Math", {
    floor: Math.floor, ceil: Math.ceil, round: Math.round,
    abs: Math.abs, min: Math.min, max: Math.max,
    sqrt: Math.sqrt, pow: Math.pow, log: Math.log,
    random: Math.random, PI: Math.PI, E: Math.E,
    sign: Math.sign, trunc: Math.trunc,
  });

  // Object
  const strArg = (v: unknown) => isJSString(v) ? jsStringToString(v) : String(v);
  const twObjectWrapper: any = function(...args: unknown[]) { return new Object(...args); };
  twObjectWrapper.keys = (obj: unknown) => {
    if (typeof obj === "object" && obj !== null) {
      return Object.keys(obj).filter(k => k !== "__proto__" && k !== "__hc__" && k !== "__slots__" && !k.startsWith("Symbol("));
    }
    return [];
  };
  twObjectWrapper.values = (obj: unknown) => {
    if (typeof obj === "object" && obj !== null) {
      return Object.keys(obj).filter(k => k !== "__proto__" && k !== "__hc__" && k !== "__slots__" && !k.startsWith("Symbol(")).map(k => (obj as any)[k]);
    }
    return [];
  };
  twObjectWrapper.entries = (obj: unknown) => {
    if (typeof obj === "object" && obj !== null) {
      return Object.keys(obj).filter(k => k !== "__proto__" && k !== "__hc__" && k !== "__slots__" && !k.startsWith("Symbol(")).map(k => [k, (obj as any)[k]]);
    }
    return [];
  };
  twObjectWrapper.assign = Object.assign;
  twObjectWrapper.create = Object.create;
  twObjectWrapper.freeze = (obj: unknown) => obj;
  env.defineReadOnly("Object", twObjectWrapper);

  // JSON
  env.defineReadOnly("JSON", {
    stringify: (val: unknown) => {
      const toNative = (v: unknown): unknown => {
        if (isJSString(v)) return jsStringToString(v);
        if (Array.isArray(v)) return v.map(toNative);
        if (v && typeof v === "object") {
          const result: Record<string, unknown> = {};
          for (const k of Object.keys(v).filter(k => k !== "__proto__" && k !== "__hc__" && k !== "__slots__" && !k.startsWith("Symbol("))) {
            result[k] = toNative((v as any)[k]);
          }
          return result;
        }
        return v;
      };
      return internString(JSON.stringify(toNative(val)));
    },
    parse: (s: unknown) => JSON.parse(isJSString(s) ? jsStringToString(s) : String(s)),
  });

  // console オブジェクトを組み込み (JSString → JS string 変換付き)
  const userLog = options.console?.log ?? console.log;
  const consoleObj: Record<string, (...args: unknown[]) => void> = {
    log: (...args: unknown[]) => userLog(...args.map(a => isJSString(a) ? jsStringToString(a) : a)),
  };
  env.defineReadOnly("console", consoleObj);
  const onStep = options.onStep ?? null;

  // 組み込みコンストラクタ
  env.defineReadOnly("Error", { __nativeConstructor: true, name: "Error" });
  // Symbol: 自前実装 (wrapper オブジェクト)
  const SymbolFn: any = (desc?: unknown) => {
    const d = desc !== undefined ? (isJSString(desc) ? jsStringToString(desc) : String(desc)) : "";
    return createSymbol(d);
  };
  SymbolFn.iterator = SYMBOL_ITERATOR;
  SymbolFn.toPrimitive = SYMBOL_TO_PRIMITIVE;
  SymbolFn.hasInstance = SYMBOL_HAS_INSTANCE;
  SymbolFn.toStringTag = SYMBOL_TO_STRING_TAG;
  env.defineReadOnly("Symbol", SymbolFn);

  // 外部から渡されたグローバル変数を注入 (VM eval フォールバック用)
  if (options.globals) {
    for (const [k, v] of Object.entries(options.globals)) {
      if (!env.hasOwn(k)) env.define(k, v);
    }
  }

  // eval: indirect eval (グローバルスコープで実行)
  env.defineReadOnly("eval", (code: unknown) => {
    const s = isJSString(code) ? jsStringToString(code) : String(code);
    return evaluate(s, options);
  });

  _currentOnStep = onStep;
  try {
    const gen = evalProgram(ast, env);
    let result: unknown;
    while (true) {
      const r = gen.next();
      if (r.done) { result = r.value; break; }
    }
    return isJSString(result) ? jsStringToString(result) : result;
  } finally {
    _currentOnStep = null;
  }
}

function* evalProgram(program: Program, env: Environment): Generator<unknown, unknown, unknown> {
  hoistVarDeclarations(program.body, env);
  hoistFunctionDeclarations(program.body, env);
  let result: unknown = undefined;
  for (const stmt of program.body) {
    result = yield* evalStatement(stmt, env);
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
        name: stmt.id.name,
        params: stmt.params,
        body: stmt.body,
        closure: env,
        prototype: {},
      };
      if ((stmt as any).generator) (fn as any).isGenerator = true;
      env.define(stmt.id.name, fn);
    }
  }
}

// getter/setter の本体を実行するヘルパー (generator版)
function* evalBlock(body: Statement[], env: Environment): Generator<unknown, unknown, unknown> {
  let result: unknown = undefined;
  for (const s of body) result = yield* evalStatement(s, env);
  return result;
}

// evalBlock を同期的に実行するヘルパー (getter/setter 用)
function evalBlockSync(body: Statement[], env: Environment): unknown {
  try {
    const gen = evalBlock(body, env);
    let r = gen.next();
    while (!r.done) r = gen.next(undefined);
    return r.value;
  } catch (e) {
    if (e instanceof ReturnSignal) return e.value;
    throw e;
  }
}

function classKeyName(key: any, computed?: boolean, env?: Environment): string {
  if (computed && env) {
    const val = exhaustGen(evalExpression(key, env));
    return isJSString(val) ? jsStringToString(val) : String(val);
  }
  if (key.type === "Literal") return String(key.value);
  return key.name;
}

function* evalClassDeclaration(stmt: Statement & { type: "ClassDeclaration" }, env: Environment): Generator<unknown, unknown, unknown> {
  const superClass = stmt.superClass ? (yield* evalExpression(stmt.superClass, env)) as JSFunction | null : null;

  // constructor メソッドを探す
  const ctorMethod = stmt.body.body.find((m: any) => m.type === "MethodDefinition" && m.kind === "constructor");

  // インスタンスフィールド定義を収集
  const instanceFields = stmt.body.body.filter((m: any) => m.type === "PropertyDefinition" && !m.static);

  // コンストラクタ関数を作成
  let ctorFn: JSFunction;
  const className = stmt.id.name;
  if (ctorMethod) {
    ctorFn = {
      [JS_FUNCTION_BRAND]: true,
      name: className,
      params: ctorMethod.value.params,
      body: ctorMethod.value.body,
      closure: env,
      isClass: true,
      prototype: {},
    };
  } else if (superClass) {
    ctorFn = {
      [JS_FUNCTION_BRAND]: true,
      name: className,
      params: superClass.params,
      body: superClass.body,
      closure: superClass.closure,
      isClass: true,
      prototype: {},
    };
  } else {
    ctorFn = {
      [JS_FUNCTION_BRAND]: true,
      name: className,
      params: [],
      body: { type: "BlockStatement", body: [] },
      closure: env,
      isClass: true,
      prototype: {},
    };
  }

  // インスタンスフィールドを __instanceFields に保存 (new 時に初期化)
  if (instanceFields.length > 0) {
    (ctorFn as any).__instanceFields = instanceFields;
  }

  // メソッド/getter/setter を prototype (or class 自体 for static) に登録
  for (const member of stmt.body.body) {
    if (member.type === "PropertyDefinition") continue; // フィールドは後で処理
    const target = member.static ? ctorFn : ctorFn.prototype;
    const name = classKeyName(member.key, member.computed, env);

    if (member.kind === "method" || member.kind === "constructor") {
      if (member.kind === "constructor") continue; // constructor は ctorFn 自体
      const fn: JSFunction = {
        [JS_FUNCTION_BRAND]: true,
        name,
        params: member.value.params,
        body: member.value.body,
        closure: env,
        prototype: {},
      };
      if ((member.value as any).generator) (fn as any).isGenerator = true;
      (target as any)[name] = fn;
    } else if (member.kind === "get" || member.kind === "set") {
      const fn: JSFunction = {
        [JS_FUNCTION_BRAND]: true,
        name: `${member.kind} ${name}`,
        params: member.value.params,
        body: member.value.body,
        closure: env,
        prototype: {},
      };
      const descriptor: PropertyDescriptor = Object.getOwnPropertyDescriptor(target, name) ?? {};
      if (member.kind === "get") {
        const getterFn = fn;
        descriptor.get = function() {
          const callEnv = new Environment(getterFn.closure, true);
          callEnv.setThis(this);
          hoistVarDeclarations(getterFn.body.body, callEnv);
          return evalBlockSync(getterFn.body.body, callEnv);
        };
      }
      if (member.kind === "set") {
        const setterFn = fn;
        descriptor.set = function(v: unknown) {
          const callEnv = new Environment(setterFn.closure, true);
          callEnv.setThis(this);
          callEnv.define(setterFn.params[0].name, v);
          hoistVarDeclarations(setterFn.body.body, callEnv);
          evalBlockSync(setterFn.body.body, callEnv);
        };
      }
      descriptor.configurable = true;
      descriptor.enumerable = false;
      Object.defineProperty(target, name, descriptor);
    }
  }

  // static フィールドを初期化
  for (const member of stmt.body.body) {
    if (member.type === "PropertyDefinition" && member.static) {
      const name = classKeyName(member.key, member.computed, env);
      const value = member.value ? yield* evalExpression(member.value, env) : undefined;
      (ctorFn as any)[name] = value;
    }
  }

  // extends: プロトタイプチェーンを接続
  if (superClass) {
    ctorFn.prototype[PROTO_KEY] = superClass.prototype;
    const classEnv = new Environment(env);
    classEnv.define("__super__", superClass);
    ctorFn.closure = classEnv;
    // メソッドの closure も更新
    for (const member of stmt.body.body) {
      if (member.type === "MethodDefinition" && member.kind === "method") {
        const target = member.static ? ctorFn : ctorFn.prototype;
        const name = classKeyName(member.key, member.computed, env);
        if ((target as any)[name] && isJSFunction((target as any)[name])) {
          ((target as any)[name] as JSFunction).closure = classEnv;
        }
      }
    }
  }

  env.define(stmt.id.name, ctorFn);
  return undefined;
}

// collectBoundNames, bindPattern, assignPattern は values.ts に移動済み

// 引数リストを評価（SpreadElement を展開）
function* evalArguments(argNodes: any[], env: Environment): Generator<unknown, unknown[], unknown> {
  const result: unknown[] = [];
  for (const arg of argNodes) {
    if (arg.type === "SpreadElement") {
      const arr = (yield* evalExpression(arg.argument, env)) as unknown[];
      result.push(...arr);
    } else {
      result.push(yield* evalExpression(arg, env));
    }
  }
  return result;
}

function* evalStatement(stmt: Statement, env: Environment): Generator<unknown, unknown, unknown> {
  if (_currentOnStep && stmt.type !== "BlockStatement") {
    _currentOnStep({ type: stmt.type, env: env.dump() });
  }
  switch (stmt.type) {
    case "ExpressionStatement":
      return yield* evalExpression(stmt.expression, env);
    case "VariableDeclaration": {
      for (const decl of stmt.declarations) {
        const value = decl.init ? yield* evalExpression(decl.init, env) : undefined;
        // 変数名から関数の name を推論: var f = function() {} → f.name === "f"
        if (decl.id.type === "Identifier" && isJSFunction(value) && !value.name) {
          value.name = decl.id.name;
        }
        if (decl.id.type === "Identifier" && stmt.kind === "var" && !decl.init) {
          // var 再宣言（初期化なし）の no-op 処理
          const varEnv = env.findVarScope();
          if (!varEnv.hasOwn(decl.id.name)) {
            varEnv.define(decl.id.name, undefined);
          }
        } else {
          bindPattern(decl.id, value, env, stmt.kind, (expr: any) => exhaustGen(evalExpression(expr, env)));
        }
      }
      return undefined;
    }
    case "FunctionDeclaration": {
      // 既にホイスティングで登録済みなので何もしない
      return undefined;
    }
    case "ClassDeclaration": {
      return yield* evalClassDeclaration(stmt, env);
    }
    case "ReturnStatement": {
      const value = stmt.argument ? yield* evalExpression(stmt.argument, env) : undefined;
      throw new ReturnSignal(value);
    }
    case "BreakStatement":
      throw new BreakSignal(stmt.label);
    case "ContinueStatement":
      throw new ContinueSignal(stmt.label);
    case "ThrowStatement": {
      const value = yield* evalExpression(stmt.argument, env);
      throw new ThrowSignal(value);
    }
    case "TryStatement": {
      let result: unknown = undefined;
      let thrown: { error: unknown } | null = null;

      try {
        result = yield* evalStatement(stmt.block, env);
      } catch (e) {
        if (e instanceof ReturnSignal) {
          // return は try/catch を突き抜ける（finally は実行する）
          if (stmt.finalizer) yield* evalStatement(stmt.finalizer, env);
          throw e;
        }

        // ThrowSignal または JS ランタイムエラー (ReferenceError 等)
        const errorValue = e instanceof ThrowSignal ? e.value : e;

        if (stmt.handler) {
          const catchEnv = new Environment(env);
          catchEnv.define(stmt.handler.param.name, errorValue);
          try {
            result = yield* evalStatement(stmt.handler.body, catchEnv);
          } catch (catchError) {
            // catch ブロック内の例外も finally の後に再 throw
            if (stmt.finalizer) yield* evalStatement(stmt.finalizer, env);
            throw catchError;
          }
        } else {
          // catch がない場合、finally の後に再 throw
          thrown = { error: e };
        }
      }

      if (stmt.finalizer) {
        yield* evalStatement(stmt.finalizer, env);
      }

      // catch がなく throw された場合は再 throw
      if (thrown) {
        throw thrown.error;
      }

      return result;
    }
    case "IfStatement": {
      const test = yield* evalExpression(stmt.test, env);
      if (isTruthy(test)) {
        return yield* evalStatement(stmt.consequent, env);
      } else if (stmt.alternate) {
        return yield* evalStatement(stmt.alternate, env);
      }
      return undefined;
    }
    case "SwitchStatement": {
      const disc = yield* evalExpression(stmt.discriminant, env);
      let matched = false;
      let result: unknown = undefined;
      for (const c of stmt.cases) {
        if (!matched && c.test !== null) {
          const testVal = yield* evalExpression(c.test, env);
          // JSString 対応の === 比較
          if (isJSString(disc) && isJSString(testVal)) {
            matched = jsStringEquals(disc, testVal);
          } else {
            matched = disc === testVal;
          }
        }
        if (!matched && c.test === null) matched = true; // default
        if (matched) {
          for (const s of c.consequent) {
            try {
              result = yield* evalStatement(s, env);
            } catch (e) {
              if (e instanceof BreakSignal && !e.label) return result;
              throw e;
            }
          }
        }
      }
      return result;
    }
    case "ForInStatement": {
      const lbl = (stmt as any).__label__ as string | undefined;
      const obj = yield* evalExpression(stmt.right, env);
      if (obj === null || obj === undefined) return undefined;
      const keys = typeof obj === "object" ? Object.keys(obj).filter(k => k !== "__proto__" && k !== "__hc__" && k !== "__slots__" && !k.startsWith("Symbol(")) : [];
      for (const key of keys) {
        const varName = stmt.left.declarations[0].id.name;
        if (stmt.left.kind === "var") {
          try { env.set(varName, internString(key)); } catch { env.define(varName, internString(key)); }
        } else {
          env.define(varName, internString(key));
        }
        try {
          yield* evalStatement(stmt.body, env);
        } catch (e) {
          if (e instanceof BreakSignal && (!e.label || e.label === lbl)) break;
          if (e instanceof ContinueSignal && (!e.label || e.label === lbl)) continue;
          throw e;
        }
      }
      return undefined;
    }
    case "DoWhileStatement": {
      const lbl = (stmt as any).__label__ as string | undefined;
      outer_dowhile: do {
        try {
          yield* evalStatement(stmt.body, env);
        } catch (e) {
          if (e instanceof BreakSignal && (!e.label || e.label === lbl)) break outer_dowhile;
          if (e instanceof ContinueSignal && (!e.label || e.label === lbl)) continue outer_dowhile;
          throw e;
        }
      } while (isTruthy(yield* evalExpression(stmt.test, env)));
      return undefined;
    }
    case "WhileStatement": {
      const lbl = (stmt as any).__label__ as string | undefined;
      outer_while: while (isTruthy(yield* evalExpression(stmt.test, env))) {
        try {
          yield* evalStatement(stmt.body, env);
        } catch (e) {
          if (e instanceof BreakSignal && (!e.label || e.label === lbl)) break outer_while;
          if (e instanceof ContinueSignal && (!e.label || e.label === lbl)) continue outer_while;
          throw e;
        }
      }
      return undefined;
    }
    case "ForStatement": {
      const lbl = (stmt as any).__label__ as string | undefined;
      const isBlockScoped = stmt.init?.type === "VariableDeclaration" && stmt.init.kind !== "var";
      const forEnv = isBlockScoped ? new Environment(env) : env;

      if (stmt.init) {
        if (stmt.init.type === "VariableDeclaration") {
          yield* evalStatement(stmt.init, forEnv);
        } else {
          yield* evalExpression(stmt.init, forEnv);
        }
      }
      outer_for: while (!stmt.test || isTruthy(yield* evalExpression(stmt.test, forEnv))) {
        try {
          yield* evalStatement(stmt.body, forEnv);
        } catch (e) {
          if (e instanceof BreakSignal && (!e.label || e.label === lbl)) break outer_for;
          if (e instanceof ContinueSignal && (!e.label || e.label === lbl)) { if (stmt.update) yield* evalExpression(stmt.update, forEnv); continue outer_for; }
          throw e;
        }
        if (stmt.update) yield* evalExpression(stmt.update, forEnv);
      }
      return undefined;
    }
    case "ForOfStatement": {
      const lbl = (stmt as any).__label__ as string | undefined;
      const rawIterable = yield* evalExpression(stmt.right, env);
      // iterator プロトコル: "@@iterator" キーがあれば使う、なければ配列として扱う
      let iterable: unknown[];
      const iterKey = "@@iterator";
      const iterFn = typeof rawIterable === "object" && rawIterable !== null
        ? getProperty(rawIterable as JSObject, iterKey) ?? (rawIterable as any)[iterKey]
        : undefined;
      if (iterFn && (isJSFunction(iterFn) || typeof iterFn === "function")) {
        const iterator = isJSFunction(iterFn)
          ? yield* evalCallWithJSFunction(iterFn, [], env)
          : (iterFn as Function).call(rawIterable);
        iterable = [];
        for (let step = 0; step < 10000; step++) {
          const nextFn = getProperty(iterator as JSObject, "next") ?? (iterator as any)?.next;
          const result = isJSFunction(nextFn)
            ? yield* evalCallWithJSFunction(nextFn, [], env)
            : typeof nextFn === "function" ? nextFn.call(iterator) : undefined;
          if (!result || (result as any).done) break;
          iterable.push((result as any).value);
        }
      } else {
        iterable = rawIterable as unknown[];
      }
      const kind = stmt.left.kind;
      const isBlockScoped = kind !== "var";
      const pattern = stmt.left.declarations[0].id;

      for (const item of iterable) {
        const iterEnv = isBlockScoped ? new Environment(env) : env;
        bindPattern(pattern, item, iterEnv, kind, (expr: any) => exhaustGen(evalExpression(expr, iterEnv)));
        try {
          yield* evalStatement(stmt.body, iterEnv);
        } catch (e) {
          if (e instanceof BreakSignal && (!e.label || e.label === lbl)) break;
          if (e instanceof ContinueSignal && (!e.label || e.label === lbl)) continue;
          throw e;
        }
      }
      return undefined;
    }
    case "LabeledStatement": {
      // ラベルをループの body に伝播
      (stmt.body as any).__label__ = stmt.label;
      try {
        return yield* evalStatement(stmt.body, env);
      } catch (e) {
        // ラベル付き break がループ以外の文に使われた場合
        if (e instanceof BreakSignal && e.label === stmt.label) return undefined;
        throw e;
      }
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
        result = yield* evalStatement(s, blockEnv);
      }
      return result;
    }
  }
}

function* evalExpression(expr: Expression, env: Environment): Generator<unknown, unknown, unknown> {
  switch (expr.type) {
    case "Literal":
      return typeof expr.value === "string" ? internString(expr.value) : expr.value;
    case "Identifier":
      return env.get(expr.name);
    case "ThisExpression":
      return env.getThis();
    case "FunctionExpression": {
      const fn: JSFunction = {
        [JS_FUNCTION_BRAND]: true,
        name: expr.id?.name ?? "",
        params: expr.params,
        body: expr.body,
        closure: env,
        prototype: {},
      };
      if ((expr as any).generator) (fn as any).isGenerator = true;
      // 名前付き関数式の場合、自身のスコープで自分を参照可能にする
      if (expr.id) {
        const fnEnv = new Environment(env);
        fnEnv.define(expr.id.name, fn);
        fn.closure = fnEnv;
      }
      return fn;
    }
    case "ClassExpression": {
      // ClassExpression は ClassDeclaration と同じロジックだが env.define しない
      const fakeStmt = { ...expr, type: "ClassDeclaration", id: expr.id ?? { type: "Identifier", name: "__anonymous__" } } as any;
      // evalClassDeclaration は env.define するので、一時 env を使う
      const tempEnv = new Environment(env);
      yield* evalClassDeclaration(fakeStmt, tempEnv);
      return tempEnv.get(fakeStmt.id.name);
    }
    case "ArrowFunctionExpression": {
      const fn: JSFunction = {
        [JS_FUNCTION_BRAND]: true,
        name: "",
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
      let result: JSString = internString("");
      for (let i = 0; i < expr.quasis.length; i++) {
        result = jsStringConcat(result, internString(expr.quasis[i].value.cooked));
        if (i < expr.expressions.length) {
          const val = yield* evalExpression(expr.expressions[i], env);
          const prim = toPrimitive(val, "string");
          const s = isJSString(prim) ? prim : createSeqString(String(prim));
          result = jsStringConcat(result, s);
        }
      }
      return result;
    }
    case "SequenceExpression": {
      let result: unknown = undefined;
      for (const e of expr.expressions) {
        result = yield* evalExpression(e, env);
      }
      return result;
    }
    case "UpdateExpression": {
      // ++x, x++, --x, x--
      const arg = expr.argument;
      let oldValue: number;
      if (arg.type === "Identifier") {
        oldValue = env.get(arg.name) as number;
      } else {
        // MemberExpression
        const obj = (yield* evalExpression(arg.object, env)) as JSObject;
        const key = yield* resolveMemberKey(arg, env);
        oldValue = getProperty(obj, key) as number;
      }
      const newValue = expr.operator === "++" ? oldValue + 1 : oldValue - 1;
      if (arg.type === "Identifier") {
        env.set(arg.name, newValue);
      } else {
        const obj = (yield* evalExpression(arg.object, env)) as JSObject;
        const key = yield* resolveMemberKey(arg, env);
        obj[key] = newValue;
      }
      return expr.prefix ? newValue : oldValue;
    }
    case "NewExpression":
      return yield* evalNewExpression(expr, env);
    case "ObjectExpression": {
      const obj: Record<string, unknown> = {};
      for (const prop of expr.properties) {
        if (prop.type === "SpreadElement") {
          const source = (yield* evalExpression(prop.argument, env)) as Record<string, unknown>;
          if (source) Object.assign(obj, source);
        } else {
          const rawKey = prop.computed ? yield* evalExpression(prop.key, env) : undefined;
          const key = prop.computed ? (isJSString(rawKey) ? jsStringToString(rawKey) : String(rawKey)) : (prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value));

          if (prop.kind === "get" || prop.kind === "set") {
            const fnValue = yield* evalExpression(prop.value, env);
            const descriptor: PropertyDescriptor = {};
            const existing = Object.getOwnPropertyDescriptor(obj, key);
            if (existing) {
              descriptor.get = existing.get;
              descriptor.set = existing.set;
            }
            if (prop.kind === "get") {
              if (isJSFunction(fnValue)) {
                const fn = fnValue;
                descriptor.get = function() {
                  const callEnv = new Environment(fn.closure, true);
                  callEnv.setThis(this);
                  return evalBlockSync(fn.body.body, callEnv);
                };
              } else {
                descriptor.get = fnValue as () => unknown;
              }
            }
            if (prop.kind === "set") {
              if (isJSFunction(fnValue)) {
                const fn = fnValue;
                descriptor.set = function(v: unknown) {
                  const callEnv = new Environment(fn.closure, true);
                  callEnv.setThis(this);
                  callEnv.define(fn.params[0].name, v);
                  evalBlockSync(fn.body.body, callEnv);
                };
              } else {
                descriptor.set = fnValue as (v: unknown) => void;
              }
            }
            descriptor.configurable = true;
            descriptor.enumerable = true;
            Object.defineProperty(obj, key, descriptor);
          } else {
            const val = yield* evalExpression(prop.value, env);
            // メソッド省略記法: 関数の name を設定
            if (isJSFunction(val) && !val.name) val.name = key;
            obj[key] = val;
          }
        }
      }
      return obj;
    }
    case "ArrayExpression": {
      const result: unknown[] = [];
      for (const el of expr.elements) {
        if (el.type === "SpreadElement") {
          const arr = (yield* evalExpression(el.argument, env)) as unknown[];
          result.push(...arr);
        } else {
          result.push(yield* evalExpression(el, env));
        }
      }
      return result;
    }
    case "MemberExpression": {
      const obj = yield* evalExpression(expr.object, env);
      if (obj === null || obj === undefined) {
        if ((expr as any).optional) return undefined; // ?. → undefined
        const key = yield* resolveMemberKey(expr, env);
        throw new TypeError(`Cannot read properties of ${obj} (reading '${key}')`);
      }
      const key = yield* resolveMemberKey(expr, env);
      return getProperty(obj as JSObject, key);
    }
    case "AssignmentExpression": {
      if (expr.left.type === "ObjectPattern" || expr.left.type === "ArrayPattern") {
        const value = yield* evalExpression(expr.right, env);
        assignPattern(expr.left, value, env);
        return value;
      }

      // 複合代入: 現在の値を取得して演算
      const rightValue = yield* evalExpression(expr.right, env);
      let newValue: unknown;
      if (expr.operator === "=") {
        newValue = rightValue;
      } else {
        let currentValue: unknown;
        if (expr.left.type === "MemberExpression") {
          const obj = (yield* evalExpression(expr.left.object, env)) as JSObject;
          currentValue = getProperty(obj, yield* resolveMemberKey(expr.left, env));
        } else {
          currentValue = env.get(expr.left.name);
        }
        switch (expr.operator) {
          case "+=":
            if (isJSString(currentValue) || isJSString(rightValue)) {
              const l = isJSString(currentValue) ? currentValue : createSeqString(String(currentValue));
              const r = isJSString(rightValue) ? rightValue : createSeqString(String(rightValue));
              newValue = jsStringConcat(l, r);
            } else {
              newValue = (currentValue as number) + (rightValue as number);
            }
            break;
          case "-=": newValue = (currentValue as number) - (rightValue as number); break;
          case "*=": newValue = (currentValue as number) * (rightValue as number); break;
          case "/=": newValue = (currentValue as number) / (rightValue as number); break;
          case "%=": newValue = (currentValue as number) % (rightValue as number); break;
          default: throw new Error(`Unknown assignment operator: ${expr.operator}`);
        }
      }

      if (expr.left.type === "MemberExpression") {
        const obj = (yield* evalExpression(expr.left.object, env)) as Record<string, unknown>;
        const key = yield* resolveMemberKey(expr.left, env);
        obj[key] = newValue;
      } else {
        env.set(expr.left.name, newValue);
      }
      return newValue;
    }
    case "CallExpression":
      return yield* evalCallExpression(expr, env);
    case "UnaryExpression":
      return yield* evalUnaryExpression(expr, env);
    case "LogicalExpression":
      return yield* evalLogicalExpression(expr, env);
    case "BinaryExpression":
      return yield* evalBinaryExpression(expr, env);
    case "ConditionalExpression":
      return isTruthy(yield* evalExpression(expr.test, env))
        ? yield* evalExpression(expr.consequent, env)
        : yield* evalExpression(expr.alternate, env);
    case "YieldExpression": {
      const value = expr.argument ? yield* evalExpression(expr.argument, env) : undefined;
      return yield value; // host yield — suspends generator
    }
  }
}

function* evalNewExpression(
  expr: Expression & { type: "NewExpression" },
  env: Environment,
): Generator<unknown, unknown, unknown> {
  const constructor = yield* evalExpression(expr.callee, env);
  const args = yield* evalArguments(expr.arguments, env);

  // 組み込みコンストラクタ (Error 等)
  if (typeof constructor === "object" && constructor !== null && "__nativeConstructor" in constructor) {
    const ctor = constructor as { name: string };
    if (ctor.name === "Error") {
      return { message: args[0] ?? "" };
    }
    throw new Error(`Unknown native constructor: ${ctor.name}`);
  }

  // ネイティブコンストラクタ (Object, Boolean, Number, String, Array, etc.)
  if (typeof constructor === "function") {
    return new (constructor as any)(...args);
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
      yield* bindParam(param, i < args.length ? args[i] : undefined, fnEnv, fnEnv);
    }
  }
  // インスタンスフィールドを初期化
  if ((constructor as any).__instanceFields) {
    for (const field of (constructor as any).__instanceFields) {
      const name = classKeyName(field.key, field.computed, fnEnv);
      const value = field.value ? yield* evalExpression(field.value, fnEnv) : undefined;
      newObj[name] = value;
    }
  }

  hoistVarDeclarations(constructor.body.body, fnEnv);
  hoistFunctionDeclarations(constructor.body.body, fnEnv);

  let returnValue: unknown = undefined;
  try {
    for (const stmt of constructor.body.body) {
      yield* evalStatement(stmt, fnEnv);
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

// jsmini の JSFunction をネイティブから呼べるようにするヘルパー
// パラメータバインド: AssignmentPattern (デフォルト引数) を処理
function* bindParam(param: any, value: unknown, env: Environment, evalEnv: Environment): Generator<unknown, void, unknown> {
  if (param.type === "AssignmentPattern") {
    const val = value !== undefined ? value : yield* evalExpression(param.right, evalEnv);
    bindPattern(param.left, val, env, "let");
  } else {
    bindPattern(param, value, env, "let");
  }
}

function* evalCallWithJSFunction(fn: unknown, args: unknown[], env: Environment, overrideThis?: unknown): Generator<unknown, unknown, unknown> {
  if (!isJSFunction(fn)) return undefined;
  const jsFn = fn;

  // Generator function: return generator object instead of executing
  if ((jsFn as any).isGenerator) {
    const fnEnv = new Environment(jsFn.closure, !jsFn.isArrow);
    if (overrideThis !== undefined) fnEnv.setThis(overrideThis);
    if (!jsFn.isArrow) {
      const argsObj = Object.create(null);
      for (let i = 0; i < args.length; i++) argsObj[i] = args[i];
      argsObj.length = args.length;
      fnEnv.define("arguments", argsObj);
    }
    for (let i = 0; i < jsFn.params.length; i++) {
      const param = jsFn.params[i];
      if (param.type === "RestElement") {
        fnEnv.define(param.argument.name, args.slice(i));
      } else {
        yield* bindParam(param, i < args.length ? args[i] : undefined, fnEnv, fnEnv);
      }
    }
    hoistVarDeclarations(jsFn.body.body, fnEnv);
    hoistFunctionDeclarations(jsFn.body.body, fnEnv);

    const bodyGen = evalBlock(jsFn.body.body, fnEnv);
    const genObj: Record<string, unknown> = {
      next(value: unknown) {
        const r = bodyGen.next(value);
        return { value: r.value, done: r.done };
      },
      return(value: unknown) { return bodyGen.return(value); },
      "@@iterator"() { return genObj; },
    };
    return genObj;
  }

  const fnEnv = new Environment(jsFn.closure, !jsFn.isArrow);
  if (overrideThis !== undefined) fnEnv.setThis(overrideThis);
  // arguments オブジェクト (アロー関数以外)
  if (!jsFn.isArrow) {
    const argsObj = Object.create(null);
    for (let i = 0; i < args.length; i++) argsObj[i] = args[i];
    argsObj.length = args.length;
    fnEnv.define("arguments", argsObj);
  }
  for (let i = 0; i < jsFn.params.length; i++) {
    const param = jsFn.params[i];
    if (param.type === "RestElement") {
      fnEnv.define(param.argument.name, args.slice(i));
    } else {
      yield* bindParam(param, i < args.length ? args[i] : undefined, fnEnv, fnEnv);
    }
  }
  hoistVarDeclarations(jsFn.body.body, fnEnv);
  hoistFunctionDeclarations(jsFn.body.body, fnEnv);
  try {
    for (const s of jsFn.body.body) yield* evalStatement(s, fnEnv);
  } catch (e) {
    if (e instanceof ReturnSignal) return e.value;
    throw e;
  }
  return undefined;
}

function* evalCallExpression(
  expr: Expression & { type: "CallExpression" },
  env: Environment,
): Generator<unknown, unknown, unknown> {
  // メソッド呼び出し (obj.method()) の場合、this をバインドする
  let thisValue: unknown = undefined;
  let fn: unknown;
  if (expr.callee.type === "MemberExpression") {
    thisValue = yield* evalExpression(expr.callee.object, env);
    const key = yield* resolveMemberKey(expr.callee, env);
    fn = getProperty(thisValue as JSObject, key);
    // JSFunction の .call / .apply / .bind
    if (fn === undefined && isJSFunction(thisValue)) {
      const jsFnObj = thisValue;
      if (key === "call") {
        const callArgs = yield* evalArguments(expr.arguments, env);
        const [callThis, ...rest] = callArgs;
        return yield* evalCallWithJSFunction(jsFnObj, rest, env, callThis);
      } else if (key === "apply") {
        const applyArgs = yield* evalArguments(expr.arguments, env);
        const [applyThis, argsArray] = applyArgs;
        const rest = Array.isArray(argsArray) ? argsArray : [];
        return yield* evalCallWithJSFunction(jsFnObj, rest, env, applyThis);
      } else if (key === "bind") {
        const bindArgs = yield* evalArguments(expr.arguments, env);
        const [bindThis, ...boundArgs] = bindArgs;
        const bound: JSFunction = {
          [JS_FUNCTION_BRAND]: true,
          name: `bound ${jsFnObj.name ?? ""}`,
          params: jsFnObj.params,
          body: jsFnObj.body,
          closure: jsFnObj.closure,
          isArrow: jsFnObj.isArrow,
          prototype: jsFnObj.prototype,
          __boundThis: bindThis,
          __boundArgs: boundArgs,
        };
        return bound;
      }
    }
    // JSString のメソッド: ネイティブ文字列メソッドに委譲
    if (fn === undefined && isJSString(thisValue)) {
      const str = jsStringToString(thisValue);
      const nativeFn = (str as any)[key];
      if (typeof nativeFn === "function") {
        fn = (...a: unknown[]) => {
          const nativeArgs = a.map(x => isJSString(x) ? jsStringToString(x) : x);
          const result = nativeFn.apply(str, nativeArgs);
          if (typeof result === "string") return internString(result);
          if (Array.isArray(result)) return result.map((s: string) => typeof s === "string" ? internString(s) : s);
          return result;
        };
      }
    }
  } else {
    fn = yield* evalExpression(expr.callee, env);
  }

  const args = yield* evalArguments(expr.arguments, env);

  // direct eval: eval("code") — 呼び出し元のスコープで実行 (strict mode: var は eval スコープに閉じる)
  if (expr.callee.type === "Identifier" && expr.callee.name === "eval" && typeof fn === "function") {
    const code = args[0];
    if (typeof code !== "string" && !isJSString(code)) return code; // 文字列以外はそのまま返す
    const s = isJSString(code) ? jsStringToString(code) : code as string;
    const ast = parse(s);
    // eval 専用スコープ (親 = 呼び出し元の env)。var は eval スコープに閉じる (strict mode)
    const evalEnv = new Environment(env, true); // isFunctionScope=true で var を閉じ込める
    const gen = evalProgram(ast, evalEnv);
    let result: unknown;
    while (true) {
      const r = gen.next();
      if (r.done) { result = r.value; break; }
    }
    return result;
  }

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
        yield* bindParam(param, i < args.length ? args[i] : undefined, superEnv, superEnv);
      }
    }
    hoistVarDeclarations(superFn.body.body, superEnv);
    hoistFunctionDeclarations(superFn.body.body, superEnv);
    try {
      for (const s of superFn.body.body) {
        yield* evalStatement(s, superEnv);
      }
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
    return undefined;
  }

  // ネイティブ関数 (console.log 等)
  if (typeof fn === "function") {
    // コールバック系メソッド: jsmini 関数を呼べるようにラップ
    const wrappedArgs = args.some(a => isJSFunction(a))
      ? args.map(a =>
          isJSFunction(a) ? (...nativeArgs: unknown[]) => exhaustGen(evalCallWithJSFunction(a, nativeArgs, env)) : a
        )
      : args;
    if (thisValue !== undefined) {
      return (fn as Function).apply(thisValue, wrappedArgs);
    }
    return (fn as Function)(...wrappedArgs);
  }

  if (!isJSFunction(fn)) {
    throw new TypeError(`${typeof fn} is not a function`);
  }

  if (fn.isClass) {
    throw new TypeError("Class constructor cannot be invoked without 'new'");
  }

  const jsFn = fn;

  // Generator function: return generator object instead of executing to completion
  if ((jsFn as any).isGenerator) {
    const fnEnv = new Environment(jsFn.closure, !jsFn.isArrow);
    if (!jsFn.isArrow) {
      fnEnv.setThis(thisValue);
      const argsObj = Object.create(null);
      for (let i = 0; i < args.length; i++) argsObj[i] = args[i];
      argsObj.length = args.length;
      fnEnv.define("arguments", argsObj);
    }
    for (let i = 0; i < jsFn.params.length; i++) {
      const param = jsFn.params[i];
      if (param.type === "RestElement") {
        fnEnv.define(param.argument.name, args.slice(i));
      } else {
        yield* bindParam(param, i < args.length ? args[i] : undefined, fnEnv, fnEnv);
      }
    }
    hoistVarDeclarations(jsFn.body.body, fnEnv);
    hoistFunctionDeclarations(jsFn.body.body, fnEnv);

    const bodyGen = evalBlock(jsFn.body.body, fnEnv);
    const genObj: Record<string, unknown> = {
      next(value: unknown) {
        try {
          const r = bodyGen.next(value);
          return { value: r.value, done: r.done };
        } catch (e) {
          if (e instanceof ReturnSignal) return { value: e.value, done: true };
          throw e;
        }
      },
      return(value: unknown) { return bodyGen.return(value); },
      "@@iterator"() { return genObj; },
    };
    return genObj;
  }

  // 新しいスコープを作成（親 = 関数定義時のスコープ = クロージャ）
  // アロー関数は自身の this を持たない（クロージャの this を継承）
  const fnEnv = new Environment(jsFn.closure, !jsFn.isArrow);
  if (!jsFn.isArrow) {
    fnEnv.setThis(thisValue);
    const argsObj = Object.create(null);
    for (let i = 0; i < args.length; i++) argsObj[i] = args[i];
    argsObj.length = args.length;
    fnEnv.define("arguments", argsObj);
  }

  // 仮引数に実引数をバインド（分割代入 + レスト対応）
  for (let i = 0; i < jsFn.params.length; i++) {
    const param = jsFn.params[i];
    if (param.type === "RestElement") {
      fnEnv.define(param.argument.name, args.slice(i));
    } else {
      yield* bindParam(param, i < args.length ? args[i] : undefined, fnEnv, fnEnv);
    }
  }

  // 関数本体内の var と function をホイスト
  hoistVarDeclarations(jsFn.body.body, fnEnv);
  hoistFunctionDeclarations(jsFn.body.body, fnEnv);

  try {
    for (const stmt of jsFn.body.body) {
      yield* evalStatement(stmt, fnEnv);
    }
  } catch (e) {
    if (e instanceof ReturnSignal) {
      return e.value;
    }
    throw e;
  }
  return undefined;
}

function* evalUnaryExpression(
  expr: Expression & { type: "UnaryExpression" },
  env: Environment,
): Generator<unknown, unknown, unknown> {
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
        return internString("undefined");
      }
    } else {
      value = yield* evalExpression(expr.argument, env);
    }
    if (isJSSymbol(value)) return internString("symbol");
    if (isJSString(value)) return internString("string");
    if (value === null) return internString("object");
    if (isJSFunction(value)) return internString("function");
    return internString(typeof value);
  }

  if (expr.operator === "delete") {
    if (expr.argument.type === "MemberExpression") {
      const obj = yield* evalExpression(expr.argument.object, env);
      const key = yield* resolveMemberKey(expr.argument, env);
      if (obj && typeof obj === "object") {
        delete (obj as Record<string, unknown>)[key];
      }
      return true;
    }
    return true;
  }

  if (expr.operator === "void") {
    yield* evalExpression(expr.argument, env);
    return undefined;
  }

  const argument = yield* evalExpression(expr.argument, env);
  switch (expr.operator) {
    case "!": return !isTruthy(argument);
    case "-": return -(argument as number);
    case "~": return ~(argument as number);
    default:
      throw new Error(`Unknown unary operator: ${expr.operator}`);
  }
}

function* evalLogicalExpression(
  expr: Expression & { type: "LogicalExpression" },
  env: Environment,
): Generator<unknown, unknown, unknown> {
  const left = yield* evalExpression(expr.left, env);
  switch (expr.operator) {
    case "&&": return isTruthy(left) ? yield* evalExpression(expr.right, env) : left;
    case "||": return isTruthy(left) ? left : yield* evalExpression(expr.right, env);
    case "??": return (left !== null && left !== undefined) ? left : yield* evalExpression(expr.right, env);
    default:
      throw new Error(`Unknown logical operator: ${expr.operator}`);
  }
}

function* evalBinaryExpression(
  expr: Expression & { type: "BinaryExpression" },
  env: Environment,
): Generator<unknown, unknown, unknown> {
  const rawLeft = yield* evalExpression(expr.left, env);
  const rawRight = yield* evalExpression(expr.right, env);
  // 算術/比較演算子はオブジェクトを ToPrimitive で変換
  const left = toPrimitive(rawLeft);
  const right = toPrimitive(rawRight);
  switch (expr.operator) {
    case "+":
      if (isJSString(left) || isJSString(right)) {
        const l = isJSString(left) ? left : createSeqString(String(left));
        const r = isJSString(right) ? right : createSeqString(String(right));
        return jsStringConcat(l, r);
      }
      return (left as number) + (right as number);
    case "-": return (left as number) - (right as number);
    case "*": return (left as number) * (right as number);
    case "/": return (left as number) / (right as number);
    case "%": return (left as number) % (right as number);
    case "**": return (left as number) ** (right as number);
    case "&": return (left as number) & (right as number);
    case "|": return (left as number) | (right as number);
    case "^": return (left as number) ^ (right as number);
    case "<<": return (left as number) << (right as number);
    case ">>": return (left as number) >> (right as number);
    case ">>>": return (left as number) >>> (right as number);
    case "<": return (left as number) < (right as number);
    case ">": return (left as number) > (right as number);
    case "<=": return (left as number) <= (right as number);
    case ">=": return (left as number) >= (right as number);
    case "==":
      if (isJSString(left) && isJSString(right)) return jsStringEquals(left, right);
      if (isJSString(left) || isJSString(right)) return false;
      return left == right;
    case "===":
      if (isJSString(rawLeft) && isJSString(rawRight)) return jsStringEquals(rawLeft, rawRight);
      if (isJSString(rawLeft) || isJSString(rawRight)) return false;
      return rawLeft === rawRight;
    case "!=":
      if (isJSString(left) && isJSString(right)) return !jsStringEquals(left, right);
      if (isJSString(left) || isJSString(right)) return true;
      return left != right;
    case "!==":
      if (isJSString(rawLeft) && isJSString(rawRight)) return !jsStringEquals(rawLeft, rawRight);
      if (isJSString(rawLeft) || isJSString(rawRight)) return true;
      return rawLeft !== rawRight;
    case "in": {
      const key = isJSString(rawLeft) ? jsStringToString(rawLeft) : String(rawLeft);
      return key in (rawRight as Record<string, unknown>);
    }
    case "instanceof": {
      // ネイティブコンストラクタ (ReferenceError 等) はそのまま JS の instanceof に委譲
      if (typeof rawRight === "function") return rawLeft instanceof rawRight;
      if (!isJSFunction(rawRight)) throw new TypeError("Right-hand side of instanceof is not callable");
      // プロトタイプチェーンを辿って right.prototype を探す
      const proto = (rawRight as JSFunction).prototype;
      let current = (rawLeft as JSObject)?.[PROTO_KEY] as JSObject | null;
      while (current !== null && current !== undefined) {
        if (current === proto) return true;
        current = (current as JSObject)?.[PROTO_KEY] as JSObject | null;
      }
      return false;
    }
    default:
      throw new Error(`Unknown operator: ${expr.operator}`);
  }
}
