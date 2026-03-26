import type { BytecodeFunction, Instruction } from "./bytecode.js";

// スタックベースの Bytecode VM
export class VM {
  private stack: unknown[] = [];
  private sp = -1;
  private globals: Map<string, unknown> = new Map(); // グローバル変数

  private push(value: unknown): void {
    this.stack[++this.sp] = value;
  }

  private pop(): unknown {
    return this.stack[this.sp--];
  }

  private peek(): unknown {
    return this.stack[this.sp];
  }

  execute(func: BytecodeFunction): unknown {
    const { bytecode, constants } = func;
    let pc = 0;

    while (pc < bytecode.length) {
      const instr: Instruction = bytecode[pc++];

      switch (instr.op) {
        // 定数ロード
        case "LdaConst":
          this.push(constants[instr.operand!]);
          break;
        case "LdaUndefined":
          this.push(undefined);
          break;
        case "LdaNull":
          this.push(null);
          break;
        case "LdaTrue":
          this.push(true);
          break;
        case "LdaFalse":
          this.push(false);
          break;

        // 算術
        case "Add": {
          const right = this.pop();
          const left = this.pop();
          if (typeof left === "string" || typeof right === "string") {
            this.push(String(left) + String(right));
          } else {
            this.push((left as number) + (right as number));
          }
          break;
        }
        case "Sub": {
          const right = this.pop() as number;
          const left = this.pop() as number;
          this.push(left - right);
          break;
        }
        case "Mul": {
          const right = this.pop() as number;
          const left = this.pop() as number;
          this.push(left * right);
          break;
        }
        case "Div": {
          const right = this.pop() as number;
          const left = this.pop() as number;
          this.push(left / right);
          break;
        }
        case "Mod": {
          const right = this.pop() as number;
          const left = this.pop() as number;
          this.push(left % right);
          break;
        }
        case "Negate": {
          const val = this.pop() as number;
          this.push(-val);
          break;
        }

        // 比較
        case "Equal": {
          const right = this.pop();
          const left = this.pop();
          this.push(left == right);
          break;
        }
        case "StrictEqual": {
          const right = this.pop();
          const left = this.pop();
          this.push(left === right);
          break;
        }
        case "NotEqual": {
          const right = this.pop();
          const left = this.pop();
          this.push(left != right);
          break;
        }
        case "StrictNotEqual": {
          const right = this.pop();
          const left = this.pop();
          this.push(left !== right);
          break;
        }
        case "LessThan": {
          const right = this.pop() as number;
          const left = this.pop() as number;
          this.push(left < right);
          break;
        }
        case "GreaterThan": {
          const right = this.pop() as number;
          const left = this.pop() as number;
          this.push(left > right);
          break;
        }
        case "LessEqual": {
          const right = this.pop() as number;
          const left = this.pop() as number;
          this.push(left <= right);
          break;
        }
        case "GreaterEqual": {
          const right = this.pop() as number;
          const left = this.pop() as number;
          this.push(left >= right);
          break;
        }

        // 論理
        case "LogicalNot": {
          const val = this.pop();
          this.push(!val);
          break;
        }

        // 変数
        case "LdaGlobal": {
          const name = constants[instr.operand!] as string;
          const val = this.globals.get(name);
          this.push(val !== undefined ? val : undefined);
          break;
        }
        case "StaGlobal": {
          const name = constants[instr.operand!] as string;
          this.globals.set(name, this.peek());
          break;
        }

        // 制御フロー
        case "Jump":
          pc = instr.operand!;
          break;
        case "JumpIfFalse": {
          const val = this.pop();
          if (!val) pc = instr.operand!;
          break;
        }
        case "JumpIfTrue": {
          const val = this.pop();
          if (val) pc = instr.operand!;
          break;
        }

        // スタック操作
        case "Pop":
          this.pop();
          break;
        case "Dup":
          this.push(this.peek());
          break;

        case "Return":
          return this.pop();

        default:
          throw new Error(`Unknown opcode: ${instr.op}`);
      }
    }

    // プログラム末尾: スタックトップが結果
    return this.sp >= 0 ? this.pop() : undefined;
  }
}
