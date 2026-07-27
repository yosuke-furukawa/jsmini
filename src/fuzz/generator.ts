// jsmini が対応するサブセットのランダム JS プログラムを生成する。
//
// 安全性 (ファザ本体が hang しない) のための不変条件:
//   - ループは必ず有界 (`for (let i=0; i<N; i++)`、N は小さいリテラル)。while/do 無し。
//   - 関数は非再帰 (本体生成時、自分自身と後続関数はスコープに入れない)。
//   - 文数・ネスト深さ・式深さに上限。
// これらと VM の maxSteps + 子プロセスのタイムアウトを合わせて hang を防ぐ。

import { Rng } from "./prng.js";

type ClassInfo = { name: string; ctorArity: number; methods: string[] };

type Ctx = {
  rng: Rng;
  vars: string[]; // 参照可能な変数
  funcs: { name: string; arity: number }[]; // 呼び出し可能な (既に宣言済みの) 関数
  classes: ClassInfo[]; // 宣言済み class (new / extends 用)
  instances: { v: string; cls: ClassInfo }[]; // class インスタンスを保持する変数 (メソッド呼び出し用)
  budget: { stmts: number }; // 残り文数 (ネストブロック含め共有)
  varSeq: { n: number };
  fnSeq: { n: number };
  clsSeq: { n: number };
  labelSeq: { n: number };
  blockDepth: number;
  loopVar: string | null; // 現在のループ変数 (本体内で参照可能)
  // 現在の文が「必ず実行される」直列文脈か。switch case / ループ本体 / if 分岐など
  // 「実行されるとは限らない」文脈では false。false のとき class/fn/instance を
  // 後続から参照可能にすると「宣言が実行されず未定義参照」プログラムを量産する
  guaranteed: boolean;
};

const NUM_LITERALS = [
  "0", "1", "-1", "2", "3", "0.5", "-0.5", "3.14", "100", "255",
  "65536", "2147483647", "2147483648", "-2147483648", "1e10", "0.1",
  "NaN", "Infinity", "-Infinity",
];
const STR_LITERALS = ['""', '"a"', '"abc"', '"0"', '"1"', '"hello"', '" "', '"xy"'];
const BIN_ARITH = ["+", "-", "*", "/", "%", "**"];
const BIN_CMP = ["<", "<=", ">", ">=", "==", "===", "!=", "!=="];
const BIN_LOGIC = ["&&", "||", "??"];
const BIN_BIT = ["&", "|", "^", "<<", ">>", ">>>"];
// 注: jsmini parser は単項 `+` を未サポート (有効な JS だがパース不可) なので含めない。
const UNARY = ["-", "!", "~", "typeof ", "void "];

function newVar(ctx: Ctx): string {
  return `v${ctx.varSeq.n++}`;
}

// ----- 式生成 -----

function genLeaf(ctx: Ctx): string {
  const r = ctx.rng;
  const choices: (readonly [() => string, number])[] = [
    [() => r.pick(NUM_LITERALS), 5],
    [() => r.pick(STR_LITERALS), 2],
    [() => r.pick(["true", "false", "null", "undefined"]), 2],
  ];
  const refs = ctx.loopVar ? [...ctx.vars, ctx.loopVar] : ctx.vars;
  if (refs.length > 0) choices.push([() => r.pick(refs), 6]);
  return r.weighted(choices)();
}

function genExpr(ctx: Ctx, depth: number): string {
  const r = ctx.rng;
  if (depth <= 0 || r.bool(0.35)) return genLeaf(ctx);

  const kind = r.weighted([
    ["bin", 8],
    ["unary", 3],
    ["ternary", 2],
    ["array", 2],
    ["object", 2],
    ["member", 3],
    ["index", 2],
    ["call", 4],
    ["fncall", ctx.funcs.length ? 3 : 0],
    ["new", ctx.classes.length ? 2 : 0],
    ["methodcall", ctx.instances.length ? 3 : 0],
    ["paren", 2],
  ] as const);

  const sub = () => genExpr(ctx, depth - 1);

  switch (kind) {
    case "bin": {
      const group = r.weighted([
        [BIN_ARITH, 6], [BIN_CMP, 4], [BIN_LOGIC, 3], [BIN_BIT, 3],
      ] as const);
      return `(${sub()} ${r.pick(group)} ${sub()})`;
    }
    case "unary":
      // 演算子と被演算子の間に空白: `-` と `-0.5` が直結すると `--0.5` になり
      // (実 JS でも) SyntaxError になるため
      return `(${r.pick(UNARY)} ${sub()})`;
    case "ternary":
      return `(${sub()} ? ${sub()} : ${sub()})`;
    case "array": {
      const n = r.int(4);
      const items = Array.from({ length: n }, sub);
      return `[${items.join(", ")}]`;
    }
    case "object": {
      const n = r.int(3);
      const props = Array.from({ length: n }, (_, i) => `k${i}: ${sub()}`);
      // object spread ({...src}) — Phase 39 の CopyDataProps を検出網に入れる。
      // src は任意の値 (null/数値は no-op、配列/文字列/オブジェクトはコピー)
      if (r.bool(0.3)) props.push(`...(${sub()})`);
      // リテラル getter — accessor 経路 (呼び出し/例外伝播) を守る
      if (r.bool(0.2)) props.push(`get kg() { return ${genLeaf(ctx)}; }`);
      return `({${props.join(", ")}})`;
    }
    case "member":
      // ".constructor" は host 境界の既知差異 (TW=host Array/Number vs VM=jsmini Object)
      // で発散が確定しているため生成しない (PROBLEMS.md 参照。新規バグ検出のノイズになる)
      return `(${sub()}).${r.pick(["length", "k0", "k1", "x"])}`;
    case "index":
      return `(${sub()})[${r.pick(["0", "1", "2", genLeaf(ctx)])}]`;
    case "call": {
      const builtins: (readonly [string, number])[] = [
        [`Math.floor(${sub()})`, 1], [`Math.abs(${sub()})`, 1],
        [`Math.max(${sub()}, ${sub()})`, 1], [`Math.min(${sub()}, ${sub()})`, 1],
        [`Math.sqrt(${sub()})`, 1], [`Math.pow(${sub()}, ${sub()})`, 1],
        [`String(${sub()})`, 1], [`Number(${sub()})`, 1], [`Boolean(${sub()})`, 1],
        [`parseInt(${sub()})`, 1], [`isNaN(${sub()})`, 1],
        // 配列メソッド (JSString 要素/引数の扱いと自前実装の検証。Phase 36-2 の再発防止)
        [`[${sub()}, ${sub()}].join(${sub()})`, 1],
        [`[${sub()}, ${sub()}].indexOf(${sub()})`, 1],
        [`[${sub()}, ${sub()}].includes(${sub()})`, 1],
        [`([${sub()}, ${sub()}].sort()).length`, 1],
        [`[${sub()}, ${sub()}].lastIndexOf(${sub()})`, 1],
        // spread + host 関数 / 属性モデル (Phase 39) の検出網
        [`Math.max(...[${sub()}, ${sub()}, ${sub()}])`, 1],
        [`Object.keys(({k0: ${sub()}, k1: ${sub()}})).length`, 1],
        [`[...[${sub()}, ${sub()}], ${sub()}].length`, 1],
      ];
      return r.weighted(builtins);
    }
    case "fncall": {
      const f = r.pick(ctx.funcs);
      const args = Array.from({ length: f.arity }, sub);
      // spread 呼び出し (Phase 39 の CallSpread を検出網に)
      if (f.arity > 0 && r.bool(0.25)) {
        return r.bool(0.5)
          ? `${f.name}(...[${args.join(", ")}])`
          : `${f.name}(${args[0]}${args.length > 1 ? ", ...[" + args.slice(1).join(", ") + "]" : ", ...[]"})`;
      }
      return `${f.name}(${args.join(", ")})`;
    }
    case "new": {
      const c = r.pick(ctx.classes);
      const args = Array.from({ length: c.ctorArity }, () => genLeaf(ctx));
      // new spread (ConstructSpread) も混ぜる
      return r.bool(0.25)
        ? `(new ${c.name}(...[${args.join(", ")}]))`
        : `(new ${c.name}(${args.join(", ")}))`;
    }
    case "methodcall": {
      const inst = r.pick(ctx.instances);
      if (inst.cls.methods.length === 0) return `(${inst.v}).k0`;
      const m = r.pick(inst.cls.methods);
      const arg = genLeaf(ctx);
      // メソッド spread 呼び出し (CallMethodSpread) も混ぜる
      return r.bool(0.25) ? `${inst.v}.${m}(...[${arg}])` : `${inst.v}.${m}(${arg})`;
    }
    case "paren":
    default:
      return `(${sub()})`;
  }
}

// ----- 文生成 -----

// ブロックスコープ内で文を生成し、そこで宣言した変数はブロックを抜けたら
// スコープから外す。これを怠ると生成器がブロック内 let をブロック外から参照する
// (実 JS では ReferenceError になる) 無効コードを量産し、差分がノイズになる。
// var は本来関数スコープだが、生成器は安全側 (使える変数が減るだけ) で全部戻す
function withBlockScope<T>(ctx: Ctx, body: () => T): T {
  const savedVars = ctx.vars.length;
  const savedFuncs = ctx.funcs.length;
  const savedClasses = ctx.classes.length;
  const savedInstances = ctx.instances.length;
  try {
    return body();
  } finally {
    ctx.vars.length = savedVars;
    ctx.funcs.length = savedFuncs;
    ctx.classes.length = savedClasses;
    ctx.instances.length = savedInstances;
  }
}

function genBlock(ctx: Ctx, maxStmts: number): string {
  return withBlockScope(ctx, () => {
    // ブロック内は「実行されるとは限らない」— if/for/switch/try 本体は
    // 条件・回数・fall-through 次第。ブロック内で作った binding は
    // ブロック内では直列に使えるが (guaranteed をブロック内では true に戻す)、
    // withBlockScope が抜ける際に破棄されるので外へは漏れない
    const savedG = ctx.guaranteed;
    ctx.guaranteed = true;
    const lines: string[] = [];
    const n = ctx.rng.range(1, maxStmts);
    for (let i = 0; i < n && ctx.budget.stmts > 0; i++) {
      lines.push(genStmt(ctx));
    }
    if (lines.length === 0) lines.push(";");
    ctx.guaranteed = savedG;
    return `{\n${lines.map((l) => "  " + l).join("\n")}\n}`;
  });
}

function genStmt(ctx: Ctx): string {
  ctx.budget.stmts--;
  const r = ctx.rng;
  const canBranch = ctx.blockDepth < 3 && ctx.budget.stmts > 1;

  const kind = r.weighted([
    ["decl", 6],
    ["assign", ctx.vars.length ? 4 : 0],
    ["memberassign", ctx.vars.length ? 2 : 0],
    ["log", 3],
    ["expr", 3],
    ["if", canBranch ? 3 : 0],
    ["for", canBranch ? 3 : 0],
    ["switch", canBranch ? 2 : 0],
    ["trycatch", canBranch ? 2 : 0],
    ["throw", 1],
    ["fndecl", canBranch ? 2 : 0],
    ["classdecl", canBranch && ctx.classes.length < 3 ? 2 : 0],
    ["labeled", canBranch ? 2 : 0],
    ["objop", ctx.vars.length ? 1 : 0],
  ] as const);

  switch (kind) {
    case "decl": {
      const name = newVar(ctx);
      const kw = r.weighted([["let", 6], ["const", 2], ["var", 2]] as const);
      const stmt = `${kw} ${name} = ${genExpr(ctx, 3)};`;
      if (ctx.guaranteed) ctx.vars.push(name); // 宣言後にスコープへ (使用前参照を避ける)
      return stmt;
    }
    case "assign": {
      const target = r.pick(ctx.vars);
      const op = r.weighted([
        ["=", 5], ["+=", 2], ["-=", 1], ["*=", 1], ["%=", 1],
      ] as const);
      return `${target} ${op} ${genExpr(ctx, 3)};`;
    }
    case "log":
      return `console.log(${genExpr(ctx, 2)}, ${genExpr(ctx, 2)});`;
    case "expr":
      return `${genExpr(ctx, 3)};`;
    case "if": {
      ctx.blockDepth++;
      const cond = genExpr(ctx, 2);
      const then = genBlock(ctx, 2);
      const stmt = r.bool(0.5)
        ? `if (${cond}) ${then}`
        : `if (${cond}) ${then} else ${genBlock(ctx, 2)}`;
      ctx.blockDepth--;
      return stmt;
    }
    case "for": {
      ctx.blockDepth++;
      const n = r.range(0, 5); // 有界
      const iv = `i${ctx.blockDepth}`;
      const savedLoop = ctx.loopVar;
      ctx.loopVar = iv;
      const body = genBlock(ctx, 3);
      ctx.loopVar = savedLoop;
      ctx.blockDepth--;
      return `for (let ${iv} = 0; ${iv} < ${n}; ${iv}++) ${body}`;
    }
    case "trycatch": {
      ctx.blockDepth++;
      const t = genBlock(ctx, 2);
      const c = genBlock(ctx, 2);
      ctx.blockDepth--;
      return `try ${t} catch (e) ${c}`;
    }
    case "switch": {
      // switch 生成: case 内の fn/var 宣言のスコープ、fall-through、
      // default をカバー (Phase 36-1a の再発防止)。switch 全体が 1 ブロック
      // スコープ (case 内 let は case 間で共有だが switch の外では不可視) なので
      // withBlockScope で包む
      ctx.blockDepth++;
      const stmt = withBlockScope(ctx, () => {
        const savedG = ctx.guaranteed;
        ctx.guaranteed = false; // case は fall-through で実行順が読めない
        const disc = genExpr(ctx, 2);
        const parts: string[] = [];
        const ncases = r.range(1, 3);
        for (let i = 0; i < ncases; i++) {
          const test = r.pick(["0", "1", "2", "3", '"a"', "true"]);
          const body: string[] = [];
          const bn = r.range(0, 2);
          for (let j = 0; j < bn && ctx.budget.stmts > 0; j++) body.push(genStmt(ctx));
          if (r.bool(0.7)) body.push("break;");
          parts.push(`case ${test}: ${body.join(" ")}`);
        }
        if (r.bool(0.5) && ctx.budget.stmts > 0) parts.push(`default: ${genStmt(ctx)}`);
        ctx.guaranteed = savedG;
        return `switch (${disc}) {\n${parts.map((c) => "  " + c).join("\n")}\n}`;
      });
      ctx.blockDepth--;
      return stmt;
    }
    case "memberassign": {
      // メンバー代入/複合代入: 評価順 (obj → rhs) と o.p += v をカバー
      // (Phase 36-1c の再発防止)。object 位置は変数かオブジェクトリテラル
      const obj = r.bool(0.6) ? r.pick(ctx.vars) : `({k0: ${genLeaf(ctx)}})`;
      const key = r.bool(0.75) ? `.${r.pick(["k0", "k1", "x"])}` : `[${r.pick(['"k0"', "0", "1"])}]`;
      const op = r.weighted([["=", 4], ["+=", 2], ["-=", 1], ["*=", 1]] as const);
      return `(${obj})${key} ${op} ${genExpr(ctx, 2)};`;
    }
    case "throw":
      return `throw ${genExpr(ctx, 2)};`;
    case "fndecl": {
      const name = `f${ctx.fnSeq.n++}`;
      const arity = r.int(3);
      const params = Array.from({ length: arity }, (_, i) => `p${i}`);
      // 本体は隔離スコープ: 引数のみ参照可 (外側変数・自身は入れない → 非再帰)。
      // 既存関数の呼び出しは可 (呼び出しグラフは DAG なので有限)。
      const bodyCtx: Ctx = {
        ...ctx,
        vars: [...params],
        funcs: [...ctx.funcs],
        blockDepth: ctx.blockDepth + 1,
        loopVar: null,
      };
      const inner: string[] = [];
      const n = r.range(0, 2);
      for (let i = 0; i < n && ctx.budget.stmts > 0; i++) inner.push(genStmt(bodyCtx));
      inner.push(`return ${genExpr(bodyCtx, 2)};`);
      const stmt = `function ${name}(${params.join(", ")}) {\n${inner.map((l) => "  " + l).join("\n")}\n}`;
      if (ctx.guaranteed) ctx.funcs.push({ name, arity }); // 宣言後にスコープへ
      return stmt;
    }
    case "classdecl": {
      // class 生成 (Phase 39 の継承/super/field/メソッド/getter を検出網に)。
      // 生成規則:
      //   - 名前は C0, C1... で一意 (再宣言エラーを避ける)
      //   - メソッド/getter 本体は params + this.k0/k1 だけを参照する隔離スコープ
      //   - 派生クラスは super(...) を必ず呼び、親のメソッドがあれば super.m() も生成
      //   - 宣言直後にインスタンス化してメソッド呼び出しを可能にする
      ctx.blockDepth++;
      const name = `C${ctx.clsSeq.n++}`;
      const parent = ctx.classes.length > 0 && r.bool(0.4) ? r.pick(ctx.classes) : null;
      const ctorArity = r.int(2);
      const params = Array.from({ length: ctorArity }, (_, i) => `p${i}`);
      // ctor 用 (params 参照可) とメソッド用 (自分の引数 q0 のみ) でスコープを分ける
      // — ctor のパラメータ名がメソッド本体に漏れると未解決識別子プログラムになる
      const bodyCtx: Ctx = {
        ...ctx,
        vars: [...params, "this.k0", "this.k1"],
        funcs: [...ctx.funcs],
        classes: [],
        instances: [],
        loopVar: null,
      };
      const methodCtx: Ctx = { ...bodyCtx, vars: ["q0", "this.k0", "this.k1"] };
      const parts: string[] = [];
      // instance field (非リテラル式も可 — VM の prologue コンパイルを検証)
      if (r.bool(0.6)) parts.push(`  k0 = ${r.bool(0.5) ? genLeaf(ctx) : genExpr(ctx, 1)};`);
      // constructor
      if (parent) {
        const superArgs = Array.from({ length: parent.ctorArity }, () => genLeaf(ctx));
        const superCall = r.bool(0.25) && parent.ctorArity > 0
          ? `super(...[${superArgs.join(", ")}]);` : `super(${superArgs.join(", ")});`;
        parts.push(`  constructor(${params.join(", ")}) { ${superCall} this.k1 = ${ctorArity > 0 ? "p0" : genLeaf(ctx)}; }`);
      } else if (r.bool(0.7)) {
        parts.push(`  constructor(${params.join(", ")}) { this.k1 = ${ctorArity > 0 ? "p0" : genLeaf(ctx)}; }`);
      }
      // メソッド (親があれば super.m() も)
      const methods: string[] = [];
      const nm = r.range(1, 2);
      for (let i = 0; i < nm; i++) {
        const mname = `m${i}`;
        methods.push(mname);
        const superPart = parent && parent.methods.length > 0 && r.bool(0.5)
          ? `super.${r.pick(parent.methods)}(${genLeaf(methodCtx)})` : null;
        const bodyExpr = superPart
          ? `(${genExpr(methodCtx, 1)} + ${superPart})` : genExpr(methodCtx, 2);
        parts.push(`  ${mname}(q0) { return ${bodyExpr}; }`);
      }
      // getter
      if (r.bool(0.3)) parts.push(`  get g0() { return ${genExpr({ ...methodCtx, vars: ["this.k0", "this.k1"] }, 1)}; }`);
      ctx.blockDepth--;
      const ext = parent ? ` extends ${parent.name}` : "";
      const cls: ClassInfo = {
        name, ctorArity,
        methods: parent ? [...new Set([...methods, ...parent.methods])] : methods,
      };
      const lines = [`class ${name}${ext} {`, ...parts, `}`];
      // 直後にインスタンス化 (メソッド呼び出し/フィールド読みの起点)
      const iv = newVar(ctx);
      const newArgs = Array.from({ length: ctorArity }, () => genLeaf(ctx));
      lines.push(`let ${iv} = new ${name}(${newArgs.join(", ")});`);
      // 実行が保証される文脈でのみ後続から参照可能にする (それ以外は使い捨て:
      // 生成した class を直後に new して即メソッド呼び出しまではするが、
      // 後段からの参照はさせない)
      if (ctx.guaranteed) {
        ctx.classes.push(cls);
        ctx.vars.push(iv);
        ctx.instances.push({ v: iv, cls });
      }
      return lines.join("\n");
    }
    case "labeled": {
      // ラベル付き文 (Phase 38 のラベルバグ群を検出網に)
      ctx.blockDepth++;
      const lbl = `lb${ctx.labelSeq.n++}`;
      let stmt: string;
      if (r.bool(0.5)) {
        // ラベル付きブロック + break lbl (途中脱出)
        stmt = withBlockScope(ctx, () => {
          const savedG2 = ctx.guaranteed;
          ctx.guaranteed = false; // break lbl で途中脱出しうる
          const before = ctx.budget.stmts > 0 ? genStmt(ctx) : ";";
          const after = ctx.budget.stmts > 0 ? genStmt(ctx) : ";";
          const out = `${lbl}: {\n  ${before}\n  if (${genExpr(ctx, 1)}) break ${lbl};\n  ${after}\n}`;
          ctx.guaranteed = savedG2;
          return out;
        });
      } else {
        // ラベル付き二重ループ + break/continue lbl
        const n1 = r.range(1, 3);
        const n2 = r.range(1, 3);
        const ivA = `ia${ctx.labelSeq.n}`;
        const ivB = `ib${ctx.labelSeq.n}`;
        const esc = r.pick(["break", "continue"]);
        // ループ本体は実行回数が読めず break/continue でも飛ぶので guaranteed=false
        // かつ withBlockScope で body 内 binding を外へ漏らさない
        const body = withBlockScope(ctx, () => {
          const savedLoop = ctx.loopVar;
          const savedG3 = ctx.guaranteed;
          ctx.loopVar = ivB;
          ctx.guaranteed = false;
          const b = ctx.budget.stmts > 0 ? genStmt(ctx) : "console.log(0, 0);";
          ctx.loopVar = savedLoop;
          ctx.guaranteed = savedG3;
          return b;
        });
        stmt = `${lbl}: for (let ${ivA} = 0; ${ivA} < ${n1}; ${ivA}++) {\n  for (let ${ivB} = 0; ${ivB} < ${n2}; ${ivB}++) {\n    if (${ivB} === 1) ${esc} ${lbl};\n    ${body}\n  }\n}`;
      }
      ctx.blockDepth--;
      return stmt;
    }
    case "objop": {
      // 属性モデル (Phase 39): freeze / defineProperty / delete を変数に適用。
      // 以後の書込が TypeError になる経路は「3 エンジンとも同じ TypeError」なら
      // 非発散、エンジン間で挙動が割れれば検出される
      const v = r.pick(ctx.vars);
      const op = r.weighted([
        [`Object.freeze(${v});`, 2],
        [`Object.defineProperty(${v}, "k0", { value: ${genLeaf(ctx)}, writable: ${r.bool(0.5)} });`, 2],
        [`delete (${v}).k0;`, 1],
      ] as const);
      return op;
    }
    default:
      return `${genExpr(ctx, 2)};`;
  }
}

export type GenOptions = {
  maxStmts?: number;
};

// seed から決定的にプログラム文字列を生成
export function generate(seed: number, opts: GenOptions = {}): string {
  const rng = new Rng(seed);
  const ctx: Ctx = {
    rng,
    vars: [],
    funcs: [],
    classes: [],
    instances: [],
    budget: { stmts: opts.maxStmts ?? 14 },
    varSeq: { n: 0 },
    fnSeq: { n: 0 },
    clsSeq: { n: 0 },
    labelSeq: { n: 0 },
    blockDepth: 0,
    loopVar: null,
    guaranteed: true,
  };

  const lines: string[] = [];
  while (ctx.budget.stmts > 0) {
    lines.push(genStmt(ctx));
  }
  // 完了値を意味あるものにするため、最後に変数か式を評価する
  const tail = ctx.vars.length ? rng.pick(ctx.vars) : genExpr(ctx, 2);
  lines.push(`${tail};`);
  return lines.join("\n");
}
