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

  emit(op: Opcode, operand?: number): number {
    const index = this.bytecode.length;
    this.bytecode.push({ op, operand });
    return index;
  }

  // 定数テーブルに値を追加し、インデックスを返す（重複排除）
  addConstant(value: unknown): number {
    const existing = this.constants.indexOf(value);
    if (existing !== -1) return existing;
    this.constants.push(value);
    return this.constants.length - 1;
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
      this.compileStatement(program.body[i]);
      // 最後の文以外は結果を捨てる
      if (i < program.body.length - 1) {
        this.emit("Pop");
      }
    }
  }

  compileStatement(stmt: Statement): void {
    switch (stmt.type) {
      case "ExpressionStatement":
        this.compileExpression(stmt.expression);
        break;
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
