import { parse } from "../parser/parser.js";
import type { Program, Statement, Expression } from "../parser/ast.js";
import type { Instruction, BytecodeFunction, Opcode } from "./bytecode.js";

// AST → バイトコードコンパイラ
export function compile(source: string): BytecodeFunction {
  const ast = parse(source);
  const compiler = new BytecodeCompiler();
  compiler.compileProgram(ast);
  return compiler.finish("<script>");
}

class BytecodeCompiler {
  private bytecode: Instruction[] = [];
  private constants: unknown[] = [];
  // グローバル変数名 → 定数テーブル内のインデックス
  private globals: Map<string, number> = new Map();

  emit(op: Opcode, operand?: number): number {
    const index = this.bytecode.length;
    this.bytecode.push({ op, operand });
    return index;
  }

  // 命令のオペランドを後から書き換える（パッチバック）
  patch(index: number, operand: number): void {
    this.bytecode[index].operand = operand;
  }

  currentOffset(): number {
    return this.bytecode.length;
  }

  addConstant(value: unknown): number {
    const existing = this.constants.indexOf(value);
    if (existing !== -1) return existing;
    this.constants.push(value);
    return this.constants.length - 1;
  }

  // グローバル変数名のインデックスを取得（なければ定数テーブルに追加）
  globalNameIndex(name: string): number {
    if (this.globals.has(name)) return this.globals.get(name)!;
    const index = this.addConstant(name);
    this.globals.set(name, index);
    return index;
  }

  finish(name: string): BytecodeFunction {
    return {
      name,
      bytecode: this.bytecode,
      constants: this.constants,
    };
  }

  compileProgram(program: Program): void {
    for (let i = 0; i < program.body.length; i++) {
      const stmt = program.body[i];
      const isLast = i === program.body.length - 1;
      this.compileStatement(stmt);
      // 式文の結果: 最後以外は pop
      if (stmt.type === "ExpressionStatement" && !isLast) {
        this.emit("Pop");
      }
    }
  }

  compileStatement(stmt: Statement): void {
    switch (stmt.type) {
      case "ExpressionStatement":
        this.compileExpression(stmt.expression);
        // 式文の結果はスタックに残す（最後の文の値を返すため）
        break;

      case "VariableDeclaration": {
        for (const decl of stmt.declarations) {
          if (decl.init) {
            this.compileExpression(decl.init);
          } else {
            this.emit("LdaUndefined");
          }
          if (decl.id.type === "Identifier") {
            const nameIdx = this.globalNameIndex(decl.id.name);
            this.emit("StaGlobal", nameIdx);
            this.emit("Pop");
          }
        }
        break;
      }

      case "IfStatement": {
        this.compileExpression(stmt.test);
        const jumpIfFalse = this.emit("JumpIfFalse", 0); // パッチバック対象
        this.compileStatement(stmt.consequent);
        if (stmt.alternate) {
          const jumpOver = this.emit("Jump", 0); // パッチバック対象
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
        // init
        if (stmt.init) {
          if (stmt.init.type === "VariableDeclaration") {
            this.compileStatement(stmt.init);
          } else {
            this.compileExpression(stmt.init);
            this.emit("Pop");
          }
        }
        // loop
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
        const nameIdx = this.globalNameIndex(expr.name);
        this.emit("LdaGlobal", nameIdx);
        break;
      }

      case "AssignmentExpression": {
        this.compileExpression(expr.right);
        if (expr.left.type === "Identifier") {
          const nameIdx = this.globalNameIndex(expr.left.name);
          this.emit("StaGlobal", nameIdx);
          // 代入式の値をスタックに残す
        } else {
          throw new Error(`Unsupported assignment target: ${expr.left.type}`);
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
        // 短絡評価
        this.compileExpression(expr.left);
        if (expr.operator === "&&") {
          this.emit("Dup");
          const skipRight = this.emit("JumpIfFalse", 0);
          this.emit("Pop"); // truthy なら左の値を捨てて右を評価
          this.compileExpression(expr.right);
          this.patch(skipRight, this.currentOffset());
        } else if (expr.operator === "||") {
          this.emit("Dup");
          const skipRight = this.emit("JumpIfTrue", 0);
          this.emit("Pop"); // falsy なら左の値を捨てて右を評価
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
