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

  // ローカル変数のスロットを確保
  declareLocal(name: string): number {
    if (this.locals.has(name)) return this.locals.get(name)!;
    const slot = this.localCount++;
    this.locals.set(name, slot);
    return slot;
  }

  resolveLocal(name: string): number | null {
    return this.locals.get(name) ?? null;
  }

  // 親コンパイラのローカルを再帰的に探索して upvalue index を返す (-1 = 見つからない)
  private resolveUpvalue(name: string): number {
    if (!this.parent) return -1;
    // 親のローカルにあるか
    const parentSlot = this.parent.resolveLocal(name);
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

  // 変数のロード: ローカル → upvalue → グローバル の優先順で解決
  emitLoad(name: string): void {
    const slot = this.resolveLocal(name);
    if (slot !== null) {
      this.emit("LdaLocal", slot);
      return;
    }
    if (this.isFunction) {
      const upIdx = this.resolveUpvalue(name);
      if (upIdx >= 0) {
        this.emit("LdaUpvalue", upIdx);
        return;
      }
    }
    const nameIdx = this.addConstant(name);
    this.emit("LdaGlobal", nameIdx);
  }

  // 変数のストア
  emitStore(name: string): void {
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
    const nameIdx = this.addConstant(name);
    this.emit("StaGlobal", nameIdx);
  }

  finish(name: string): BytecodeFunction {
    return {
      name,
      paramCount: this.paramCount,
      localCount: this.localCount,
      hasRestParam: this.hasRestParam,
      bytecode: this.bytecode,
      constants: this.constants,
      handlers: this.handlers,
      icSlotCount: this.icSlotCount,
      upvalues: this.upvalues,
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
      // stack: arr → 各要素を取り出す
      for (let i = 0; i < id.elements.length; i++) {
        const el = id.elements[i];
        if (!el) continue;
        if (el.type === "RestElement") {
          // [...rest]: arr.slice(i)
          // stack: [arr(orig)]
          // CallMethod(1) needs: [i, arr, slice]
          this.emit("LdaConst", this.addConstant(i));  // arr, i
          this.emit("Dup");                             // arr, i, i  (dummy, need arr)
          this.emit("Pop");                             // arr, i
          // arr is below i — we need arr on top to get slice
          // Use temp global to save arr
          const tmpName = `__rest_arr_${this.currentOffset()}`;
          const tmpIdx = this.addConstant(tmpName);
          this.emit("Pop");                             // arr (removed i)
          this.emit("Dup");                             // arr, arr
          this.emit("StaGlobal", tmpIdx);               // arr, arr (saved to global)
          this.emit("Pop");                             // arr
          // Now build CallMethod stack: i, arr, slice
          this.emit("LdaConst", this.addConstant(i));   // arr, i
          this.emit("LdaGlobal", tmpIdx);               // arr, i, arr
          this.emit("Dup");                             // arr, i, arr, arr
          this.emitWithIC("GetProperty", this.addConstant("slice")); // arr, i, arr, slice
          this.emit("CallMethod", 1);                   // arr, result
          this.compileBindingTarget(el.argument);        // arr (result consumed)
          break;
        }
        this.emit("Dup"); // arr を残す
        this.emit("LdaConst", this.addConstant(i));
        this.emit("GetPropertyComputed");
        this.compileBindingTarget(el);
      }
      this.emit("Pop"); // arr を捨てる
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
    // function hoisting: 関数宣言を先にコンパイルしてグローバルに登録
    for (const stmt of program.body) {
      if (stmt.type === "FunctionDeclaration") {
        this.compileStatement(stmt);
      }
    }
    // var hoisting: var 宣言を事前に undefined でグローバルに登録
    for (const stmt of program.body) {
      if (stmt.type === "VariableDeclaration" && (stmt as any).kind === "var") {
        for (const decl of (stmt as any).declarations) {
          if (decl.id.type === "Identifier") {
            this.emit("LdaUndefined");
            this.emit("StaGlobal", this.addConstant(decl.id.name));
            this.emit("Pop");
          }
        }
      }
    }
    for (let i = 0; i < program.body.length; i++) {
      const stmt = program.body[i];
      const isLast = i === program.body.length - 1;
      this.compileStatement(stmt);
      // 最後の式文の値をスタックに残す (プログラムの戻り値)
      if (stmt.type === "ExpressionStatement" && isLast) {
        // compileStatement が Pop を emit したので、最後だけ取り消す
        this.bytecode.pop(); // Pop を除去
      }
    }
  }

  compileFunctionBody(params: any[], body: Statement[]): void {
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
    // 本体をコンパイル
    for (const stmt of body) {
      this.compileStatement(stmt);
    }
    // 明示的 return がない場合は undefined を返す
    this.emit("LdaUndefined");
    this.emit("Return");
  }

  compileStatement(stmt: Statement): void {
    switch (stmt.type) {
      case "ExpressionStatement":
        this.compileExpression(stmt.expression);
        this.emit("Pop");
        break;

      case "VariableDeclaration": {
        // let/const はトップレベルでもローカルスロットを使う (ブロックスコープ)
        if (!this.isFunction && stmt.kind !== "var") {
          for (const decl of stmt.declarations) {
            this.preDeclareBindingNames(decl.id);
          }
        }
        for (const decl of stmt.declarations) {
          if (decl.init) {
            this.compileExpression(decl.init);
          } else {
            this.emit("LdaUndefined");
          }
          this.compileBindingTarget(decl.id);
        }
        break;
      }

      case "FunctionDeclaration": {
        const fnCompiler = new BytecodeCompiler(this);
        fnCompiler.compileFunctionBody(stmt.params, stmt.body.body);
        const fnBytecode = fnCompiler.finish(stmt.id.name);
        const fnIndex = this.addConstant(fnBytecode);
        this.emit("LdaConst", fnIndex);
        const fnSlot = this.resolveLocal(stmt.id.name) ?? this.declareLocal(stmt.id.name);
        this.emit("StaLocal", fnSlot);
        // トップレベル関数はグローバルにも登録 (再帰呼び出し + JIT 用)
        if (!this.isFunction) {
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

        // Phase 2: body (fall-through で連続配置)
        const bodyOffsets: number[] = [];
        for (let i = 0; i < stmt.cases.length; i++) {
          bodyOffsets.push(this.currentOffset());
          for (const s of stmt.cases[i].consequent) {
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
        // for (let/const ...) のブロックスコープ
        const forHasBlockScoped = stmt.init?.type === "VariableDeclaration" && stmt.init.kind !== "var";
        if (forHasBlockScoped) {
          this.scopeStack.push(new Map(this.locals));
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
        }
        break;
      }

      case "BlockStatement": {
        const hasBlockScoped = stmt.body.some(
          (s: any) => s.type === "VariableDeclaration" && s.kind !== "var"
        );
        if (hasBlockScoped) {
          // スコープを push — 同名変数は新しいスロットに割り当てられる
          this.scopeStack.push(new Map(this.locals));
          // ブロック内の let/const 変数を強制的に新スロットに割り当て
          for (const s of stmt.body) {
            if ((s as any).type === "VariableDeclaration" && (s as any).kind !== "var") {
              for (const decl of (s as any).declarations) {
                if (decl.id.type === "Identifier") {
                  // 既存のマッピングを削除して新スロットを強制
                  this.locals.delete(decl.id.name);
                }
              }
            }
          }
        }
        for (const s of stmt.body) {
          this.compileStatement(s);
        }
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
              fnCompiler.compileFunctionBody(member.value.params, member.value.body.body);
              this.emit("LdaConst", this.addConstant(fnCompiler.finish("<computed>")));
              this.emit("SetPropertyComputed");
            } else {
              const fnCompiler = new BytecodeCompiler(this);
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
        // for (var k in obj) — Object.keys(obj) をイテレート
        // Object.keys を呼んで配列を取得し、for-of と同じパターンでループ
        this.compileExpression(stmt.right);
        // Object.keys(obj) を呼ぶ: LdaGlobal "Object" → GetProperty "keys" → Call
        // 簡易: Object.keys は globals に登録されてるので LdaGlobal + GetProperty + Call
        // もっと簡易: ForIn 専用オペコードを使う代わりに、
        // obj をスタックに残して ForIn opcode で keys 配列に変換
        // → 既存の仕組みで: obj を temp に保存、keys を取得、for-of ループ
        const objName = `__forin_obj_${this.currentOffset()}`;
        const objIdx = this.addConstant(objName);
        this.emit("StaGlobal", objIdx);
        this.emit("Pop");
        // Object.keys(obj) を呼ぶ
        this.emit("LdaGlobal", objIdx);
        this.emit("LdaGlobal", this.addConstant("Object"));
        this.emitWithIC("GetProperty", this.addConstant("keys"));
        // CallMethod: this=Object, arg=obj
        // → 実際は Call で Object.keys(obj)
        // スタック: [obj, keys_fn] → Call 1 → keys_fn(obj)
        this.emit("Call", 1);
        // 結果は keys 配列。for-of と同じパターン
        const keysName = `__forin_keys_${this.currentOffset()}`;
        const keysIdx = this.addConstant(keysName);
        this.emit("StaGlobal", keysIdx);
        this.emit("Pop");
        const counterName = `__forin_idx_${this.currentOffset()}`;
        const counterIdx = this.addConstant(counterName);
        this.emit("LdaConst", this.addConstant(0));
        this.emit("StaGlobal", counterIdx);
        this.emit("Pop");
        const loopStart = this.currentOffset();
        this.emit("LdaGlobal", counterIdx);
        this.emit("LdaGlobal", keysIdx);
        this.emitWithIC("GetProperty", this.addConstant("length"));
        this.emit("LessThan");
        const exitJump = this.emit("JumpIfFalse", 0);
        // k = keys[i]
        this.emit("LdaGlobal", keysIdx);
        this.emit("LdaGlobal", counterIdx);
        this.emit("GetPropertyComputed");
        this.compileBindingTarget(stmt.left.declarations[0].id);
        // body
        this.compileStatement(stmt.body);
        // i++
        this.emit("LdaGlobal", counterIdx);
        this.emit("LdaConst", this.addConstant(1));
        this.emit("Add");
        this.emit("StaGlobal", counterIdx);
        this.emit("Pop");
        this.emit("Jump", loopStart);
        this.patch(exitJump, this.currentOffset());
        break;
      }

      case "ForOfStatement": {
        // 配列を取得して GetIterator 的な処理
        // 簡易: 配列の各要素をループ
        this.compileExpression(stmt.right);
        // イテラブルをグローバルの一時変数に格納
        const iterName = `__iter_${this.currentOffset()}`;
        const iterIdx = this.addConstant(iterName);
        this.emit("StaGlobal", iterIdx);
        this.emit("Pop");
        // カウンタ
        const counterName = `__idx_${this.currentOffset()}`;
        const counterIdx = this.addConstant(counterName);
        const zeroIdx = this.addConstant(0);
        this.emit("LdaConst", zeroIdx);
        this.emit("StaGlobal", counterIdx);
        this.emit("Pop");
        // ループ
        const loopStart = this.currentOffset();
        // i < arr.length
        this.emit("LdaGlobal", counterIdx);
        this.emit("LdaGlobal", iterIdx);
        this.emitWithIC("GetProperty", this.addConstant("length"));
        this.emit("LessThan");
        const exitJump = this.emit("JumpIfFalse", 0);
        // var/let x = arr[i]
        this.emit("LdaGlobal", iterIdx);
        this.emit("LdaGlobal", counterIdx);
        this.emit("GetPropertyComputed");
        this.compileBindingTarget(stmt.left.declarations[0].id);
        // body
        this.compileStatement(stmt.body);
        // i++
        this.emit("LdaGlobal", counterIdx);
        this.emit("LdaConst", this.addConstant(1));
        this.emit("Add");
        this.emit("StaGlobal", counterIdx);
        this.emit("Pop");
        this.emit("Jump", loopStart);
        this.patch(exitJump, this.currentOffset());
        break;
      }

      default:
        throw new Error(`Unsupported statement: ${stmt.type}`);
    }
  }

  compileExpression(expr: Expression): void {
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
        fnCompiler.compileFunctionBody(expr.params, expr.body.body);
        const fnBytecode = fnCompiler.finish(expr.id?.name ?? "<anonymous>");
        const fnIndex = this.addConstant(fnBytecode);
        this.emit("LdaConst", fnIndex);
        break;
      }

      case "ClassExpression": {
        // ClassDeclaration と同じコンパイルだが、変数登録せずスタックに残す
        const fakeStmt = { ...expr, type: "ClassDeclaration", id: expr.id ?? { type: "Identifier", name: "__anonymous__" } } as any;
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
              mc.compileFunctionBody(member.value.params, member.value.body.body);
              this.emit("LdaConst", this.addConstant(mc.finish("<computed>")));
              this.emit("SetPropertyComputed");
            } else {
              const mc = new BytecodeCompiler(this);
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
          if (expr.left.computed) {
            // computed: obj[key] = value → SetPropertyComputed (pop value, pop key, pop obj)
            this.compileExpression(expr.left.object);
            this.compileExpression(expr.left.property);
            this.compileExpression(expr.right);
            this.emit("SetPropertyComputed");
          } else {
            // non-computed: obj.prop = value → SetPropertyAssign
            this.compileExpression(expr.right);
            this.compileExpression(expr.left.object);
            const nameIdx = this.addConstant((expr.left.property as any).name);
            this.emitWithIC("SetPropertyAssign", nameIdx);
          }
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
            this.compileExpression(prop.value);
            const key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value);
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
          // 通常の関数呼び出し
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
        if (expr.expression) {
          // 式本体: 暗黙の return
          fnCompiler.compileFunctionBody(expr.params, [
            { type: "ReturnStatement", argument: expr.body as Expression }
          ]);
        } else {
          fnCompiler.compileFunctionBody(expr.params, (expr.body as any).body);
        }
        const fnBytecode = fnCompiler.finish("<arrow>");
        const fnIndex = this.addConstant(fnBytecode);
        this.emit("LdaConst", fnIndex);
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

      case "UpdateExpression": {
        // ++x, x++, --x, x--
        if (expr.argument.type === "Identifier") {
          this.emitLoad(expr.argument.name);
          if (expr.prefix) {
            this.emit(expr.operator === "++" ? "Increment" : "Decrement");
            this.emit("Dup");
            this.emitStore(expr.argument.name);
          } else {
            this.emit("Dup"); // 古い値を残す
            this.emit(expr.operator === "++" ? "Increment" : "Decrement");
            this.emitStore(expr.argument.name);
            this.emit("Pop"); // 新しい値を捨て、古い値を返す
          }
        }
        break;
      }

      case "UnaryExpression": {
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
