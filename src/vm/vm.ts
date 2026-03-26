import type { BytecodeFunction, Instruction } from "./bytecode.js";

type CallFrame = {
  func: BytecodeFunction;
  pc: number;
  locals: unknown[];
};

// スタックベースの Bytecode VM
export class VM {
  private stack: unknown[] = [];
  private sp = -1;
  private globals: Map<string, unknown> = new Map();
  private frames: CallFrame[] = [];

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
    // トップレベルをフレームとして実行
    this.frames.push({
      func,
      pc: 0,
      locals: new Array(func.localCount).fill(undefined),
    });

    return this.run();
  }

  private run(): unknown {
    while (this.frames.length > 0) {
      const frame = this.frames[this.frames.length - 1];
      const { bytecode, constants } = frame.func;

      if (frame.pc >= bytecode.length) {
        // 関数の末尾に到達（return なし）
        this.frames.pop();
        if (this.frames.length > 0) {
          this.push(undefined);
        }
        continue;
      }

      const instr: Instruction = bytecode[frame.pc++];

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

        // ローカル変数
        case "LdaLocal":
          this.push(frame.locals[instr.operand!]);
          break;
        case "StaLocal":
          frame.locals[instr.operand!] = this.peek();
          break;

        // グローバル変数
        case "LdaGlobal": {
          const name = constants[instr.operand!] as string;
          this.push(this.globals.has(name) ? this.globals.get(name) : undefined);
          break;
        }
        case "StaGlobal": {
          const name = constants[instr.operand!] as string;
          this.globals.set(name, this.peek());
          break;
        }

        // 制御フロー
        case "Jump":
          frame.pc = instr.operand!;
          break;
        case "JumpIfFalse": {
          const val = this.pop();
          if (!val) frame.pc = instr.operand!;
          break;
        }
        case "JumpIfTrue": {
          const val = this.pop();
          if (val) frame.pc = instr.operand!;
          break;
        }

        // 関数呼び出し
        case "Call": {
          const argc = instr.operand!;
          const callee = this.pop(); // 関数
          const args: unknown[] = [];
          // 引数はスタックに逆順で積まれている（最初の引数が一番深い）
          for (let i = 0; i < argc; i++) {
            args.unshift(this.pop());
          }

          if (typeof callee === "object" && callee !== null && "bytecode" in callee) {
            // BytecodeFunction
            const fn = callee as BytecodeFunction;
            const locals = new Array(fn.localCount).fill(undefined);
            // パラメータをローカルスロットにバインド
            for (let i = 0; i < fn.paramCount; i++) {
              locals[i] = args[i] ?? undefined;
            }
            this.frames.push({ func: fn, pc: 0, locals });
          } else {
            throw new Error("Not a function");
          }
          break;
        }

        // Return
        case "Return": {
          const returnValue = this.pop();
          this.frames.pop();
          if (this.frames.length > 0) {
            this.push(returnValue);
          } else {
            return returnValue;
          }
          break;
        }

        // スタック操作
        case "Pop":
          this.pop();
          break;
        case "Dup":
          this.push(this.peek());
          break;

        default:
          throw new Error(`Unknown opcode: ${instr.op}`);
      }
    }

    return this.sp >= 0 ? this.pop() : undefined;
  }
}
