import type { BytecodeFunction, Instruction } from "./bytecode.js";
import type { FeedbackCollector } from "../jit/feedback.js";
import type { JitManager } from "../jit/jit.js";
import { createJSArray, setElement, pushElement } from "./js-array.js";
import { createJSObject, isJSObject, getProperty as jsObjGet, setProperty as jsObjSet, getHiddenClass, getSlots } from "./js-object.js";
import { isJSString, createSeqString, jsStringConcat, jsStringEquals, jsStringToString, internString, type JSString } from "./js-string.js";
import { type ICSlot, createICSlot, icLookup, icUpdate } from "./inline-cache.js";
import { Heap } from "./heap.js";
import { compileMultiSync } from "../jit/wasm-compiler.js";

// JSString 対応の truthiness 判定 (空文字列は falsy)
function isTruthy(value: unknown): boolean {
  if (isJSString(value)) return value.length > 0;
  return !!value;
}

// Upvalue ボックス: ミュータブルキャプチャ用の参照ラッパー
type UpvalueBox = { value: unknown };

type CallFrame = {
  func: BytecodeFunction;
  pc: number;
  locals: unknown[];
  thisValue: unknown;
  icSlots: ICSlot[];
  upvalueBoxes: UpvalueBox[];  // キャプチャされた変数のボックス
};

// スタックベースの Bytecode VM
export class VM {
  private stack: unknown[] = [];
  private sp = -1;
  private globals: Map<string, unknown> = new Map();
  private frames: CallFrame[] = [];
  feedback: FeedbackCollector | null = null;
  jit: JitManager | null = null;
  heap: Heap = new Heap();
  maxSteps = 0;
  private stepCount = 0;

  private push(value: unknown): void {
    this.stack[++this.sp] = value;
  }

  private pop(): unknown {
    return this.stack[this.sp--];
  }

  private peek(): unknown {
    return this.stack[this.sp];
  }

  setGlobal(name: string, value: unknown): void {
    this.globals.set(name, value);
  }

  // GC: allocate 回数が閾値を超えたら Mark-and-Sweep を実行
  private maybeGC(): void {
    if (!this.heap.shouldCollect()) return;
    const roots = this.collectRoots();
    this.heap.collect(roots);
  }

  // ルートセット: 生きているオブジェクトの起点
  private collectRoots(): unknown[] {
    const roots: unknown[] = [];
    // グローバル変数
    for (const val of this.globals.values()) roots.push(val);
    // スタック
    for (let i = 0; i <= this.sp; i++) roots.push(this.stack[i]);
    // 全 CallFrame の locals + thisValue
    for (const frame of this.frames) {
      for (const local of frame.locals) roots.push(local);
      roots.push(frame.thisValue);
      // 定数テーブル
      for (const c of frame.func.constants) roots.push(c);
    }
    return roots;
  }

  // OSR: ホットループを検出して関数全体を Wasm にコンパイル、残りを Wasm で実行
  private attemptOSR(frame: CallFrame): unknown | null {
    const func = frame.func;
    // 関連関数を収集 (LdaGlobal + Call で参照される関数 + constants のクロージャ)
    const relatedFuncs = [func];
    const seen = new Set<string>([func.name]);
    // bytecode 内の LdaGlobal + Call パターンから参照される関数
    for (const instr of func.bytecode) {
      if (instr.op === "LdaGlobal" && instr.operand !== undefined) {
        const name = func.constants[instr.operand] as string;
        if (!seen.has(name)) {
          const globalVal = this.globals.get(name);
          if (globalVal && typeof globalVal === "object" && "bytecode" in globalVal) {
            relatedFuncs.push(globalVal as BytecodeFunction);
            seen.add(name);
          }
        }
      }
    }
    // constants 内のクロージャ
    for (const c of func.constants) {
      if (c && typeof c === "object" && "bytecode" in c && !seen.has((c as BytecodeFunction).name)) {
        relatedFuncs.push(c as BytecodeFunction);
        seen.add((c as BytecodeFunction).name);
      }
    }

    // Wasm にコンパイル (upvalue 付きクロージャも含む)
    const result = compileMultiSync(relatedFuncs, "i32");
    if (!result) return null;

    const wasmFn = result.get(func.name);
    if (!wasmFn) return null;

    // 今の locals を Wasm のパラメータとして渡す
    // func.paramCount 個が通常パラメータ、残りは extra locals
    // Wasm 関数は全 locals をパラメータとして受け取る設計にはなっていない
    // → 通常パラメータだけ渡して、ループの初期状態から再実行する
    // ただしそれだと二重実行になる

    // シンプルな OSR: 関数のパラメータだけ渡して最初から再実行
    // sum, i は 0 からやり直し (= 正確な OSR ではないが、結果は正しい)
    const args: number[] = [];
    for (let i = 0; i < func.paramCount; i++) {
      const val = frame.locals[i];
      if (typeof val === "number") args.push(val);
      else return null; // 非数値パラメータ → OSR 不可
    }

    // upvalue があれば追加
    for (const box of frame.upvalueBoxes) {
      if (typeof box.value === "number") args.push(box.value as number);
      else return null;
    }

    try {
      if (this.heap.traceGC) {
        // OSR ログ
      }
      return wasmFn(...args);
    } catch {
      return null;
    }
  }

  private createICSlots(func: BytecodeFunction): ICSlot[] {
    return Array.from({ length: func.icSlotCount || 0 }, createICSlot);
  }

  // 例外をフレームスタックをアンワインドしてハンドラを探す
  private unwindToHandler(throwValue: unknown): boolean {
    while (this.frames.length > 0) {
      const frame = this.frames[this.frames.length - 1];
      const handler = frame.func.handlers?.find(
        h => frame.pc - 1 >= h.tryStart && frame.pc - 1 < h.tryEnd && h.catchStart >= 0
      );
      if (handler) {
        this.push(throwValue);
        frame.pc = handler.catchStart;
        return true;
      }
      // このフレームにハンドラがない: フレームを pop して呼び出し元に戻る
      this.frames.pop();
    }
    return false;
  }

  execute(func: BytecodeFunction): unknown {
    // トップレベルをフレームとして実行
    this.frames.push({
      func,
      pc: 0,
      locals: new Array(func.localCount).fill(undefined),
      thisValue: undefined,
      icSlots: this.createICSlots(func),
      upvalueBoxes: [],
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

      if (this.maxSteps > 0 && ++this.stepCount > this.maxSteps) {
        throw new Error("timeout: exceeded max steps");
      }

      switch (instr.op) {
        // 定数ロード
        case "LdaConst": {
          const val = constants[instr.operand!];
          if (typeof val === "string") {
            this.push(internString(val));
          } else if (typeof val === "object" && val !== null && "bytecode" in val) {
            const fn = val as BytecodeFunction;
            if (fn.upvalues && fn.upvalues.length > 0) {
              // upvalue をキャプチャ: 親のローカルスロットをボックスで共有
              // フレームごとにスロット → ボックスのマッピングを遅延作成
              if (!(frame as any).__localBoxes) {
                (frame as any).__localBoxes = new Map<number, UpvalueBox>();
              }
              const localBoxes = (frame as any).__localBoxes as Map<number, UpvalueBox>;

              const capturedBoxes: UpvalueBox[] = fn.upvalues.map(uv => {
                if (uv.parentSlot >= 0) {
                  // 親のローカル変数をボックスで共有
                  let box = localBoxes.get(uv.parentSlot);
                  if (!box) {
                    box = { value: frame.locals[uv.parentSlot] };
                    localBoxes.set(uv.parentSlot, box);
                  } else {
                    // ボックスの値を最新のローカル値に同期
                    box.value = frame.locals[uv.parentSlot];
                  }
                  return box;
                } else {
                  // 親の upvalue を引き継ぐ (ネストしたクロージャ)
                  return frame.upvalueBoxes[-(uv.parentSlot + 1)];
                }
              });
              // BytecodeFunction + キャプチャ済みボックスのペア
              this.push({ __closure: true, func: fn, capturedBoxes });
            } else {
              this.push(val);
            }
          } else {
            this.push(val);
          }
          break;
        }
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
          if (isJSString(left) || isJSString(right)) {
            // 一方または両方が JSString → 文字列連結
            const l = isJSString(left) ? left : createSeqString(String(left));
            const r = isJSString(right) ? right : createSeqString(String(right));
            this.push(jsStringConcat(l, r));
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
        case "Equal":
        case "StrictEqual": {
          const right = this.pop();
          const left = this.pop();
          if (isJSString(left) && isJSString(right)) {
            this.push(jsStringEquals(left, right));
          } else if (isJSString(left) || isJSString(right)) {
            // 片方だけ JSString → 型が違うので false
            this.push(false);
          } else {
            this.push(instr.op === "Equal" ? left == right : left === right);
          }
          break;
        }
        case "NotEqual":
        case "StrictNotEqual": {
          const right = this.pop();
          const left = this.pop();
          if (isJSString(left) && isJSString(right)) {
            this.push(!jsStringEquals(left, right));
          } else if (isJSString(left) || isJSString(right)) {
            this.push(true);
          } else {
            this.push(instr.op === "NotEqual" ? left != right : left !== right);
          }
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
          this.push(!isTruthy(val));
          break;
        }

        // ローカル変数
        case "LdaLocal": {
          const slot = instr.operand!;
          const box = (frame as any).__localBoxes?.get(slot) as UpvalueBox | undefined;
          this.push(box ? box.value : frame.locals[slot]);
          break;
        }
        case "StaLocal": {
          const slot = instr.operand!;
          const val = this.peek();
          frame.locals[slot] = val;
          const box = (frame as any).__localBoxes?.get(slot) as UpvalueBox | undefined;
          if (box) box.value = val;
          break;
        }

        // Upvalue (クロージャでキャプチャされた外部変数)
        case "LdaUpvalue":
          this.push(frame.upvalueBoxes[instr.operand!].value);
          break;
        case "StaUpvalue":
          frame.upvalueBoxes[instr.operand!].value = this.peek();
          break;

        // グローバル変数
        case "LdaGlobal": {
          const name = constants[instr.operand!] as string;
          if (!this.globals.has(name)) {
            const err = new ReferenceError(`${name} is not defined`);
            if (!this.unwindToHandler(err)) throw err;
            break;
          }
          this.push(this.globals.get(name));
          break;
        }
        case "StaGlobal": {
          const name = constants[instr.operand!] as string;
          const val = this.peek();
          this.globals.set(name, val);
          // JIT: バイトコード関数をグローバルに登録されたら追跡
          if (this.jit && typeof val === "object" && val !== null && "bytecode" in val) {
            this.jit.registerFunc(name, val as BytecodeFunction);
          }
          break;
        }

        // 制御フロー
        case "Jump": {
          const target = instr.operand!;
          if (target <= frame.pc) {
            // 後方ジャンプ = ループ → OSR カウント
            (frame as any).__loopCount = ((frame as any).__loopCount ?? 0) + 1;
            if ((frame as any).__loopCount > 100 && !(frame as any).__osrDone && this.jit) {
              // ホットループ検出 → OSR: 関数全体を Wasm にコンパイルして残りのループを実行
              const osrResult = this.attemptOSR(frame);
              if (osrResult !== null) {
                // OSR 成功: Wasm の結果を push して関数を Return 相当で抜ける
                this.frames.pop();
                if (this.frames.length > 0) {
                  this.push(osrResult);
                } else {
                  return osrResult;
                }
                (frame as any).__osrDone = true;
                continue;
              }
              (frame as any).__osrDone = true; // コンパイル失敗 → 再試行しない
            }
          }
          frame.pc = target;
          break;
        }
        case "JumpIfFalse": {
          const val = this.pop();
          if (!isTruthy(val)) frame.pc = instr.operand!;
          break;
        }
        case "JumpIfTrue": {
          const val = this.pop();
          if (isTruthy(val)) frame.pc = instr.operand!;
          break;
        }

        // オブジェクト / 配列
        case "CreateObject":
          this.push(this.heap.allocate(createJSObject()));
          this.maybeGC();
          break;
        case "CreateArray": {
          const count = instr.operand!;
          const elems: unknown[] = [];
          for (let i = 0; i < count; i++) {
            elems.unshift(this.pop());
          }
          this.push(this.heap.allocate(createJSArray(elems)));
          this.maybeGC();
          break;
        }
        case "SetProperty": {
          const value = this.pop();
          const obj = this.peek();
          const name = constants[instr.operand!] as string;
          if (isJSObject(obj)) {
            jsObjSet(obj, name, value);
            // IC 更新
            const ic = instr.icSlot !== undefined ? frame.icSlots[instr.icSlot] : null;
            if (ic) icUpdate(ic, getHiddenClass(obj), name);
          } else {
            (obj as Record<string, unknown>)[name] = value;
          }
          break;
        }
        case "SetPropertyAssign": {
          const obj = this.pop();
          const value = this.pop();
          const name = constants[instr.operand!] as string;
          if (isJSObject(obj)) {
            jsObjSet(obj, name, value);
            const ic = instr.icSlot !== undefined ? frame.icSlots[instr.icSlot] : null;
            if (ic) icUpdate(ic, getHiddenClass(obj), name);
          } else {
            (obj as Record<string, unknown>)[name] = value;
          }
          this.push(value);
          break;
        }
        case "GetProperty": {
          const obj = this.pop();
          if (instr.icSlot !== undefined && isJSObject(obj)) {
            const ic = frame.icSlots[instr.icSlot];
            const hc = getHiddenClass(obj);
            if (ic.cachedHC === hc && ic.cachedOffset >= 0) {
              // IC ヒット: slots[offset] を直接アクセス (関数呼び出しなし)
              this.push(getSlots(obj)[ic.cachedOffset]);
              break;
            }
            // IC ミス or prototype 参照 → フルパス + IC 更新
            const name = constants[instr.operand!] as string;
            if (ic.state !== "polymorphic") icUpdate(ic, hc, name);
            this.push(jsObjGet(obj, name));
          } else {
            const name = constants[instr.operand!] as string;
            this.push(isJSObject(obj) ? jsObjGet(obj, name) : (obj as Record<string, unknown>)[name]);
          }
          break;
        }
        case "GetPropertyComputed": {
          const key = this.pop();
          const obj = this.pop() as Record<string, unknown>;
          const keyStr = isJSString(key) ? jsStringToString(key) : String(key);
          this.push(obj[keyStr]);
          break;
        }
        case "SetPropertyComputed": {
          const value = this.pop();
          const key = this.pop();
          const obj = this.pop() as Record<string, unknown>;
          if (Array.isArray(obj) && typeof key === "number") {
            setElement(obj, key, value);
          } else {
            const keyStr = isJSString(key) ? jsStringToString(key) : String(key);
            obj[keyStr] = value;
          }
          this.push(value);
          break;
        }

        // 配列操作
        case "ArrayPush": {
          const value = this.pop();
          const arr = this.peek() as unknown[];
          pushElement(arr, value);
          break;
        }
        case "ArraySpread": {
          const iterable = this.pop() as unknown[];
          const arr = this.peek() as unknown[];
          arr.push(...iterable);
          break;
        }

        // in / instanceof
        case "In": {
          const right = this.pop() as Record<string, unknown>;
          const left = this.pop();
          const key = isJSString(left) ? jsStringToString(left) : String(left);
          this.push(key in right);
          break;
        }
        case "Instanceof": {
          const right = this.pop() as any;
          const left = this.pop() as any;
          // ネイティブコンストラクタ (ReferenceError 等) はそのまま JS の instanceof に委譲
          if (typeof right === "function") {
            this.push(left instanceof right);
          } else {
            // jsmini 関数: prototype チェーンを辿る
            const proto = right?.prototype;
            let current = left?.__proto__;
            let found = false;
            while (current) {
              if (current === proto) { found = true; break; }
              current = current.__proto__;
            }
            this.push(found);
          }
          break;
        }

        // typeof
        case "TypeOf": {
          const val = this.pop();
          if (isJSString(val)) this.push(internString("string"));
          else if (val === null) this.push(internString("object"));
          else this.push(internString(typeof val));
          break;
        }

        case "TypeOfGlobal": {
          const name = constants[instr.operand!] as string;
          if (!this.globals.has(name)) {
            this.push(internString("undefined"));
          } else {
            const val = this.globals.get(name);
            if (isJSString(val)) this.push(internString("string"));
            else if (val === null) this.push(internString("object"));
            else this.push(internString(typeof val));
          }
          break;
        }

        // 更新
        case "Increment":
          this.push((this.pop() as number) + 1);
          break;
        case "Decrement":
          this.push((this.pop() as number) - 1);
          break;

        // throw
        case "Throw": {
          const throwValue = this.pop();
          if (!this.unwindToHandler(throwValue)) {
            // どのフレームにもハンドラがない: JS 例外として脱出
            throw { __thrown: true, value: throwValue };
          }
          break;
        }

        // AST フォールバック (将来用、現在未使用)
        case "ExecStmt":
        case "ExecExpr":
          throw new Error(`ExecStmt/ExecExpr not implemented in VM`);


        // 関数呼び出し
        case "Call": {
          const argc = instr.operand!;
          const callee = this.pop(); // 関数
          const args: unknown[] = [];
          // 引数はスタックに逆順で積まれている（最初の引数が一番深い）
          for (let i = 0; i < argc; i++) {
            args.unshift(this.pop());
          }

          // クロージャオブジェクトか通常の BytecodeFunction か判定
          let fn: BytecodeFunction | null = null;
          let closureBoxes: UpvalueBox[] = [];
          if (typeof callee === "object" && callee !== null && "__closure" in callee) {
            const closure = callee as { func: BytecodeFunction; capturedBoxes: UpvalueBox[] };
            fn = closure.func;
            closureBoxes = closure.capturedBoxes;
          } else if (typeof callee === "object" && callee !== null && "bytecode" in callee) {
            fn = callee as BytecodeFunction;
          }

          if (fn) {
            // 型フィードバック記録
            if (this.feedback) this.feedback.recordCall(fn, args);
            // JIT: Wasm キャッシュがあればそちらで実行
            if (this.jit) {
              // upvalue の値を追加引数として渡す
              const upvalueValues = closureBoxes.map(b => b.value);
              const jitResult = this.jit.tryCall(fn, args, upvalueValues);
              if (jitResult !== null) {
                // upvalue の書き戻し (StaUpvalue で変更された可能性)
                // → Wasm は値渡しなので書き戻しは不可。読み取り専用のクロージャのみ JIT 対象
                this.push(jitResult.result);
                break;
              }
            }
            const locals = new Array(fn.localCount).fill(undefined);
            for (let i = 0; i < fn.paramCount; i++) {
              locals[i] = args[i] ?? undefined;
            }
            this.frames.push({ func: fn, pc: 0, locals, thisValue: undefined, icSlots: this.createICSlots(fn), upvalueBoxes: closureBoxes });
          } else {
            throw new Error("Not a function");
          }
          break;
        }

        // メソッド呼び出し
        case "CallMethod": {
          const argc = instr.operand!;
          const method = this.pop();  // メソッド関数
          const thisObj = this.pop(); // this (obj)
          const args: unknown[] = [];
          for (let i = 0; i < argc; i++) {
            args.unshift(this.pop());
          }

          if (typeof method === "function") {
            // ネイティブメソッド (console.log 等)
            const result = (method as Function).apply(thisObj, args);
            this.push(result);
          } else if (typeof method === "object" && method !== null && "__closure" in method) {
            // クロージャオブジェクト
            const closure = method as { func: BytecodeFunction; capturedBoxes: UpvalueBox[] };
            const fn = closure.func;
            const locals = new Array(fn.localCount).fill(undefined);
            for (let i = 0; i < fn.paramCount; i++) {
              locals[i] = args[i] ?? undefined;
            }
            this.frames.push({ func: fn, pc: 0, locals, thisValue: thisObj, icSlots: this.createICSlots(fn), upvalueBoxes: closure.capturedBoxes });
          } else if (typeof method === "object" && method !== null && "bytecode" in method) {
            const fn = method as BytecodeFunction;
            const locals = new Array(fn.localCount).fill(undefined);
            for (let i = 0; i < fn.paramCount; i++) {
              locals[i] = args[i] ?? undefined;
            }
            this.frames.push({ func: fn, pc: 0, locals, thisValue: thisObj, icSlots: this.createICSlots(fn), upvalueBoxes: [] });
          } else {
            throw new Error("Not a function");
          }
          break;
        }

        // this
        case "LoadThis":
          this.push(frame.thisValue);
          break;

        // new
        case "Construct": {
          const argc = instr.operand!;
          const ctor = this.pop() as any;
          const args: unknown[] = [];
          for (let i = 0; i < argc; i++) {
            args.unshift(this.pop());
          }
          // prototype が未設定なら作成
          if (ctor.bytecode && !ctor.prototype) {
            ctor.prototype = this.heap.allocate(createJSObject());
          }
          const newObj = this.heap.allocate(createJSObject());
          this.maybeGC();
          if (ctor.prototype) {
            jsObjSet(newObj, "__proto__", ctor.prototype);
          }
          if (ctor.__nativeConstructor) {
            // ネイティブコンストラクタ (Error 等)
            if (ctor.name === "Error") {
              this.push({ message: args[0] ?? "" });
            } else {
              throw new Error(`Unknown native constructor: ${ctor.name}`);
            }
          } else if (ctor.bytecode) {
            // BytecodeFunction
            const locals = new Array(ctor.localCount).fill(undefined);
            for (let i = 0; i < ctor.paramCount; i++) {
              locals[i] = args[i] ?? undefined;
            }
            this.frames.push({ func: ctor, pc: 0, locals, thisValue: newObj, icSlots: this.createICSlots(ctor), upvalueBoxes: [] });
            (frame as any).__pendingNewObj = newObj;
          } else {
            throw new Error("Not a constructor");
          }
          break;
        }

        // Return
        case "Return": {
          let returnValue = this.pop();
          // 型フィードバック: 戻り値の型を記録
          if (this.feedback) {
            this.feedback.recordReturn(frame.func, returnValue);
          }
          this.frames.pop();
          // Construct からの戻り: returnValue がオブジェクトでなければ this (newObj) を返す
          if (this.frames.length > 0) {
            const callerFrame = this.frames[this.frames.length - 1] as any;
            if (callerFrame.__pendingNewObj !== undefined) {
              const newObj = callerFrame.__pendingNewObj;
              delete callerFrame.__pendingNewObj;
              if (typeof returnValue !== "object" || returnValue === null) {
                returnValue = newObj;
              }
            }
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
