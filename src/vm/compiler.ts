import { parse } from "../parser/parser.js";
import type { Program, Statement, Expression } from "../parser/ast.js";
import type { Instruction, BytecodeFunction, ExceptionHandler, Opcode } from "./bytecode.js";

export function compile(source: string): BytecodeFunction {
  const ast = parse(source);
  const compiler = new BytecodeCompiler(null);
  compiler.compileProgram(ast);
  return compiler.finish("<script>");
}

class BytecodeCompiler {
  private bytecode: Instruction[] = [];
  private constants: unknown[] = [];
  private locals: Map<string, number> = new Map();
  private localCount = 0;
  private paramCount = 0;
  // スコープスタック: ブロックスコープに入る時にローカルのスナップショットを保存
  private scopeStack: Map<string, number>[] = [];
  private handlers: ExceptionHandler[] = [];
  private parent: BytecodeCompiler | null;
  private isFunction: boolean;
  // ループスタック: break/continue のジャンプ先パッチ用
  private loopStack: { label?: string; breakPatches: number[]; continuePatches: number[]; continueTarget: number }[] = [];
  private icSlotCount = 0;
  private hasRestParam = false;
  private isGenerator = false;
  private isAsync = false;
  private lexicalLocals = new Set<string>(); // let/const で宣言されたローカル変数名
  private constLocals = new Set<string>(); // const で宣言された変数名 (再代入を禁止するため)
  private blockDepth = 0; // BlockStatement のネスト深さ (ブロック内 function 宣言の判定用)
  // 本体直下の let/const に先行割当したスロット (名前 → slot)。
  // 関数宣言は本体先頭に巻き上げてコンパイルされるため、ソース上で後方の
  // lexical を閉包が参照するとき、宣言文のコンパイル前でも子の resolveUpvalue
  // がここで解決できる必要がある。自スコープの直列コードからは見えないままに
  // する (宣言前アクセスの擬似 TDZ = ReferenceError を保つ) ため locals とは
  // 別に持ち、宣言文の declareLocal 時に同じスロットへ昇格する
  private pendingLexicals = new Map<string, number>();
  private upvalues: { name: string; parentSlot: number }[] = [];

  constructor(parent: BytecodeCompiler | null) {
    this.parent = parent;
    this.isFunction = parent !== null;
  }

  emit(op: Opcode, operand?: number): number {
    const index = this.bytecode.length;
    this.bytecode.push({ op, operand });
    return index;
  }

  // IC スロット付きの命令を emit
  emitWithIC(op: Opcode, operand: number): number {
    const index = this.bytecode.length;
    const icSlot = this.icSlotCount++;
    this.bytecode.push({ op, operand, icSlot });
    return index;
  }

  patch(index: number, operand: number): void {
    this.bytecode[index].operand = operand;
  }

  currentOffset(): number {
    return this.bytecode.length;
  }

  // ラベルに一致するループを探す (ラベルなしは最内ループ)
  findLoop(label: string | null) {
    if (!label) return this.loopStack.length > 0 ? this.loopStack[this.loopStack.length - 1] : null;
    for (let i = this.loopStack.length - 1; i >= 0; i--) {
      if (this.loopStack[i].label === label) return this.loopStack[i];
    }
    return null;
  }

  addConstant(value: unknown): number {
    // BytecodeFunction は参照比較なので indexOf で重複排除しない
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      const existing = this.constants.indexOf(value);
      if (existing !== -1) return existing;
    }
    this.constants.push(value);
    return this.constants.length - 1;
  }

  // 本体直下の let/const を先行スキャンしてスロットを予約する。
  // 巻き上げコンパイルされる関数宣言の閉包解決 (resolveUpvalue) 用。
  // ブロック内の lexical はブロックコンパイル時に別スロットを得るので対象外
  preScanLexicals(stmts: Statement[]): void {
    for (const stmt of stmts) {
      const s = stmt as any;
      if (s.type === "VariableDeclaration" && s.kind !== "var") {
        const names = new Set<string>();
        for (const decl of s.declarations) this.collectPatternNames(decl.id, names);
        for (const name of names) {
          if (!this.locals.has(name) && !this.pendingLexicals.has(name)) {
            this.pendingLexicals.set(name, this.localCount++);
          }
          this.lexicalLocals.add(name);
          if (s.kind === "const") this.constLocals.add(name);
        }
      }
    }
  }

  // ローカル変数のスロットを確保
  declareLocal(name: string): number {
    if (this.locals.has(name)) return this.locals.get(name)!;
    // 本体直下 (blockDepth 0) の宣言は preScanLexicals の予約スロットへ昇格。
    // ブロック/switch/for 内 (blockDepth > 0) はシャドウ用の新スロット
    if (this.blockDepth === 0) {
      const pending = this.pendingLexicals.get(name);
      if (pending !== undefined) {
        this.pendingLexicals.delete(name);
        this.locals.set(name, pending);
        return pending;
      }
    }
    const slot = this.localCount++;
    this.locals.set(name, slot);
    return slot;
  }

  resolveLocal(name: string): number | null {
    return this.locals.get(name) ?? null;
  }

  // 子クロージャからの解決用: 宣言済みローカルに加えて、先行予約された
  // lexical (ソース上で後方の let/const) も見る
  private resolveLocalForChild(name: string): number | null {
    return this.locals.get(name) ?? this.pendingLexicals.get(name) ?? null;
  }

  // 親コンパイラのローカルを再帰的に探索して upvalue index を返す (-1 = 見つからない)
  private resolveUpvalue(name: string): number {
    if (!this.parent) return -1;
    // 親のローカルにあるか (先行予約された lexical 含む)
    const parentSlot = this.parent.resolveLocalForChild(name);
    if (parentSlot !== null) {
      // 既に同じ upvalue があれば再利用
      for (let i = 0; i < this.upvalues.length; i++) {
        if (this.upvalues[i].name === name) return i;
      }
      const idx = this.upvalues.length;
      this.upvalues.push({ name, parentSlot });
      return idx;
    }
    // 親の upvalue にあるか (ネストしたクロージャ)
    if (this.parent.isFunction) {
      const parentUpvalue = this.parent.resolveUpvalue(name);
      if (parentUpvalue >= 0) {
        for (let i = 0; i < this.upvalues.length; i++) {
          if (this.upvalues[i].name === name) return i;
        }
        const idx = this.upvalues.length;
        // parentSlot = -1 - parentUpvalue で「upvalue 参照」を表す
        this.upvalues.push({ name, parentSlot: -(parentUpvalue + 1) });
        return idx;
      }
    }
    return -1;
  }

  // emitLoad が最終的に LdaGlobal に落とすか (= グローバル参照になるか) の
  // 事前判定。emitLoad と同じ解決順 (local → 親 var の global 優先 → upvalue)。
  // resolveUpvalue は名前で dedup されるので先に呼んでも副作用は重複しない
  private resolvesToGlobal(name: string): boolean {
    if (this.resolveLocal(name) !== null) return false;
    if (this.isFunction) {
      if (this.parent && !this.parent.isFunction && this.parent.resolveLocal(name) !== null && !this.parent.lexicalLocals.has(name)) {
        return true; // トップレベル var は global 優先 (emitLoad と同じ)
      }
      if (this.resolveUpvalue(name) >= 0) return false;
    }
    return true;
  }

  // 変数のロード: ローカル → upvalue → グローバル の優先順で解決
  emitLoad(name: string): void {
    const slot = this.resolveLocal(name);
    if (slot !== null) {
      this.emit("LdaLocal", slot);
      return;
    }
    if (this.isFunction) {
      // トップレベル変数: var は global、let/const は upvalue
      if (this.parent && !this.parent.isFunction && this.parent.resolveLocal(name) !== null) {
        if (!this.parent.lexicalLocals.has(name)) {
          // var: global を優先（JIT が LdaGlobal で関連関数を検出するため）
          const nameIdx = this.addConstant(name);
          this.emit("LdaGlobal", nameIdx);
          return;
        }
        // let/const: upvalue として解決 (global には昇格しない)
      }
      const upIdx = this.resolveUpvalue(name);
      if (upIdx >= 0) {
        this.emit("LdaUpvalue", upIdx);
        return;
      }
    }
    const nameIdx = this.addConstant(name);
    this.emit("LdaGlobal", nameIdx);
  }

  // name が (自スコープまたは外側スコープの) const バインディングか。
  // 最初に name をローカルとして宣言しているスコープの const 判定を返す (内側のシャドウ優先)。
  // 先行予約された lexical (pendingLexicals) も宣言済み扱い — 巻き上げコンパイル中の
  // 関数から見た「ソース上で後方の const」への代入も TypeError にするため
  private isConstBinding(name: string): boolean {
    let c: BytecodeCompiler | null = this;
    while (c) {
      if (c.locals.has(name) || c.pendingLexicals.has(name)) return c.constLocals.has(name);
      c = c.parent;
    }
    return false;
  }

  // 変数のストア (代入)。const 再代入は TypeError、未宣言グローバル代入は strict の ReferenceError。
  emitStore(name: string): void {
    if (this.isConstBinding(name)) {
      // const への再代入 → 実行時 TypeError (初期化は compileBindingTarget が別途 StaLocal で行う)
      this.emit("ThrowConstAssign", this.addConstant(name));
      return;
    }
    const slot = this.resolveLocal(name);
    if (slot !== null) {
      this.emit("StaLocal", slot);
      return;
    }
    if (this.isFunction) {
      const upIdx = this.resolveUpvalue(name);
      if (upIdx >= 0) {
        this.emit("StaUpvalue", upIdx);
        return;
      }
    }
    // どのスコープにも束縛が無い代入。strict では暗黙グローバルを作らず ReferenceError。
    const nameIdx = this.addConstant(name);
    this.emit("StaGlobalStrict", nameIdx);
  }

  finish(name: string): BytecodeFunction {
    return {
      name,
      paramCount: this.paramCount,
      localCount: this.localCount,
      hasRestParam: this.hasRestParam,
      isGenerator: this.isGenerator,
      isAsync: this.isAsync,
      bytecode: this.bytecode,
      constants: this.constants,
      handlers: this.handlers,
      icSlotCount: this.icSlotCount,
      upvalues: this.upvalues,
      __jitCached: undefined,
    };
  }

  // 変数バインディング: スタックトップの値を変数に格納して Pop
  // let/const のバインディングパターンから変数名を抽出して事前に declareLocal する
  private preDeclareBindingNames(id: any): void {
    if (id.type === "Identifier") {
      if (this.resolveLocal(id.name) === null) {
        this.declareLocal(id.name);
      }
    } else if (id.type === "ObjectPattern") {
      for (const prop of id.properties) {
        this.preDeclareBindingNames(prop.value);
      }
    } else if (id.type === "ArrayPattern") {
      for (const elem of id.elements) {
        if (elem) this.preDeclareBindingNames(elem);
      }
    }
  }

  // バインディングパターンから全 Identifier 名を out に集める (const 名の収集用)
  private collectPatternNames(id: any, out: Set<string>): void {
    if (!id) return;
    if (id.type === "Identifier") out.add(id.name);
    else if (id.type === "ObjectPattern") for (const p of id.properties) this.collectPatternNames(p.type === "RestElement" ? p.argument : p.value, out);
    else if (id.type === "ArrayPattern") for (const e of id.elements) this.collectPatternNames(e, out);
    else if (id.type === "RestElement") this.collectPatternNames(id.argument, out);
    else if (id.type === "AssignmentPattern") this.collectPatternNames(id.left, out);
  }

  // メンバー代入 (obj.p = v / obj[k] = v / obj.p += v / obj[k] += v) のコンパイル。
  // - 複合代入は「obj (と key) を 1 回だけ評価 → 現在値読み → rhs → 演算 → 書き戻し」。
  //   以前は operator を見ておらず obj.p += 2 が obj.p = 2 として実行されていた
  // - 単純代入も JS 仕様の評価順 (obj → rhs) を守る。副作用がなく冪等な object 式
  //   (this / Identifier) は従来の rhs → obj のバイトコード形を保ち、JIT の
  //   ホットパス (this.x = v) の形を崩さない。LdaGlobal になる Identifier は
  //   CheckGlobal で存在チェックだけ先行させる (LdaGlobal の唯一の観測可能な効果)
  private compileMemberAssignment(expr: any): void {
    const left = expr.left;
    // 副作用なし & 冪等 → 2 回 emit してよい object/key 式
    const isSimple = (e: any) =>
      e.type === "ThisExpression" || e.type === "Identifier" || e.type === "Literal";

    if (expr.operator !== "=") {
      const compoundOps: Record<string, Opcode> = {
        "+=": "Add", "-=": "Sub", "*=": "Mul", "/=": "Div", "%=": "Mod",
      };
      const op = compoundOps[expr.operator];
      if (!op) throw new Error(`Unsupported assignment operator: ${expr.operator}`);
      if (left.computed) {
        if (isSimple(left.object) && isSimple(left.property)) {
          // SetPropertyComputed のスタック契約: [obj, key, value]
          this.compileExpression(left.object);
          this.compileExpression(left.property);
          this.compileExpression(left.object);
          this.compileExpression(left.property);
          this.emit("GetPropertyComputed");
          this.compileExpression(expr.right);
          this.emit(op);
          this.emit("SetPropertyComputed");
        } else {
          const tmpObj = this.declareLocal(`__ma_obj_${this.currentOffset()}`);
          const tmpKey = this.declareLocal(`__ma_key_${this.currentOffset()}`);
          this.compileExpression(left.object);
          this.emit("StaLocal", tmpObj); this.emit("Pop");
          this.compileExpression(left.property);
          this.emit("StaLocal", tmpKey); this.emit("Pop");
          this.emit("LdaLocal", tmpObj);
          this.emit("LdaLocal", tmpKey);
          this.emit("LdaLocal", tmpObj);
          this.emit("LdaLocal", tmpKey);
          this.emit("GetPropertyComputed");
          this.compileExpression(expr.right);
          this.emit(op);
          this.emit("SetPropertyComputed");
        }
      } else {
        const nameIdx = this.addConstant(left.property.name);
        if (isSimple(left.object)) {
          this.compileExpression(left.object);
          this.emitWithIC("GetProperty", nameIdx);
          this.compileExpression(expr.right);
          this.emit(op);
          this.compileExpression(left.object);
          this.emitWithIC("SetPropertyAssign", nameIdx);
        } else {
          const tmpObj = this.declareLocal(`__ma_obj_${this.currentOffset()}`);
          this.compileExpression(left.object);
          this.emit("StaLocal", tmpObj); this.emit("Pop");
          this.emit("LdaLocal", tmpObj);
          this.emitWithIC("GetProperty", nameIdx);
          this.compileExpression(expr.right);
          this.emit(op);
          this.emit("LdaLocal", tmpObj);
          this.emitWithIC("SetPropertyAssign", nameIdx);
        }
      }
      return;
    }

    // 単純代入 "="
    if (left.computed) {
      // 既に obj → key → rhs の順 (仕様通り)
      this.compileExpression(left.object);
      this.compileExpression(left.property);
      this.compileExpression(expr.right);
      this.emit("SetPropertyComputed");
      return;
    }
    const nameIdx = this.addConstant(left.property.name);
    if (isSimple(left.object)) {
      // 従来形 (rhs → obj) を維持。グローバル参照だけ存在チェックを先行
      if (left.object.type === "Identifier" && this.resolvesToGlobal(left.object.name)) {
        this.emit("CheckGlobal", this.addConstant(left.object.name));
      }
      this.compileExpression(expr.right);
      this.compileExpression(left.object);
      this.emitWithIC("SetPropertyAssign", nameIdx);
    } else {
      // 副作用がありうる object 式 → 先に評価して temp に保持 (評価順: obj → rhs)
      const tmpObj = this.declareLocal(`__ma_obj_${this.currentOffset()}`);
      this.compileExpression(left.object);
      this.emit("StaLocal", tmpObj); this.emit("Pop");
      this.compileExpression(expr.right);
      this.emit("LdaLocal", tmpObj);
      this.emitWithIC("SetPropertyAssign", nameIdx);
    }
  }

  compileBindingTarget(id: any): void {
    if (id.type === "Identifier") {
      if (this.isFunction || this.resolveLocal(id.name) !== null) {
        const slot = this.resolveLocal(id.name) ?? this.declareLocal(id.name);
        this.emit("StaLocal", slot);
      } else {
        // トップレベル var: グローバルに格納
        const nameIdx = this.addConstant(id.name);
        this.emit("StaGlobal", nameIdx);
      }
      this.emit("Pop");
    } else if (id.type === "ObjectPattern") {
      // stack: obj → 各プロパティを取り出す
      const boundKeys: string[] = [];
      for (const prop of id.properties) {
        if (prop.type === "RestElement") {
          // {...rest}: 残りのプロパティを集める
          // ExecExpr でランタイムに処理（Object.keys フィルタが必要）
          // 簡易実装: boundKeys を除外した新オブジェクトを作る
          // → VM で直接サポートが難しいので、一旦 obj をそのままバインド
          // TODO: proper object rest
          this.emit("Dup");
          this.compileBindingTarget(prop.argument);
          break;
        }
        boundKeys.push(prop.key.name);
        this.emit("Dup"); // obj を残す
        const nameIdx = this.addConstant(prop.key.name);
        this.emitWithIC("GetProperty", nameIdx);
        this.compileBindingTarget(prop.value);
      }
      this.emit("Pop"); // obj を捨てる
    } else if (id.type === "ArrayPattern") {
      // stack: iterable → GetIterator → temp global に保存 → 1要素ずつ取り出す
      this.emit("GetIterator");
      const iterName = `__dstr_iter_${this.currentOffset()}`;
      const iterIdx = this.addConstant(iterName);
      this.emit("StaGlobal", iterIdx);    // iterator を保存
      this.emit("Pop");                   // stack を空に
      for (let i = 0; i < id.elements.length; i++) {
        const el = id.elements[i];
        if (!el) {
          // elision: iterator を進めるが値は捨てる
          this.emit("LdaGlobal", iterIdx);
          this.emit("IteratorNext");
          this.emit("Pop");
          continue;
        }
        if (el.type === "RestElement") {
          // [...rest]: 残り全部を配列に集める
          this.emit("CreateArray", 0);      // stack: restArr
          const loopStart = this.currentOffset();
          this.emit("LdaGlobal", iterIdx);  // stack: restArr, iterator
          this.emit("IteratorNext");        // stack: restArr, result
          this.emit("Dup");                 // stack: restArr, result, result
          this.emit("IteratorComplete");    // stack: restArr, result, done
          const exitJump = this.emit("JumpIfTrue", 0);
          this.emit("IteratorValue");       // stack: restArr, value
          this.emit("ArrayPush");           // stack: restArr
          const backJump = this.emit("Jump", 0);
          this.patch(backJump, loopStart);
          this.patch(exitJump, this.currentOffset());
          this.emit("Pop");                 // pop result (done=true)
          // stack: restArr
          this.compileBindingTarget(el.argument);
          return;
        }
        this.emit("LdaGlobal", iterIdx);   // stack: iterator
        this.emit("IteratorNext");         // stack: result
        this.emit("IteratorValue");        // stack: value
        this.compileBindingTarget(el);     // stack: (empty)
      }
    } else if (id.type === "AssignmentPattern") {
      // stack: value → value が undefined ならデフォルト値を使う
      this.emit("Dup");
      this.emit("LdaUndefined");
      this.emit("StrictEqual");
      const skipDefault = this.emit("JumpIfFalse", 0);
      this.emit("Pop"); // undefined を捨てる
      this.compileExpression(id.right); // デフォルト値
      this.patch(skipDefault, this.currentOffset());
      this.compileBindingTarget(id.left);
    }
  }

  compileProgram(program: Program): void {
    // lexical (let/const) の先行スキャン: 巻き上げコンパイルされる関数が
    // ソース上で後方の let/const を閉包参照できるように、スロットと
    // const 判定を先に確定させる
    this.preScanLexicals(program.body);
    // function hoisting: 関数宣言を先にコンパイルしてグローバルに登録
    for (const stmt of program.body) {
      if (stmt.type === "FunctionDeclaration") {
        this.compileStatement(stmt);
      }
    }
    // var hoisting: var 宣言を事前に undefined でグローバルに登録。
    // ネストしたブロック (非実行の if 分岐や 0 回の for 本体) 内の var も
    // 巻き上げ対象なので再帰的に収集する
    const hoistedVars = new Set<string>();
    this.hoistVarNames(program.body, (id) => this.collectPatternNames(id, hoistedVars));
    for (const name of hoistedVars) {
      this.emit("LdaUndefined");
      this.emit("StaGlobal", this.addConstant(name));
      this.emit("Pop");
    }
    for (let i = 0; i < program.body.length; i++) {
      const stmt = program.body[i];
      if (stmt.type === "FunctionDeclaration") continue; // hoisting で処理済み
      const isLast = i === program.body.length - 1;
      this.compileStatement(stmt);
      // 最後の式文の値をスタックに残す (プログラムの戻り値)
      if (stmt.type === "ExpressionStatement" && isLast) {
        // compileStatement が Pop を emit したので、最後だけ取り消す
        this.bytecode.pop(); // Pop を除去
      }
    }
  }

  compileFunctionBody(params: any[], body: Statement[], isArrow?: boolean): void {
    // パラメータをローカルスロットに登録
    this.paramCount = params.length;
    const destructureParams: { slot: number; pattern: any }[] = [];
    const defaultParams: { slot: number; defaultExpr: any }[] = [];
    for (const param of params) {
      if (param.type === "Identifier") {
        this.declareLocal(param.name);
      } else if (param.type === "AssignmentPattern") {
        // デフォルト引数: function f(x = 10) → slot に undefined が来たらデフォルト値
        if (param.left.type === "Identifier") {
          const slot = this.declareLocal(param.left.name);
          defaultParams.push({ slot, defaultExpr: param.right });
        } else {
          const slot = this.localCount++;
          destructureParams.push({ slot, pattern: param.left });
          defaultParams.push({ slot, defaultExpr: param.right });
        }
      } else if (param.type === "RestElement") {
        this.declareLocal(param.argument.name);
        this.hasRestParam = true;
      } else if (param.type === "ArrayPattern" || param.type === "ObjectPattern") {
        const slot = this.localCount++;
        destructureParams.push({ slot, pattern: param });
      }
    }
    // デフォルト引数: undefined なら default 値で上書き
    for (const { slot, defaultExpr } of defaultParams) {
      this.emit("LdaLocal", slot);
      this.emit("LdaUndefined");
      this.emit("StrictEqual");
      const skipDefault = this.emit("JumpIfFalse", 0);
      this.compileExpression(defaultExpr);
      this.emit("StaLocal", slot);
      this.emit("Pop");
      this.patch(skipDefault, this.currentOffset());
    }
    // 分割代入パラメータを展開
    for (const { slot, pattern } of destructureParams) {
      this.emit("LdaLocal", slot);
      this.compileBindingTarget(pattern);
    }
    // arguments オブジェクト (アロー関数以外)
    if (!isArrow) {
      this.declareLocal("arguments");
    }
    // function declaration hoisting: 本体内の `function f(){}` を事前に
    // declareLocal しておく → 再帰呼び出しや前方参照が動く (`walk` recursive 等)
    for (const stmt of body) {
      if (stmt.type === "FunctionDeclaration" && (stmt as any).id?.name) {
        const name = (stmt as any).id.name;
        if (this.resolveLocal(name) === null) this.declareLocal(name);
      }
    }
    // var hoisting: 本体内 (ネスト関数は除く) の var 束縛名を事前に
    // declareLocal。これが無いと「クロージャがソース上で後方の var を
    // 参照する」とき、compile 時点で locals に無く global 扱いになる
    // (navier-stokes の this.update が var dens_prev より前にあるパターン)
    this.hoistVarNames(body);
    // lexical (let/const) の先行スキャン (compileProgram と同じ理由:
    // ソース上で前方にある関数宣言/クロージャが後方の lexical を参照できるように)
    this.preScanLexicals(body);
    // 本体をコンパイル
    for (const stmt of body) {
      this.compileStatement(stmt);
    }
    // 明示的 return がない場合は undefined を返す
    this.emit("LdaUndefined");
    this.emit("Return");
  }

  // 関数本体の var 束縛名を再帰的に集めて declare する (var hoisting)。
  // ネスト関数 (FunctionDeclaration/FunctionExpression) の中は走査しない。
  // declare 省略時は declareLocal (関数本体用)。compileProgram はグローバル
  // 登録用に名前収集コールバックを渡す。
  hoistVarNames(stmts: Statement[], declare: (id: unknown) => void = (id) => this.preDeclareBindingNames(id)): void {
    for (const stmt of stmts) {
      const s = stmt as any;
      switch (s.type) {
        case "VariableDeclaration":
          if (s.kind === "var") {
            for (const decl of s.declarations) declare(decl.id);
          }
          break;
        case "BlockStatement": this.hoistVarNames(s.body, declare); break;
        case "IfStatement":
          this.hoistVarNames([s.consequent], declare);
          if (s.alternate) this.hoistVarNames([s.alternate], declare);
          break;
        case "WhileStatement": case "DoWhileStatement":
          this.hoistVarNames([s.body], declare); break;
        case "ForStatement":
          if (s.init && s.init.type === "VariableDeclaration" && s.init.kind === "var") {
            for (const decl of s.init.declarations) declare(decl.id);
          }
          this.hoistVarNames([s.body], declare);
          break;
        case "ForInStatement": case "ForOfStatement":
          if (s.left && s.left.type === "VariableDeclaration" && s.left.kind === "var") {
            for (const decl of s.left.declarations) declare(decl.id);
          }
          this.hoistVarNames([s.body], declare);
          break;
        case "TryStatement":
          if (s.block) this.hoistVarNames(s.block.body, declare);
          if (s.handler?.body) this.hoistVarNames(s.handler.body.body, declare);
          if (s.finalizer) this.hoistVarNames(s.finalizer.body, declare);
          break;
        case "SwitchStatement":
          for (const c of s.cases ?? []) this.hoistVarNames(c.consequent ?? [], declare);
          break;
        case "LabeledStatement": this.hoistVarNames([s.body], declare); break;
        default: break;
      }
    }
  }

  compileStatement(stmt: Statement): void {
    switch (stmt.type) {
      case "ExpressionStatement":
        this.compileExpression(stmt.expression);
        this.emit("Pop");
        break;

      case "VariableDeclaration": {
        // const 宣言名を記録 (再代入禁止のため; トップレベル・関数内どちらも)
        if (stmt.kind === "const") {
          for (const decl of stmt.declarations) {
            this.collectPatternNames(decl.id, this.constLocals);
          }
        }
        // let/const はトップレベルでもローカルスロットを使う (ブロックスコープ)
        if (!this.isFunction && stmt.kind !== "var") {
          for (const decl of stmt.declarations) {
            this.preDeclareBindingNames(decl.id);
            // lexical 変数を記録 (子関数で upvalue として解決するため)
            if (decl.id.type === "Identifier") {
              this.lexicalLocals.add(decl.id.name);
            }
          }
        }
        for (const decl of stmt.declarations) {
          if (decl.init) {
            // 関数名推論: var f = function() {} → f.name === "f"
            if (decl.id.type === "Identifier" && this.isNameableFunctionExpr(decl.init)) {
              this.compileExpression(decl.init, decl.id.name);
            } else {
              this.compileExpression(decl.init);
            }
          } else {
            this.emit("LdaUndefined");
          }
          this.compileBindingTarget(decl.id);
        }
        break;
      }

      case "FunctionDeclaration": {
        const fnCompiler = new BytecodeCompiler(this);
        if ((stmt as any).generator) fnCompiler.isGenerator = true;
        if ((stmt as any).async) fnCompiler.isAsync = true;
        fnCompiler.compileFunctionBody(stmt.params, stmt.body.body);
        const fnBytecode = fnCompiler.finish(stmt.id.name);
        const fnIndex = this.addConstant(fnBytecode);
        this.emit("LdaConst", fnIndex);
        const fnSlot = this.resolveLocal(stmt.id.name) ?? this.declareLocal(stmt.id.name);
        this.emit("StaLocal", fnSlot);
        // トップレベル関数はグローバルにも登録 (再帰呼び出し + JIT 用)。
        // ブロック内 function 宣言は block-scoped なのでグローバルへ漏らさない
        if (!this.isFunction && this.blockDepth === 0) {
          this.emit("Dup");
          const nameIdx = this.addConstant(stmt.id.name);
          this.emit("StaGlobal", nameIdx);
        }
        this.emit("Pop");
        break;
      }

      case "ReturnStatement": {
        if (stmt.argument) {
          this.compileExpression(stmt.argument);
        } else {
          this.emit("LdaUndefined");
        }
        this.emit("Return");
        break;
      }

      case "ThrowStatement": {
        this.compileExpression(stmt.argument);
        this.emit("Throw");
        break;
      }

      case "TryStatement": {
        const tryStart = this.currentOffset();
        this.compileStatement(stmt.block);
        const jumpOverCatch = this.emit("Jump", 0);
        const tryEnd = this.currentOffset();

        // catch ブロック
        const catchStart = stmt.handler ? this.currentOffset() : -1;
        let catchVarSlot = -1;
        let catchVarName = "";
        if (stmt.handler) {
          catchVarName = stmt.handler.param.name;
          if (this.isFunction) {
            catchVarSlot = this.declareLocal(catchVarName);
          }
          // VM が例外値をスタックに push してここにジャンプする
          // 例外値を catch 変数に格納
          if (catchVarSlot >= 0) {
            this.emit("StaLocal", catchVarSlot);
          } else {
            const nameIdx = this.addConstant(catchVarName);
            this.emit("StaGlobal", nameIdx);
          }
          this.emit("Pop");
          this.compileStatement(stmt.handler.body);
        }
        this.patch(jumpOverCatch, this.currentOffset());

        // finally ブロック
        const finallyStart = stmt.finalizer ? this.currentOffset() : -1;
        if (stmt.finalizer) {
          this.compileStatement(stmt.finalizer);
        }

        this.handlers.push({
          tryStart, tryEnd, catchStart,
          catchVarSlot, catchVarName, finallyStart,
        });
        break;
      }

      case "IfStatement": {
        this.compileExpression(stmt.test);
        const jumpIfFalse = this.emit("JumpIfFalse", 0);
        this.compileStatement(stmt.consequent);
        if (stmt.alternate) {
          const jumpOver = this.emit("Jump", 0);
          this.patch(jumpIfFalse, this.currentOffset());
          this.compileStatement(stmt.alternate);
          this.patch(jumpOver, this.currentOffset());
        } else {
          this.patch(jumpIfFalse, this.currentOffset());
        }
        break;
      }

      case "SwitchStatement": {
        // Phase 1: 比較フェーズ — 各 case の test と discriminant を比較
        // Phase 2: body フェーズ — fall-through で連続配置
        //
        // 比較: disc === case0.test → JumpIfTrue body0
        //       disc === case1.test → JumpIfTrue body1
        //       ...
        //       Jump default_body (or end)
        // body0: ... (fall-through to body1)
        // body1: ...
        // default_body: ...
        // end:

        this.compileExpression(stmt.discriminant);
        const discSlot = this.declareLocal("__switch_disc__");
        this.emit("StaLocal", discSlot);
        this.emit("Pop");

        // case 内の function 宣言は switch ブロックに block-scoped (strict)。
        // BlockStatement と同じ scopeStack シャドウイングで、全 case の宣言を
        // 比較フェーズより前に巻き上げる (case の test からも呼べるため)
        const switchFnDecls = stmt.cases.flatMap((c: any) =>
          (c.consequent ?? []).filter((s: any) => s.type === "FunctionDeclaration"));
        const hasSwitchScoped = switchFnDecls.length > 0;
        if (hasSwitchScoped) {
          this.scopeStack.push(new Map(this.locals));
          for (const s of switchFnDecls) {
            if ((s as any).id?.name) this.locals.delete((s as any).id.name);
          }
        }
        this.blockDepth++;
        for (const s of switchFnDecls) this.compileStatement(s);

        this.loopStack.push({ label: (stmt as any).__label__, breakPatches: [], continuePatches: [], continueTarget: -1 });

        // Phase 1: 比較 → body へのジャンプ
        const jumpToBody: number[] = []; // 一致時のジャンプ (パッチ対象)
        let defaultJumpIdx = -1;
        for (let i = 0; i < stmt.cases.length; i++) {
          const c = stmt.cases[i];
          if (c.test === null) {
            defaultJumpIdx = i;
            jumpToBody.push(-1); // placeholder
            continue;
          }
          this.emit("LdaLocal", discSlot);
          this.compileExpression(c.test);
          this.emit("StrictEqual");
          jumpToBody.push(this.emit("JumpIfTrue", 0));
        }
        // 全不一致 → default or end
        const jumpToDefaultOrEnd = this.emit("Jump", 0);

        // Phase 2: body (fall-through で連続配置)。function 宣言は巻き上げ済みなので skip
        const bodyOffsets: number[] = [];
        for (let i = 0; i < stmt.cases.length; i++) {
          bodyOffsets.push(this.currentOffset());
          for (const s of stmt.cases[i].consequent) {
            if ((s as any).type === "FunctionDeclaration") continue;
            this.compileStatement(s);
          }
        }
        const switchEnd = this.currentOffset();

        // パッチ: 一致時ジャンプ → body 開始位置
        for (let i = 0; i < stmt.cases.length; i++) {
          if (jumpToBody[i] >= 0) {
            this.patch(jumpToBody[i], bodyOffsets[i]);
          }
        }
        // default or end
        if (defaultJumpIdx >= 0) {
          this.patch(jumpToDefaultOrEnd, bodyOffsets[defaultJumpIdx]);
        } else {
          this.patch(jumpToDefaultOrEnd, switchEnd);
        }

        // break パッチ
        const loop = this.loopStack.pop()!;
        for (const bp of loop.breakPatches) this.patch(bp, switchEnd);
        this.blockDepth--;
        if (hasSwitchScoped) {
          this.locals = this.scopeStack.pop()!;
        }
        break;
      }

      case "DoWhileStatement": {
        // do { body } while (test);
        const loopStart = this.currentOffset();
        this.loopStack.push({ label: (stmt as any).__label__, breakPatches: [], continuePatches: [], continueTarget: loopStart });
        this.compileStatement(stmt.body);
        this.compileExpression(stmt.test);
        this.emit("JumpIfTrue", loopStart);
        const loop = this.loopStack.pop()!;
        for (const bp of loop.breakPatches) this.patch(bp, this.currentOffset());
        break;
      }

      case "WhileStatement": {
        const loopStart = this.currentOffset();
        this.loopStack.push({ label: (stmt as any).__label__, breakPatches: [], continuePatches: [], continueTarget: loopStart });
        this.compileExpression(stmt.test);
        const exitJump = this.emit("JumpIfFalse", 0);
        this.compileStatement(stmt.body);
        this.emit("Jump", loopStart);
        this.patch(exitJump, this.currentOffset());
        const loop = this.loopStack.pop()!;
        for (const bp of loop.breakPatches) this.patch(bp, this.currentOffset());
        break;
      }

      case "ForStatement": {
        // for (let/const ...) のブロックスコープ。blockDepth も上げて
        // for-init の let が本体直下の予約スロット (pendingLexicals) を
        // 誤って消費しないようにする
        const forHasBlockScoped = stmt.init?.type === "VariableDeclaration" && stmt.init.kind !== "var";
        if (forHasBlockScoped) {
          this.scopeStack.push(new Map(this.locals));
          this.blockDepth++;
        }
        if (stmt.init) {
          if (stmt.init.type === "VariableDeclaration") {
            this.compileStatement(stmt.init);
          } else {
            this.compileExpression(stmt.init);
            this.emit("Pop");
          }
        }
        const loopStart = this.currentOffset();
        // continue は update を実行してからループ先頭に戻る
        // → continue のジャンプ先は update の先頭
        this.loopStack.push({ label: (stmt as any).__label__, breakPatches: [], continuePatches: [], continueTarget: -1 }); // 後でパッチ
        let exitJump = -1;
        if (stmt.test) {
          this.compileExpression(stmt.test);
          exitJump = this.emit("JumpIfFalse", 0);
        }
        this.compileStatement(stmt.body);
        // continue はここにジャンプ
        const continueTarget = this.currentOffset();
        this.loopStack[this.loopStack.length - 1].continueTarget = continueTarget;
        // continue パッチ: body 内の continue が update の先頭にジャンプするように
        for (const cp of this.loopStack[this.loopStack.length - 1].continuePatches) {
          this.patch(cp, continueTarget);
        }
        if (stmt.update) {
          this.compileExpression(stmt.update);
          this.emit("Pop");
        }
        this.emit("Jump", loopStart);
        if (exitJump >= 0) {
          this.patch(exitJump, this.currentOffset());
        }
        const loop = this.loopStack.pop()!;
        for (const bp of loop.breakPatches) this.patch(bp, this.currentOffset());
        if (forHasBlockScoped) {
          this.locals = this.scopeStack.pop()!;
          this.blockDepth--;
        }
        break;
      }

      case "BlockStatement": {
        // let/const とブロック内 function 宣言は block-scoped (strict)
        const hasBlockScoped = stmt.body.some(
          (s: any) => (s.type === "VariableDeclaration" && s.kind !== "var") || s.type === "FunctionDeclaration"
        );
        if (hasBlockScoped) {
          // スコープを push — 同名変数は新しいスロットに割り当てられる
          this.scopeStack.push(new Map(this.locals));
          // ブロック内の let/const/function を強制的に新スロットに割り当て
          for (const s of stmt.body) {
            if ((s as any).type === "VariableDeclaration" && (s as any).kind !== "var") {
              for (const decl of (s as any).declarations) {
                if (decl.id.type === "Identifier") {
                  // 既存のマッピングを削除して新スロットを強制
                  this.locals.delete(decl.id.name);
                }
              }
            } else if ((s as any).type === "FunctionDeclaration" && (s as any).id?.name) {
              this.locals.delete((s as any).id.name);
            }
          }
        }
        // function 宣言をブロック先頭に巻き上げてからその他の文をコンパイル
        // (strict: ブロック内では宣言前から呼べ、ブロックの外には漏れない)
        this.blockDepth++;
        for (const s of stmt.body) {
          if ((s as any).type === "FunctionDeclaration") this.compileStatement(s);
        }
        for (const s of stmt.body) {
          if ((s as any).type !== "FunctionDeclaration") this.compileStatement(s);
        }
        this.blockDepth--;
        if (hasBlockScoped) {
          this.locals = this.scopeStack.pop()!;
        }
        break;
      }

      case "ClassDeclaration": {
        // インスタンスフィールドを収集
        const instanceFields = stmt.body.body.filter((m: any) => m.type === "PropertyDefinition" && !m.static);

        // constructor を BytecodeFunction にコンパイル
        const ctorMethod = stmt.body.body.find((m: any) => m.type === "MethodDefinition" && m.kind === "constructor");
        if (ctorMethod) {
          const fnCompiler = new BytecodeCompiler(this);
          fnCompiler.compileFunctionBody(ctorMethod.value.params, ctorMethod.value.body.body);
          const ctorFunc = fnCompiler.finish(stmt.id.name);
          (ctorFunc as any).prototype = {};
          if (instanceFields.length > 0) (ctorFunc as any).__instanceFields = instanceFields;
          const ctorIdx = this.addConstant(ctorFunc);
          this.emit("LdaConst", ctorIdx);
        } else {
          const fnCompiler = new BytecodeCompiler(this);
          fnCompiler.compileFunctionBody([], []);
          const ctorFunc = fnCompiler.finish(stmt.id.name);
          (ctorFunc as any).prototype = {};
          if (instanceFields.length > 0) (ctorFunc as any).__instanceFields = instanceFields;
          const ctorIdx = this.addConstant(ctorFunc);
          this.emit("LdaConst", ctorIdx);
        }
        // メソッド/getter/setter を prototype (or class for static) に設定
        for (const member of stmt.body.body) {
          if (member.type === "PropertyDefinition") continue;
          if (member.kind === "constructor") continue;
          const name = member.computed ? null : (member.key.type === "Literal" ? String(member.key.value) : member.key.name);

          if (member.kind === "method") {
            if (member.static) {
              this.emit("Dup");
            } else {
              this.emit("Dup");
              this.emitWithIC("GetProperty", this.addConstant("prototype"));
            }
            if (member.computed) {
              // computed: target, key, value → SetPropertyComputed
              this.compileExpression(member.key);
              const fnCompiler = new BytecodeCompiler(this);
              if ((member.value as any).generator) fnCompiler.isGenerator = true;
              fnCompiler.compileFunctionBody(member.value.params, member.value.body.body);
              this.emit("LdaConst", this.addConstant(fnCompiler.finish("<computed>")));
              this.emit("SetPropertyComputed");
            } else {
              const fnCompiler = new BytecodeCompiler(this);
              if ((member.value as any).generator) fnCompiler.isGenerator = true;
              fnCompiler.compileFunctionBody(member.value.params, member.value.body.body);
              this.emit("LdaConst", this.addConstant(fnCompiler.finish(name!)));
              this.emitWithIC("SetProperty", this.addConstant(name!));
            }
            this.emit("Pop");
          } else if (member.kind === "get" || member.kind === "set") {
            if (member.static) {
              this.emit("Dup");
            } else {
              this.emit("Dup");
              this.emitWithIC("GetProperty", this.addConstant("prototype"));
            }
            const fnCompiler = new BytecodeCompiler(this);
            fnCompiler.compileFunctionBody(member.value.params, member.value.body.body);
            this.emit("LdaConst", this.addConstant(fnCompiler.finish((member.kind) + " " + (name ?? "<computed>"))));
            if (member.computed) {
              // computed getter/setter は未対応 → 通常のメソッドとして設定
              this.compileExpression(member.key);
              // swap key and func on stack... 複雑なので一旦 SetPropertyComputed
              // TODO: computed getter/setter
              this.emit("SetPropertyComputed");
            } else {
              const nameIdx = this.addConstant(name!);
              this.emit(member.kind === "get" ? "DefineGetter" : "DefineSetter", nameIdx);
            }
            this.emit("Pop");
          }
        }
        // static フィールドを初期化
        for (const member of stmt.body.body) {
          if (member.type === "PropertyDefinition" && member.static) {
            const name = member.computed ? null : (member.key.type === "Literal" ? String(member.key.value) : member.key.name);
            this.emit("Dup");
            if (member.computed) {
              this.compileExpression(member.key);
              if (member.value) {
                this.compileExpression(member.value);
              } else {
                this.emit("LdaUndefined");
              }
              this.emit("SetPropertyComputed");
            } else {
              if (member.value) {
                this.compileExpression(member.value);
              } else {
                this.emit("LdaUndefined");
              }
              this.emitWithIC("SetProperty", this.addConstant(name!));
            }
            this.emit("Pop");
          }
        }
        // クラス名を登録
        if (this.isFunction) {
          const slot = this.resolveLocal(stmt.id.name) ?? this.declareLocal(stmt.id.name);
          this.emit("StaLocal", slot);
        } else {
          const nameIdx = this.addConstant(stmt.id.name);
          this.emit("StaGlobal", nameIdx);
        }
        this.emit("Pop");
        break;
      }

      case "BreakStatement": {
        const breakJump = this.emit("Jump", 0); // 後でパッチ
        const target = this.findLoop(stmt.label);
        if (target) target.breakPatches.push(breakJump);
        break;
      }

      case "ContinueStatement": {
        const loop = this.findLoop(stmt.label);
        if (loop) {
          if (loop.continueTarget >= 0) {
            this.emit("Jump", loop.continueTarget);
          } else {
            loop.continuePatches.push(this.emit("Jump", 0));
          }
        }
        break;
      }

      case "LabeledStatement": {
        // ラベルを子のループに伝播するため、ループ文なら label を付けてコンパイル
        (stmt.body as any).__label__ = stmt.label;
        this.compileStatement(stmt.body);
        break;
      }

      case "ForInStatement": {
        // for (var k in obj) — Object.keys(obj) を取って iterate。
        // 関数内なら local slot、トップレベルなら global を使う (再帰時の衝突を避けるため)
        const useLocal = this.isFunction;
        const ldaTmp = (slot: number, gIdx: number) => useLocal ? this.emit("LdaLocal", slot) : this.emit("LdaGlobal", gIdx);
        const staTmp = (slot: number, gIdx: number) => useLocal ? this.emit("StaLocal", slot) : this.emit("StaGlobal", gIdx);
        const offset = this.currentOffset();
        const keysSlot = useLocal ? this.localCount++ : 0;
        const counterSlot = useLocal ? this.localCount++ : 0;
        const keysG = !useLocal ? this.addConstant(`__forin_keys_${offset}`) : 0;
        const counterG = !useLocal ? this.addConstant(`__forin_idx_${offset}`) : 0;

        this.compileExpression(stmt.right);
        // Object.keys(obj) を呼ぶ: スタックに [obj, Object.keys] を積んで Call
        this.emit("LdaGlobal", this.addConstant("Object"));
        this.emitWithIC("GetProperty", this.addConstant("keys"));
        this.emit("Call", 1);
        staTmp(keysSlot, keysG);
        this.emit("Pop");
        // counter = 0
        this.emit("LdaConst", this.addConstant(0));
        staTmp(counterSlot, counterG);
        this.emit("Pop");
        const loopStart = this.currentOffset();
        ldaTmp(counterSlot, counterG);
        ldaTmp(keysSlot, keysG);
        this.emitWithIC("GetProperty", this.addConstant("length"));
        this.emit("LessThan");
        const exitJump = this.emit("JumpIfFalse", 0);
        // k = keys[i]
        ldaTmp(keysSlot, keysG);
        ldaTmp(counterSlot, counterG);
        this.emit("GetPropertyComputed");
        this.compileBindingTarget(stmt.left.declarations[0].id);
        // body
        this.compileStatement(stmt.body);
        // i++
        ldaTmp(counterSlot, counterG);
        this.emit("LdaConst", this.addConstant(1));
        this.emit("Add");
        staTmp(counterSlot, counterG);
        this.emit("Pop");
        this.emit("Jump", loopStart);
        this.patch(exitJump, this.currentOffset());
        break;
      }

      case "ForOfStatement": {
        // iterator protocol。再帰呼び出し時に衝突しないよう、関数内なら local slot を使う
        const useLocal = this.isFunction;
        const iterSlot = useLocal ? this.localCount++ : 0;
        const iterG = !useLocal ? this.addConstant(`__iter_${this.currentOffset()}`) : 0;

        this.compileExpression(stmt.right);
        this.emit("GetIterator");
        if (useLocal) this.emit("StaLocal", iterSlot); else this.emit("StaGlobal", iterG);
        this.emit("Pop");

        const loopStart = this.currentOffset();
        this.loopStack.push({ label: (stmt as any).__label__, breakPatches: [], continuePatches: [], continueTarget: loopStart });

        // IteratorNext: pop iterator, push result
        if (useLocal) this.emit("LdaLocal", iterSlot); else this.emit("LdaGlobal", iterG);
        this.emit("IteratorNext");
        // stack: [result]

        // IteratorComplete: peek result, push done
        this.emit("Dup");
        this.emit("IteratorComplete");
        // stack: [result, done]
        const exitJump = this.emit("JumpIfTrue", 0);
        // stack: [result]

        // IteratorValue: pop result, push value
        this.emit("IteratorValue");
        // stack: [value]

        this.compileBindingTarget(stmt.left.declarations[0].id);
        // stack: []

        this.compileStatement(stmt.body);
        this.emit("Jump", loopStart);

        this.patch(exitJump, this.currentOffset());
        this.emit("Pop"); // done=true の result を捨てる

        const loop = this.loopStack.pop()!;
        for (const bp of loop.breakPatches) this.patch(bp, this.currentOffset());
        break;
      }

      case "EmptyStatement":
        break;

      default:
        throw new Error(`Unsupported statement: ${stmt.type}`);
    }
  }

  private isNameableFunctionExpr(expr: any): boolean {
    return expr.type === "FunctionExpression" || expr.type === "ArrowFunctionExpression" || expr.type === "ClassExpression";
  }

  compileExpression(expr: Expression, inferredName?: string): void {
    switch (expr.type) {
      case "Literal": {
        if (expr.value === null) {
          this.emit("LdaNull");
        } else if (expr.value === true) {
          this.emit("LdaTrue");
        } else if (expr.value === false) {
          this.emit("LdaFalse");
        } else {
          const index = this.addConstant(expr.value);
          this.emit("LdaConst", index);
        }
        break;
      }

      case "RegExpLiteral": {
        // host RegExp を constant pool に入れて LdaConst で共有。
        // ES5 セマンティクス (literal が同じ instance を返す)。ES6 以降の
        // "毎回新しい instance" を厳密に守るには専用 opcode が必要だが、
        // Stage A では割り切る。lastIndex を使う code はそこで踏む可能性あり
        const re = new RegExp(expr.pattern, expr.flags);
        const index = this.addConstant(re);
        this.emit("LdaConst", index);
        break;
      }

      case "Identifier": {
        this.emitLoad(expr.name);
        break;
      }

      case "ThisExpression":
        this.emit("LoadThis");
        break;

      case "NewExpression": {
        for (const arg of expr.arguments) {
          this.compileExpression(arg as Expression);
        }
        this.compileExpression(expr.callee);
        this.emit("Construct", expr.arguments.length);
        break;
      }

      case "FunctionExpression": {
        const fnCompiler = new BytecodeCompiler(this);
        if ((expr as any).generator) fnCompiler.isGenerator = true;
        if ((expr as any).async) fnCompiler.isAsync = true;
        fnCompiler.compileFunctionBody(expr.params, expr.body.body);
        const fnBytecode = fnCompiler.finish(expr.id?.name ?? inferredName ?? "");
        const fnIndex = this.addConstant(fnBytecode);
        this.emit("LdaConst", fnIndex);
        break;
      }

      case "ClassExpression": {
        // ClassDeclaration と同じコンパイルだが、変数登録せずスタックに残す
        const fakeStmt = { ...expr, type: "ClassDeclaration", id: expr.id ?? { type: "Identifier", name: inferredName ?? "" } } as any;
        // ClassDeclaration のコンパイルは StaGlobal+Pop で終わるので、
        // ここでは ClassDeclaration の中身を再実装して Pop しない
        const instanceFields = fakeStmt.body.body.filter((m: any) => m.type === "PropertyDefinition" && !m.static);
        const ctorMethod = fakeStmt.body.body.find((m: any) => m.type === "MethodDefinition" && m.kind === "constructor");
        const fnCompiler = new BytecodeCompiler(this);
        if (ctorMethod) {
          fnCompiler.compileFunctionBody(ctorMethod.value.params, ctorMethod.value.body.body);
        } else {
          fnCompiler.compileFunctionBody([], []);
        }
        const ctorFunc = fnCompiler.finish(fakeStmt.id.name);
        (ctorFunc as any).prototype = {};
        if (instanceFields.length > 0) (ctorFunc as any).__instanceFields = instanceFields;
        this.emit("LdaConst", this.addConstant(ctorFunc));
        // methods
        for (const member of fakeStmt.body.body) {
          if (member.type === "PropertyDefinition") continue;
          if (member.kind === "constructor") continue;
          const name = member.computed ? null : (member.key.type === "Literal" ? String(member.key.value) : member.key.name);
          if (member.kind === "method") {
            this.emit("Dup");
            if (!member.static) this.emitWithIC("GetProperty", this.addConstant("prototype"));
            if (member.computed) {
              this.compileExpression(member.key);
              const mc = new BytecodeCompiler(this);
              if ((member.value as any).generator) mc.isGenerator = true;
              mc.compileFunctionBody(member.value.params, member.value.body.body);
              this.emit("LdaConst", this.addConstant(mc.finish("<computed>")));
              this.emit("SetPropertyComputed");
            } else {
              const mc = new BytecodeCompiler(this);
              if ((member.value as any).generator) mc.isGenerator = true;
              mc.compileFunctionBody(member.value.params, member.value.body.body);
              this.emit("LdaConst", this.addConstant(mc.finish(name!)));
              this.emitWithIC("SetProperty", this.addConstant(name!));
            }
            this.emit("Pop");
          }
        }
        break;
      }

      case "AssignmentExpression": {
        if (expr.left.type === "MemberExpression") {
          this.compileMemberAssignment(expr);
          break;
        }
        if (expr.operator !== "=" && expr.left.type === "Identifier") {
          // 複合代入: x += y → x = x + y
          this.emitLoad(expr.left.name);
          this.compileExpression(expr.right);
          const compoundOps: Record<string, Opcode> = {
            "+=": "Add", "-=": "Sub", "*=": "Mul", "/=": "Div", "%=": "Mod",
          };
          this.emit(compoundOps[expr.operator]);
          this.emitStore(expr.left.name);
          break;
        }
        this.compileExpression(expr.right);
        if (expr.left.type === "Identifier") {
          this.emitStore(expr.left.name);
        } else if (expr.left.type === "ObjectPattern" || expr.left.type === "ArrayPattern") {
          // 分割代入: ({a, b} = obj) or [x, y] = arr
          // compileBindingTarget は値を Pop するので、先に Dup して値を残す
          this.emit("Dup");
          this.compileBindingTarget(expr.left);
        } else {
          throw new Error(`Unsupported assignment target: ${expr.left.type}`);
        }
        break;
      }

      case "MemberExpression": {
        this.compileExpression(expr.object);
        // optional chaining: obj?.prop → null/undefined なら undefined を返す
        let optionalJump = -1;
        if ((expr as any).optional) {
          this.emit("Dup");
          this.emit("IsNullish");
          optionalJump = this.emit("JumpIfTrue", 0);
        }
        if (!expr.computed && (expr.property.type === "Identifier" || expr.property.type === "PrivateIdentifier")) {
          const nameIdx = this.addConstant(expr.property.name);
          this.emitWithIC("GetProperty", nameIdx);
        } else {
          this.compileExpression(expr.property);
          this.emit("GetPropertyComputed");
        }
        if (optionalJump >= 0) {
          const skipUndefined = this.emit("Jump", 0);
          this.patch(optionalJump, this.currentOffset());
          this.emit("Pop"); // obj を捨てる
          this.emit("LdaUndefined");
          this.patch(skipUndefined, this.currentOffset());
        }
        break;
      }

      case "ObjectExpression": {
        this.emit("CreateObject");
        for (const prop of expr.properties) {
          if (prop.type === "SpreadElement") {
            // TODO: spread
            continue;
          }
          // stack: [obj] → Dup → [obj, obj] → value → [obj, obj, value]
          // SetProperty: pop value, peek obj → [obj, obj]
          // Pop: → [obj]  (次のプロパティ or 最終結果として obj を残す)
          this.emit("Dup");
          if (prop.computed) {
            // computed: { [expr]: value } → SetPropertyComputed
            this.compileExpression(prop.key);
            this.compileExpression(prop.value);
            this.emit("SetPropertyComputed");
          } else {
            const key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value);
            if (this.isNameableFunctionExpr(prop.value)) {
              this.compileExpression(prop.value, key);
            } else {
              this.compileExpression(prop.value);
            }
            const nameIdx = this.addConstant(key);
            if (prop.kind === "get") {
              this.emit("DefineGetter", nameIdx);
            } else if (prop.kind === "set") {
              this.emit("DefineSetter", nameIdx);
            } else {
              this.emitWithIC("SetProperty", nameIdx);
            }
          }
          this.emit("Pop");
        }
        break;
      }

      case "ArrayExpression": {
        const hasSpread = expr.elements.some((el: any) => el.type === "SpreadElement");
        if (hasSpread) {
          // SpreadElement がある場合: 空配列を作って push/spread
          this.emit("CreateArray", 0);
          for (const el of expr.elements) {
            if ((el as any).type === "SpreadElement") {
              this.compileExpression((el as any).argument);
              this.emit("ArraySpread");
            } else {
              this.compileExpression(el);
              this.emit("ArrayPush");
            }
          }
        } else {
          for (const el of expr.elements) {
            this.compileExpression(el);
          }
          this.emit("CreateArray", expr.elements.length);
        }
        break;
      }

      case "CallExpression": {
        if (expr.callee.type === "MemberExpression") {
          // メソッド呼び出し: obj.method(args)
          // 引数を push
          for (const arg of expr.arguments) {
            this.compileExpression(arg as Expression);
          }
          // obj を push
          this.compileExpression(expr.callee.object);
          // メソッドを push
          this.emit("Dup"); // obj を複製 (this 用に残す)
          if (expr.callee.computed) {
            this.compileExpression(expr.callee.property);
            this.emit("GetPropertyComputed");
          } else if (expr.callee.property.type === "Identifier") {
            const nameIdx = this.addConstant(expr.callee.property.name);
            this.emitWithIC("GetProperty", nameIdx);
          }
          this.emit("CallMethod", expr.arguments.length);
        } else {
          // 通常の関数呼び出し。JS 仕様では callee の参照解決が引数評価より
          // 先なので、callee がグローバル参照なら存在チェックを引数の前に置く
          // (f(garbage()) は f 未定義なら引数内の例外より ReferenceError が先)。
          // スタック順 [args..., callee] は変えない (JIT の LdaGlobal+Call
          // パターン検出を保つため)
          if (expr.callee.type === "Identifier" && this.resolvesToGlobal(expr.callee.name)) {
            this.emit("CheckGlobal", this.addConstant(expr.callee.name));
          }
          for (const arg of expr.arguments) {
            this.compileExpression(arg as Expression);
          }
          this.compileExpression(expr.callee);
          this.emit("Call", expr.arguments.length);
        }
        break;
      }

      case "BinaryExpression": {
        this.compileExpression(expr.left);
        this.compileExpression(expr.right);
        const opMap: Record<string, Opcode> = {
          "+": "Add", "-": "Sub", "*": "Mul", "/": "Div", "%": "Mod", "**": "Exp",
          "&": "BitAnd", "|": "BitOr", "^": "BitXor",
          "<<": "ShiftLeft", ">>": "ShiftRight", ">>>": "UShiftRight",
          "==": "Equal", "===": "StrictEqual",
          "!=": "NotEqual", "!==": "StrictNotEqual",
          "<": "LessThan", ">": "GreaterThan",
          "<=": "LessEqual", ">=": "GreaterEqual",
          "in": "In", "instanceof": "Instanceof",
        };
        const op = opMap[expr.operator];
        if (!op) throw new Error(`Unsupported binary operator: ${expr.operator}`);
        this.emit(op);
        break;
      }

      case "LogicalExpression": {
        this.compileExpression(expr.left);
        if (expr.operator === "&&") {
          this.emit("Dup");
          const skipRight = this.emit("JumpIfFalse", 0);
          this.emit("Pop");
          this.compileExpression(expr.right);
          this.patch(skipRight, this.currentOffset());
        } else if (expr.operator === "||") {
          this.emit("Dup");
          const skipRight = this.emit("JumpIfTrue", 0);
          this.emit("Pop");
          this.compileExpression(expr.right);
          this.patch(skipRight, this.currentOffset());
        } else if (expr.operator === "??") {
          // null/undefined でないなら左を返す
          this.emit("Dup");
          this.emit("IsNullish");
          const useRight = this.emit("JumpIfTrue", 0);
          const skipRight = this.emit("Jump", 0);
          this.patch(useRight, this.currentOffset());
          this.emit("Pop"); // left を捨てる
          this.compileExpression(expr.right);
          this.patch(skipRight, this.currentOffset());
        }
        break;
      }

      case "ConditionalExpression": {
        // test ? consequent : alternate
        this.compileExpression(expr.test);
        const jumpToAlternate = this.emit("JumpIfFalse", 0);
        this.compileExpression(expr.consequent);
        const jumpToEnd = this.emit("Jump", 0);
        this.patch(jumpToAlternate, this.currentOffset());
        this.compileExpression(expr.alternate);
        this.patch(jumpToEnd, this.currentOffset());
        break;
      }

      case "ArrowFunctionExpression": {
        const fnCompiler = new BytecodeCompiler(this);
        if ((expr as any).async) fnCompiler.isAsync = true;
        if (expr.expression) {
          // 式本体: 暗黙の return
          fnCompiler.compileFunctionBody(expr.params, [
            { type: "ReturnStatement", argument: expr.body as Expression }
          ], true);
        } else {
          fnCompiler.compileFunctionBody(expr.params, (expr.body as any).body, true);
        }
        const fnBytecode = fnCompiler.finish(inferredName ?? "");
        const fnIndex = this.addConstant(fnBytecode);
        this.emit("LdaConst", fnIndex);
        break;
      }

      case "AwaitExpression": {
        this.compileExpression((expr as any).argument);
        this.emit("Await");
        break;
      }

      case "YieldExpression": {
        if ((expr as any).argument) {
          this.compileExpression((expr as any).argument);
        } else {
          this.emit("LdaUndefined");
        }
        this.emit("Yield");
        break;
      }

      case "TemplateLiteral": {
        // quasis と expressions を交互に結合
        // 最初の quasi を push
        const firstQuasi = this.addConstant(expr.quasis[0].value.cooked);
        this.emit("LdaConst", firstQuasi);
        for (let i = 0; i < expr.expressions.length; i++) {
          this.compileExpression(expr.expressions[i]);
          this.emit("Add"); // 文字列連結
          if (i + 1 < expr.quasis.length) {
            const quasi = this.addConstant(expr.quasis[i + 1].value.cooked);
            this.emit("LdaConst", quasi);
            this.emit("Add");
          }
        }
        break;
      }

      case "TaggedTemplateExpression": {
        // Tagged template: tag(strings, ...values)
        const quasi = (expr as any).quasi;
        // 式の値を先に push (引数)
        for (const e of quasi.expressions) {
          this.compileExpression(e);
        }
        // strings 配列: cooked 値
        for (const q of quasi.quasis) {
          this.emit("LdaConst", this.addConstant(q.value.cooked));
        }
        this.emit("CreateArray", quasi.quasis.length);
        // raw 配列
        for (const q of quasi.quasis) {
          this.emit("LdaConst", this.addConstant(q.value.raw));
        }
        this.emit("CreateArray", quasi.quasis.length);
        // stack: ...values, strings, raw
        // strings.raw = raw → SetProperty
        const rawTmp = `__ttl_raw_${this.currentOffset()}`;
        const rawIdx = this.addConstant(rawTmp);
        this.emit("StaGlobal", rawIdx); // save raw
        this.emit("Pop"); // pop raw
        // stack: ...values, strings
        this.emit("Dup"); // strings, strings
        this.emit("LdaGlobal", rawIdx); // strings, strings, raw
        this.emitWithIC("SetProperty", this.addConstant("raw")); // strings.raw = raw
        this.emit("Pop"); // strings
        // Now: stack = ...values, strings
        // Need: strings, ...values, tag, tag  (for Call)
        // This is complex with stack. Use temp globals.
        const strTmp = `__ttl_str_${this.currentOffset()}`;
        const strIdx = this.addConstant(strTmp);
        this.emit("StaGlobal", strIdx); // save strings
        this.emit("Pop"); // pop strings
        // stack: ...values
        // Push strings as first arg, then values are already on stack
        // Actually Call expects: arg0, arg1, ..., callee
        // We need: strings, val0, val1, ..., callee → Call(N+1)
        // But values are already on stack below. Reorder needed.
        // Simplest: save all values to temps, then push in order
        const valTemps: string[] = [];
        for (let i = quasi.expressions.length - 1; i >= 0; i--) {
          const vt = `__ttl_val${i}_${this.currentOffset()}`;
          valTemps.unshift(vt);
          this.emit("StaGlobal", this.addConstant(vt));
          this.emit("Pop");
        }
        // stack empty. Push in order: strings, val0, val1, ...
        this.emit("LdaGlobal", strIdx);
        for (const vt of valTemps) {
          this.emit("LdaGlobal", this.addConstant(vt));
        }
        // Push tag and call
        this.compileExpression((expr as any).tag);
        this.emit("Call", 1 + quasi.expressions.length);
        break;
      }

      case "UpdateExpression": {
        // ++x, x++, --x, x--
        if (expr.argument.type === "Identifier") {
          this.emitLoad(expr.argument.name);
          if (expr.prefix) {
            // ++x / --x: 新しい値を計算してストア。StaLocal/StaUpvalue/StaGlobal は
            // peek ベース (スタックを pop しない) なので、ストア後もスタック頂点に
            // 新しい値が残る = 式の結果。Dup は不要 (入れると 2 値残ってリークする)。
            this.emit(expr.operator === "++" ? "Increment" : "Decrement");
            this.emitStore(expr.argument.name);
          } else {
            this.emit("Dup"); // 古い値を残す
            this.emit(expr.operator === "++" ? "Increment" : "Decrement");
            this.emitStore(expr.argument.name);
            this.emit("Pop"); // 新しい値を捨て、古い値を返す
          }
        } else if (expr.argument.type === "MemberExpression") {
          // ++obj.prop / obj.prop++ / ++obj[k] / obj[k]++。
          // obj/key を 2 回 (読み+書き) 使うので temp に退避する。
          // 関数内なら local slot、トップレベルなら global (for-in と同じパターン)。
          // ※ 以前は Identifier 以外で何も emit せず、ExpressionStatement の
          //    Pop が別の値を壊していた (deltablue の ++this.currentMark、
          //    richards の this.count++ 等が全滅していた)
          const member = expr.argument as any;
          const useLocal = this.isFunction;
          const off = this.currentOffset();
          const mkTmp = (tag: string) => useLocal
            ? { slot: this.localCount++, g: 0 }
            : { slot: 0, g: this.addConstant(`__upd_${tag}_${off}`) };
          const sta = (t: { slot: number; g: number }) => useLocal ? this.emit("StaLocal", t.slot) : this.emit("StaGlobal", t.g);
          const lda = (t: { slot: number; g: number }) => useLocal ? this.emit("LdaLocal", t.slot) : this.emit("LdaGlobal", t.g);
          const objT = mkTmp("obj");
          const keyT = member.computed ? mkTmp("key") : null;
          const valT = mkTmp("val");
          const oldT = expr.prefix ? null : mkTmp("old");
          // obj (と computed key) を退避
          this.compileExpression(member.object);
          sta(objT); this.emit("Pop");
          if (keyT) { this.compileExpression(member.property); sta(keyT); this.emit("Pop"); }
          // 現在値を読む
          lda(objT);
          if (keyT) { lda(keyT); this.emit("GetPropertyComputed"); }
          else {
            const nameIdx = this.addConstant(member.property.name ?? String(member.property.value));
            this.emitWithIC("GetProperty", nameIdx);
          }
          // stack: [old]
          if (oldT) sta(oldT); // postfix: 古い値を退避 (Sta は peek なのでスタック不変)
          this.emit(expr.operator === "++" ? "Increment" : "Decrement");
          // stack: [new]
          sta(valT); this.emit("Pop");
          // 書き戻し (SetPropertyAssign: [value, obj] / SetPropertyComputed: [obj, key, value])
          if (keyT) { lda(objT); lda(keyT); lda(valT); this.emit("SetPropertyComputed"); }
          else {
            const nameIdx = this.addConstant(member.property.name ?? String(member.property.value));
            lda(valT); lda(objT); this.emitWithIC("SetPropertyAssign", nameIdx);
          }
          // stack: [new]
          if (oldT) { this.emit("Pop"); lda(oldT); } // postfix は古い値を返す
        } else {
          // その他 (来ないはずだが、スタック整合のため undefined を積む)
          this.emit("LdaUndefined");
        }
        break;
      }

      case "UnaryExpression": {
        if (expr.operator === "void") {
          this.compileExpression(expr.argument);
          this.emit("Pop");
          this.emit("LdaUndefined");
          break;
        }
        if (expr.operator === "delete") {
          if (expr.argument.type === "MemberExpression") {
            this.compileExpression(expr.argument.object);
            if (expr.argument.computed) {
              this.compileExpression(expr.argument.property);
              this.emit("DeletePropertyComputed");
            } else {
              const name = expr.argument.property.type === "Identifier"
                ? expr.argument.property.name : String((expr.argument.property as any).value);
              this.emit("DeleteProperty", this.addConstant(name));
            }
          } else {
            // delete on non-member always returns true
            this.compileExpression(expr.argument);
            this.emit("Pop");
            this.emit("LdaConst", this.addConstant(true));
          }
          break;
        }
        if (expr.operator === "typeof" && expr.argument.type === "Identifier") {
          // typeof 未定義変数は ReferenceError にせず "undefined" を返す
          const name = expr.argument.name;
          const local = this.resolveLocal(name);
          if (local !== null) {
            this.emit("LdaLocal", local);
            this.emit("TypeOf");
          } else {
            const upvalue = this.resolveUpvalue(name);
            if (upvalue >= 0) {
              this.emit("LdaUpvalue", upvalue);
              this.emit("TypeOf");
            } else {
              // グローバル: TypeOfGlobal で安全にアクセス
              this.emit("TypeOfGlobal", this.addConstant(name));
            }
          }
        } else {
          this.compileExpression(expr.argument);
          if (expr.operator === "-") {
            this.emit("Negate");
          } else if (expr.operator === "~") {
            this.emit("BitNot");
          } else if (expr.operator === "!") {
            this.emit("LogicalNot");
          } else if (expr.operator === "typeof") {
            this.emit("TypeOf");
          } else {
            throw new Error(`Unsupported unary operator: ${expr.operator}`);
          }
        }
        break;
      }

      case "SequenceExpression": {
        // カンマ演算子: 各式を評価して最後の値を返す
        for (let i = 0; i < expr.expressions.length; i++) {
          this.compileExpression(expr.expressions[i]);
          if (i < expr.expressions.length - 1) {
            this.emit("Pop"); // 最後以外は捨てる
          }
        }
        break;
      }

      default: {
        // 未対応の式は AST を定数テーブルに入れて VM 側で tree-walking 実行
        const exprIndex = this.addConstant(expr);
        this.emit("ExecExpr", exprIndex);
        break;
      }
    }
  }
}
