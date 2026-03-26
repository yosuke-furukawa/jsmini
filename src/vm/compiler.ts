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
  private loopStack: { breakPatches: number[]; continueTarget: number }[] = [];

  constructor(parent: BytecodeCompiler | null) {
    this.parent = parent;
    this.isFunction = parent !== null;
  }

  emit(op: Opcode, operand?: number): number {
    const index = this.bytecode.length;
    this.bytecode.push({ op, operand });
    return index;
  }

  patch(index: number, operand: number): void {
    this.bytecode[index].operand = operand;
  }

  currentOffset(): number {
    return this.bytecode.length;
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

  // 変数のロード: 関数内ならローカル、トップレベルならグローバル
  emitLoad(name: string): void {
    if (this.isFunction) {
      const slot = this.resolveLocal(name);
      if (slot !== null) {
        this.emit("LdaLocal", slot);
        return;
      }
    }
    // グローバル
    const nameIdx = this.addConstant(name);
    this.emit("LdaGlobal", nameIdx);
  }

  // 変数のストア
  emitStore(name: string): void {
    if (this.isFunction) {
      const slot = this.resolveLocal(name);
      if (slot !== null) {
        this.emit("StaLocal", slot);
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
      bytecode: this.bytecode,
      constants: this.constants,
      handlers: this.handlers,
    };
  }

  // 変数バインディング: スタックトップの値を変数に格納して Pop
  compileBindingTarget(id: any): void {
    if (id.type === "Identifier") {
      if (this.isFunction) {
        const slot = this.resolveLocal(id.name) ?? this.declareLocal(id.name);
        this.emit("StaLocal", slot);
      } else {
        const nameIdx = this.addConstant(id.name);
        this.emit("StaGlobal", nameIdx);
      }
      this.emit("Pop");
    } else if (id.type === "ObjectPattern") {
      // stack: obj → 各プロパティを取り出す
      for (const prop of id.properties) {
        this.emit("Dup"); // obj を残す
        const nameIdx = this.addConstant(prop.key.name);
        this.emit("GetProperty", nameIdx);
        this.compileBindingTarget(prop.value);
      }
      this.emit("Pop"); // obj を捨てる
    } else if (id.type === "ArrayPattern") {
      // stack: arr → 各要素を取り出す
      for (let i = 0; i < id.elements.length; i++) {
        if (id.elements[i]) {
          this.emit("Dup"); // arr を残す
          this.emit("LdaConst", this.addConstant(i));
          this.emit("GetPropertyComputed");
          this.compileBindingTarget(id.elements[i]);
        }
      }
      this.emit("Pop"); // arr を捨てる
    }
  }

  compileProgram(program: Program): void {
    for (let i = 0; i < program.body.length; i++) {
      const stmt = program.body[i];
      const isLast = i === program.body.length - 1;
      this.compileStatement(stmt);
      if (stmt.type === "ExpressionStatement" && !isLast) {
        this.emit("Pop");
      }
    }
  }

  compileFunctionBody(params: any[], body: Statement[]): void {
    // パラメータをローカルスロットに登録
    this.paramCount = params.length;
    for (const param of params) {
      if (param.type === "Identifier") {
        this.declareLocal(param.name);
      }
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
        break;

      case "VariableDeclaration": {
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

      case "WhileStatement": {
        const loopStart = this.currentOffset();
        this.loopStack.push({ breakPatches: [], continueTarget: loopStart });
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
        this.loopStack.push({ breakPatches: [], continueTarget: -1 }); // 後でパッチ
        let exitJump = -1;
        if (stmt.test) {
          this.compileExpression(stmt.test);
          exitJump = this.emit("JumpIfFalse", 0);
        }
        this.compileStatement(stmt.body);
        // continue はここにジャンプ
        const continueTarget = this.currentOffset();
        this.loopStack[this.loopStack.length - 1].continueTarget = continueTarget;
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
        break;
      }

      case "BlockStatement": {
        const hasBlockScoped = this.isFunction && stmt.body.some(
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
        // constructor を BytecodeFunction にコンパイル
        const ctorMethod = stmt.body.body.find((m: any) => m.kind === "constructor");
        if (ctorMethod) {
          const fnCompiler = new BytecodeCompiler(this);
          fnCompiler.compileFunctionBody(ctorMethod.value.params, ctorMethod.value.body.body);
          const ctorFunc = fnCompiler.finish(stmt.id.name);
          // prototype を事前に付与
          (ctorFunc as any).prototype = {};
          const ctorIdx = this.addConstant(ctorFunc);
          this.emit("LdaConst", ctorIdx);
        } else {
          const fnCompiler = new BytecodeCompiler(this);
          fnCompiler.compileFunctionBody([], []);
          const ctorFunc = fnCompiler.finish(stmt.id.name);
          (ctorFunc as any).prototype = {};
          const ctorIdx = this.addConstant(ctorFunc);
          this.emit("LdaConst", ctorIdx);
        }
        // メソッドを prototype に設定
        for (const method of stmt.body.body) {
          if (method.kind === "method") {
            this.emit("Dup"); // ctorFunc を残す
            const protoNameIdx = this.addConstant("prototype");
            this.emit("GetProperty", protoNameIdx);
            // prototype はオブジェクトなのでスタックに載る
            const fnCompiler = new BytecodeCompiler(this);
            fnCompiler.compileFunctionBody(method.value.params, method.value.body.body);
            const methodFunc = fnCompiler.finish(method.key.name);
            const methodIdx = this.addConstant(methodFunc);
            this.emit("LdaConst", methodIdx);
            const methodNameIdx = this.addConstant(method.key.name);
            this.emit("SetProperty", methodNameIdx);
            this.emit("Pop"); // prototype を捨てる
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
        if (this.loopStack.length > 0) {
          this.loopStack[this.loopStack.length - 1].breakPatches.push(breakJump);
        }
        break;
      }

      case "ContinueStatement": {
        if (this.loopStack.length > 0) {
          const loop = this.loopStack[this.loopStack.length - 1];
          if (loop.continueTarget >= 0) {
            this.emit("Jump", loop.continueTarget);
          } else {
            // continueTarget がまだ確定していない場合（for の update 前）
            // → loopStart にジャンプ（while の場合はこれで正しい）
            this.emit("Jump", 0); // パッチが必要だが簡易的に
          }
        }
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
        this.emit("GetProperty", this.addConstant("length"));
        this.emit("LessThan");
        const exitJump = this.emit("JumpIfFalse", 0);
        // var/let x = arr[i]
        this.emit("LdaGlobal", iterIdx);
        this.emit("LdaGlobal", counterIdx);
        this.emit("GetPropertyComputed");
        if (stmt.left.declarations[0].id.type === "Identifier") {
          const varName = stmt.left.declarations[0].id.name;
          if (this.isFunction) {
            const slot = this.resolveLocal(varName) ?? this.declareLocal(varName);
            this.emit("StaLocal", slot);
          } else {
            const nameIdx = this.addConstant(varName);
            this.emit("StaGlobal", nameIdx);
          }
          this.emit("Pop");
        }
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

      case "AssignmentExpression": {
        if (expr.left.type === "MemberExpression") {
          // stack: value, obj → SetPropertyAssign → pop obj, pop value, assign, push value
          this.compileExpression(expr.right);       // stack: value
          this.compileExpression(expr.left.object); // stack: value, obj
          if (!expr.left.computed && expr.left.property.type === "Identifier") {
            const nameIdx = this.addConstant(expr.left.property.name);
            this.emit("SetPropertyAssign", nameIdx);
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
        } else {
          throw new Error(`Unsupported assignment target: ${expr.left.type}`);
        }
        break;
      }

      case "MemberExpression": {
        this.compileExpression(expr.object);
        if (!expr.computed && expr.property.type === "Identifier") {
          const nameIdx = this.addConstant(expr.property.name);
          this.emit("GetProperty", nameIdx);
        } else {
          this.compileExpression(expr.property);
          this.emit("GetPropertyComputed");
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
          this.emit("Dup"); // obj を残す
          this.compileExpression(prop.value);
          const key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value);
          const nameIdx = this.addConstant(key);
          this.emit("SetProperty", nameIdx);
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
          if (!expr.callee.computed && expr.callee.property.type === "Identifier") {
            const nameIdx = this.addConstant(expr.callee.property.name);
            this.emit("GetProperty", nameIdx);
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
          "+": "Add", "-": "Sub", "*": "Mul", "/": "Div", "%": "Mod",
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
        }
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
        this.compileExpression(expr.argument);
        if (expr.operator === "-") {
          this.emit("Negate");
        } else if (expr.operator === "!") {
          this.emit("LogicalNot");
        } else if (expr.operator === "typeof") {
          this.emit("TypeOf");
        } else {
          throw new Error(`Unsupported unary operator: ${expr.operator}`);
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
