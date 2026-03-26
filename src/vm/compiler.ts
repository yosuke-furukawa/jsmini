import { parse } from "../parser/parser.js";
import type { Program, Statement, Expression } from "../parser/ast.js";
import type { Instruction, BytecodeFunction, Opcode } from "./bytecode.js";

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
  private parent: BytecodeCompiler | null;
  private isFunction: boolean; // true = 関数内, false = トップレベル

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
    };
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
          if (decl.id.type === "Identifier") {
            if (this.isFunction) {
              const slot = this.resolveLocal(decl.id.name) ?? this.declareLocal(decl.id.name);
              this.emit("StaLocal", slot);
            } else {
              const nameIdx = this.addConstant(decl.id.name);
              this.emit("StaGlobal", nameIdx);
            }
            this.emit("Pop");
          }
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
        this.compileExpression(stmt.test);
        const exitJump = this.emit("JumpIfFalse", 0);
        this.compileStatement(stmt.body);
        this.emit("Jump", loopStart);
        this.patch(exitJump, this.currentOffset());
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
        let exitJump = -1;
        if (stmt.test) {
          this.compileExpression(stmt.test);
          exitJump = this.emit("JumpIfFalse", 0);
        }
        this.compileStatement(stmt.body);
        if (stmt.update) {
          this.compileExpression(stmt.update);
          this.emit("Pop");
        }
        this.emit("Jump", loopStart);
        if (exitJump >= 0) {
          this.patch(exitJump, this.currentOffset());
        }
        break;
      }

      case "BlockStatement": {
        for (const s of stmt.body) {
          this.compileStatement(s);
        }
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

      case "AssignmentExpression": {
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
          throw new Error("Computed member expression not yet supported in VM");
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

      case "UnaryExpression": {
        this.compileExpression(expr.argument);
        if (expr.operator === "-") {
          this.emit("Negate");
        } else if (expr.operator === "!") {
          this.emit("LogicalNot");
        } else {
          throw new Error(`Unsupported unary operator: ${expr.operator}`);
        }
        break;
      }

      default:
        throw new Error(`Unsupported expression: ${expr.type}`);
    }
  }
}
