import type { BytecodeFunction, Instruction } from "./bytecode.js";
import type { FeedbackCollector } from "../jit/feedback.js";
import type { JitManager } from "../jit/jit.js";
import { createJSArray, setElement, pushElement } from "./js-array.js";
import { createJSObject, isJSObject, getProperty as jsObjGet, setProperty as jsObjSet, getHiddenClass, getSlots, isAccessorDescriptor, createAccessorDescriptor } from "./js-object.js";
import { isJSString, createSeqString, jsStringConcat, jsStringEquals, jsStringToString, internString, type JSString } from "./js-string.js";
import { isJSSymbol } from "./js-symbol.js";
import { type ICSlot, createICSlot, icLookup, icUpdate } from "./inline-cache.js";
import { Heap } from "./heap.js";
import { compileMultiSync } from "../jit/wasm-compiler.js";
import { JSPromise, enqueueMicrotask } from "../runtime/promise.js";

// JSString 対応の truthiness 判定 (空文字列は falsy)
function isTruthy(value: unknown): boolean {
  if (isJSString(value)) return value.length > 0;
  return !!value;
}

// jsmini の typeof: Symbol は "@@symbol_" プレフィックスの文字列
function jsminiTypeof(val: unknown): string {
  if (isJSSymbol(val)) return "symbol";
  if (isJSString(val)) return "string";
  if (val === null) return "object";
  if (typeof val === "object" && val !== null && ("bytecode" in val && "paramCount" in val || "__closure" in val)) return "function";
  return typeof val;
}

// toPrimitive/callInternal 内で例外が unwindToHandler で処理された場合の sentinel
const THROWN_SENTINEL = Symbol("thrown");

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

// Generator の中断状態
type GeneratorState = "suspended" | "executing" | "completed";

type GeneratorObject = {
  __generator__: true;
  state: GeneratorState;
  func: BytecodeFunction;
  locals: unknown[];
  pc: number;
  savedStack: unknown[];  // yield 時のスタック状態
  upvalueBoxes: UpvalueBox[];
  vm: VM;  // 実行に使う VM インスタンス
  next: (value?: unknown) => { value: unknown; done: boolean };
  return: (value?: unknown) => { value: unknown; done: boolean };
  "@@iterator": () => GeneratorObject;
};

// Yield で VM ループを抜けるためのシグナル
class YieldSignal {
  value: unknown;
  constructor(value: unknown) { this.value = value; }
}

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
  private _runBaseFrameCount = 0;
  objectPrototype: Record<string, unknown> = {};
  arrayPrototype: Record<string, unknown> = {};
  stringPrototype: Record<string, unknown> = {};

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
    // upvalue 経由で参照される関数 (コンストラクタ等)
    for (const box of frame.upvalueBoxes) {
      if (box.value && typeof box.value === "object" && "bytecode" in box.value && !seen.has((box.value as BytecodeFunction).name)) {
        relatedFuncs.push(box.value as BytecodeFunction);
        seen.add((box.value as BytecodeFunction).name);
      }
    }
    // CallMethod の対象: GetProperty + CallMethod パターンで prototype メソッドを探す
    for (let i = 0; i < func.bytecode.length - 1; i++) {
      if (func.bytecode[i].op === "GetProperty" && func.bytecode[i + 1].op === "CallMethod") {
        const methodName = func.constants[func.bytecode[i].operand!] as string;
        // globals から constructor を探し、prototype からメソッドを取得
        for (const [, gval] of this.globals) {
          if (gval && typeof gval === "object" && "bytecode" in (gval as any) && (gval as any).prototype && isJSObject((gval as any).prototype)) {
            const method = jsObjGet((gval as any).prototype, methodName);
            if (method && typeof method === "object" && "bytecode" in (method as any) && !seen.has((method as any).name)) {
              relatedFuncs.push(method as BytecodeFunction);
              seen.add((method as any).name);
            }
          }
        }
      }
    }

    // IR パスが有効なら IR → Wasm、そうでなければ direct
    let wasmFn: ((...args: number[]) => number) | undefined;
    if (this.jit?.useIR) {
      const irResult = this.jit.tryOSRViaIR(func, relatedFuncs);
      if (irResult) {
        wasmFn = irResult;
      }
    }
    if (!wasmFn) {
      // direct JIT (従来)
      const result = compileMultiSync(relatedFuncs, "i32");
      if (!result) {
        (frame as any).__osrDone = true;
        return null;
      }
      wasmFn = result.get(func.name);
      if (!wasmFn) return null;
    }

    // Proper OSR: 全 locals を Wasm パラメータとして渡す
    // VM の locals (params + ローカル変数) をそのまま引き継ぎ、
    // Wasm はループ先頭から実行するが、sum/i 等が途中の値なので
    // 実質的にループの途中から再開するのと同じ結果になる
    const args: number[] = [];
    for (let i = 0; i < func.localCount; i++) {
      const val = frame.locals[i];
      if (typeof val === "number") args.push(val);
      else args.push(0); // 非数値 (undefined, 関数参照等) は 0 に
    }

    // upvalue があれば追加
    for (const box of frame.upvalueBoxes) {
      if (typeof box.value === "number") args.push(box.value as number);
      else if (typeof box.value === "object" && box.value !== null && "bytecode" in box.value) {
        // BytecodeFunction (コンストラクタ等) → Wasm 内では funcIndex で解決されるのでダミー
        args.push(0);
      }
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

  // Async function → JSPromise を返し、内部 VM で body を駆動
  private runAsyncFunction(func: BytecodeFunction, locals: unknown[], upvalueBoxes: UpvalueBox[]): JSPromise {
    const vm = new VM();
    vm.globals = this.globals;
    vm.heap = this.heap;
    vm.objectPrototype = this.objectPrototype;
    vm.arrayPrototype = this.arrayPrototype;
    vm.stringPrototype = this.stringPrototype;

    // Generator と同じ状態管理
    let pc = 0;
    let savedLocals = locals.slice();
    let savedStack: unknown[] = [];

    return new JSPromise((resolve, reject) => {
      function step(inputValue?: unknown): void {
        vm.sp = -1;
        for (const v of savedStack) vm.push(v);
        if (pc > 0) vm.push(inputValue); // await の結果

        vm.frames.push({
          func, pc, locals: savedLocals,
          thisValue: undefined,
          icSlots: vm.createICSlots(func),
          upvalueBoxes,
        });

        try {
          vm._runBaseFrameCount = vm.frames.length - 1;
          const result = vm.run(vm.frames.length - 1);
          // 正常終了 (return or 関数末尾)
          resolve!(result);
        } catch (e) {
          if (e instanceof YieldSignal) {
            // await で中断: 状態を保存 (スタック上の値も保存)
            const currentFrame = vm.frames[vm.frames.length - 1];
            pc = currentFrame.pc;
            savedLocals = currentFrame.locals;
            // スタックを保存 (sum + await i の sum 等がスタックに残る)
            savedStack = [];
            for (let si = 0; si <= vm.sp; si++) savedStack.push(vm.stack[si]);
            vm.frames.pop();
            // await した値を Promise.resolve して resume
            const awaitedValue = e.value;
            JSPromise.resolve(awaitedValue).then(
              (v: unknown) => step(v),
              (err: unknown) => reject!(err),
            );
          } else {
            // throw → reject
            const thrown = (e as any)?.__thrown ? (e as any).value : e;
            reject!(thrown);
          }
        }
      }
      step();
    });
  }

  // GeneratorObject を作成
  private createGeneratorObject(func: BytecodeFunction, locals: unknown[], upvalueBoxes: UpvalueBox[]): GeneratorObject {
    const vm = new VM();
    vm.globals = this.globals;
    vm.heap = this.heap;
    vm.objectPrototype = this.objectPrototype;
    vm.arrayPrototype = this.arrayPrototype;
    vm.stringPrototype = this.stringPrototype;

    const genObj: GeneratorObject = {
      __generator__: true,
      state: "suspended",
      func,
      locals: locals.slice(), // コピー
      pc: 0,
      savedStack: [],
      upvalueBoxes,
      vm,
      next: (value?: unknown) => {
        if (genObj.state === "completed") {
          return { value: undefined, done: true };
        }
        genObj.state = "executing";
        // フレームを復元
        vm.sp = -1;
        // 前回の yield で保存したスタックを復元
        for (const v of genObj.savedStack) {
          vm.push(v);
        }
        // next(value) の値をスタックに push（初回以外）
        if (genObj.pc > 0) {
          vm.push(value); // yield 式の結果として使われる
        }
        vm.frames.push({
          func: genObj.func,
          pc: genObj.pc,
          locals: genObj.locals,
          thisValue: undefined,
          icSlots: vm.createICSlots(genObj.func),
          upvalueBoxes: genObj.upvalueBoxes,
        });
        try {
          vm._runBaseFrameCount = vm.frames.length - 1;
          const result = vm.run(vm.frames.length - 1);
          // 正常終了 = return or 関数末尾
          genObj.state = "completed";
          return { value: result, done: true };
        } catch (e) {
          if (e instanceof YieldSignal) {
            // yield で中断: 状態を保存
            genObj.state = "suspended";
            const currentFrame = vm.frames[vm.frames.length - 1];
            genObj.pc = currentFrame.pc;
            genObj.locals = currentFrame.locals;
            // スタックを保存（現在のフレームのベースから）
            genObj.savedStack = [];
            vm.frames.pop();
            return { value: e.value, done: false };
          }
          genObj.state = "completed";
          throw e;
        }
      },
      return: (value?: unknown) => {
        genObj.state = "completed";
        return { value, done: true };
      },
      "@@iterator": () => genObj,
    };
    return genObj;
  }

  private isBytecodeCallable(obj: unknown): boolean {
    return typeof obj === "object" && obj !== null && ("bytecode" in obj || "__closure" in obj);
  }

  private setArguments(fn: BytecodeFunction, locals: unknown[], args: unknown[]): void {
    // arguments スロットはパラメータの直後 (コンパイラで declareLocal("arguments") した位置)
    const argSlot = fn.paramCount;
    if (argSlot < fn.localCount) {
      const argsObj = Object.create(null);
      for (let i = 0; i < args.length; i++) argsObj[i] = args[i];
      argsObj.length = args.length;
      locals[argSlot] = argsObj;
    }
  }

  // 汎用の関数呼び出し (BytecodeFunction, closure, native function 対応)
  private callAny(fn: unknown, thisValue: unknown, args: unknown[]): unknown {
    if (typeof fn === "function") {
      return (fn as Function).apply(thisValue, args);
    }
    if (typeof fn === "object" && fn !== null && "__closure" in (fn as any)) {
      const closure = fn as { func: BytecodeFunction; capturedBoxes: UpvalueBox[] };
      return this.callInternalWithBoxes(closure.func, thisValue, args, closure.capturedBoxes);
    }
    if (typeof fn === "object" && fn !== null && "bytecode" in (fn as any)) {
      return this.callInternal(fn as BytecodeFunction, thisValue, args);
    }
    throw new TypeError("Not a function");
  }

  private callInternalWithBoxes(func: BytecodeFunction, thisValue: unknown, args: unknown[], boxes: UpvalueBox[]): unknown {
    const locals = new Array(func.localCount).fill(undefined);
    for (let i = 0; i < args.length && i < func.paramCount; i++) {
      locals[i] = args[i];
    }
    const savedSp = this.sp;
    const baseFrameCount = this.frames.length;
    this.frames.push({
      func, pc: 0, locals, thisValue,
      icSlots: this.createICSlots(func),
      upvalueBoxes: boxes,
    });
    try {
      this.run(baseFrameCount);
    } catch (e: any) {
      this.sp = savedSp;
      const throwValue = e?.__thrown ? e.value : e;
      if (this.unwindToHandler(throwValue)) return THROWN_SENTINEL;
      throw e;
    }
    const hasResult = this.sp > savedSp;
    const result = hasResult ? this.stack[this.sp] : undefined;
    this.sp = savedSp;
    return result;
  }

  // getter/setter 関数を呼び出すヘルパー
  callGetterSetter(fn: unknown, thisValue: unknown, arg: unknown): unknown {
    const isClosure = typeof fn === "object" && fn !== null && (fn as any).__closure;
    const func = isClosure ? (fn as any).func as BytecodeFunction : fn as BytecodeFunction;
    const boxes: UpvalueBox[] = isClosure ? (fn as any).capturedBoxes : [];
    const vm = new VM();
    vm.globals = this.globals;
    vm.heap = this.heap;
    vm.objectPrototype = this.objectPrototype;
    vm.arrayPrototype = this.arrayPrototype;
    vm.stringPrototype = this.stringPrototype;
    const locals = new Array(func.localCount).fill(undefined);
    if (arg !== undefined) locals[0] = arg; // setter の引数
    vm.frames.push({ func, pc: 0, locals, thisValue, icSlots: vm.createICSlots(func), upvalueBoxes: boxes });
    return vm.run();
  }

  // 例外をフレームスタックをアンワインドしてハンドラを探す
  // minFrameCount より下のフレームは探さない (callInternal の境界)
  private unwindToHandler(throwValue: unknown, minFrameCount = 0): boolean {
    while (this.frames.length > minFrameCount) {
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

  // jsmini 関数 (BytecodeFunction or クロージャ or ネイティブ) を呼ぶ汎用ヘルパー
  callFunction(fn: unknown, thisValue: unknown, args: unknown[]): unknown {
    if (typeof fn === "function") {
      return (fn as Function).apply(thisValue, args);
    }
    if (typeof fn === "object" && fn !== null && "__closure" in (fn as any)) {
      const closure = fn as { func: BytecodeFunction; capturedBoxes: UpvalueBox[] };
      const saved = this.sp;
      const base = this.frames.length;
      const locals = new Array(closure.func.localCount).fill(undefined);
      for (let i = 0; i < closure.func.paramCount && i < args.length; i++) locals[i] = args[i];
      this.frames.push({ func: closure.func, pc: 0, locals, thisValue, icSlots: this.createICSlots(closure.func), upvalueBoxes: closure.capturedBoxes });
      try { this.run(base); } catch (e: any) {
        this.sp = saved;
        const tv = e?.__thrown ? e.value : e;
        if (this.unwindToHandler(tv)) return THROWN_SENTINEL;
        throw e;
      }
      const result = this.sp > saved ? this.stack[this.sp] : undefined;
      this.sp = saved;
      return result;
    }
    if (typeof fn === "object" && fn !== null && "bytecode" in (fn as any)) {
      return this.callInternal(fn as BytecodeFunction, thisValue, args);
    }
    throw new TypeError("Not a function");
  }

  // BytecodeFunction を直接呼び出す (ToPrimitive, Promise handler 等の内部用)
  private callInternal(func: BytecodeFunction, thisValue: unknown, args: unknown[]): unknown {
    const locals = new Array(func.localCount).fill(undefined);
    for (let i = 0; i < args.length && i < func.paramCount; i++) {
      locals[i] = args[i];
    }
    const savedSp = this.sp;
    const baseFrameCount = this.frames.length;
    this.frames.push({
      func, pc: 0, locals, thisValue,
      icSlots: this.createICSlots(func),
      upvalueBoxes: [],
    });
    try {
      const runResult = this.run(baseFrameCount);
      // run() が Return opcode で値を返すケース (frames が空になった場合)
      if (runResult !== undefined) {
        this.sp = savedSp;
        return runResult;
      }
      const hasResult = this.sp > savedSp;
      const result = hasResult ? this.stack[this.sp] : undefined;
      this.sp = savedSp;
      return result;
    } catch (e: any) {
      this.sp = savedSp;
      const throwValue = e?.__thrown ? e.value : e;
      if (this.unwindToHandler(throwValue)) return THROWN_SENTINEL;
      throw e;
    }
  }

  // ToPrimitive: オブジェクトの valueOf/toString を呼んでプリミティブに変換
  private toPrimitive(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;
    if (isJSString(value)) return value;
    if (Array.isArray(value)) return value;

    const obj = value as Record<string, unknown>;
    let methodFound = false;
    for (const name of ["valueOf", "toString"]) {
      // JSObject (Hidden Class) の場合は jsObjGet、それ以外は普通のプロパティアクセス
      const method = isJSObject(value) ? jsObjGet(value, name) : obj[name];
      if (typeof method === "function") {
        // ネイティブ関数 (e.g. new String() の valueOf/toString)
        methodFound = true;
        const result = (method as Function).call(value);
        if (result === null || result === undefined || typeof result !== "object" || isJSString(result)) {
          return result;
        }
      } else if (method && typeof method === "object" && "bytecode" in (method as any)) {
        methodFound = true;
        const result = this.callInternal(method as BytecodeFunction, value, []);
        if (result === THROWN_SENTINEL) return THROWN_SENTINEL;
        if (result === null || result === undefined || typeof result !== "object" || isJSString(result)) {
          return result;
        }
      } else if (method && typeof method === "object" && "__closure" in (method as any)) {
        methodFound = true;
        const fn = (method as any).__bytecode as BytecodeFunction;
        if (fn) {
          const result = this.callInternal(fn, value, []);
          if (result === THROWN_SENTINEL) return THROWN_SENTINEL;
          if (result === null || result === undefined || typeof result !== "object" || isJSString(result)) {
            return result;
          }
        }
      }
    }
    if (methodFound) {
      // valueOf/toString があったが両方オブジェクトを返した → TypeError
      const err = new TypeError("Cannot convert object to primitive value");
      if (this.unwindToHandler(err, this._runBaseFrameCount)) return THROWN_SENTINEL;
      throw err;
    }
    // メソッドが見つからなかった → デフォルトの toString
    return internString("[object Object]");
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

  private run(baseFrameCount = 0): unknown {
    const prevBase = this._runBaseFrameCount;
    this._runBaseFrameCount = baseFrameCount;
    try { return this._runLoop(baseFrameCount); } finally { this._runBaseFrameCount = prevBase; }
  }

  private _runLoop(baseFrameCount: number): unknown {
    while (this.frames.length > baseFrameCount) {
      const frame = this.frames[this.frames.length - 1];
      const { bytecode, constants } = frame.func;

      if (frame.pc >= bytecode.length) {
        // 関数の末尾に到達（return なし）
        this.frames.pop();
        if (this.frames.length > baseFrameCount) {
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
          const rawRight = this.pop();
          const rawLeft = this.pop();
          const left = this.toPrimitive(rawLeft);
          if (left === THROWN_SENTINEL) continue;
          const right = this.toPrimitive(rawRight);
          if (right === THROWN_SENTINEL) continue;
          if (isJSString(left) || isJSString(right)) {
            const l = isJSString(left) ? left : createSeqString(String(left));
            const r = isJSString(right) ? right : createSeqString(String(right));
            this.push(jsStringConcat(l, r));
          } else {
            this.push((left as number) + (right as number));
          }
          break;
        }
        case "Sub": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          this.push((l as number) - (r as number));
          break;
        }
        case "Mul": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          this.push((l as number) * (r as number));
          break;
        }
        case "Div": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          this.push((l as number) / (r as number));
          break;
        }
        case "Mod": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          this.push((l as number) % (r as number));
          break;
        }
        case "Exp": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          this.push((l as number) ** (r as number));
          break;
        }
        case "BitAnd": { const r = this.pop(); const l = this.pop(); this.push((l as number) & (r as number)); break; }
        case "BitOr": { const r = this.pop(); const l = this.pop(); this.push((l as number) | (r as number)); break; }
        case "BitXor": { const r = this.pop(); const l = this.pop(); this.push((l as number) ^ (r as number)); break; }
        case "BitNot": { this.push(~(this.pop() as number)); break; }
        case "ShiftLeft": { const r = this.pop(); const l = this.pop(); this.push((l as number) << (r as number)); break; }
        case "ShiftRight": { const r = this.pop(); const l = this.pop(); this.push((l as number) >> (r as number)); break; }
        case "UShiftRight": { const r = this.pop(); const l = this.pop(); this.push((l as number) >>> (r as number)); break; }
        case "IsNullish": {
          const val = this.pop();
          this.push(val === null || val === undefined);
          break;
        }
        case "Negate": {
          const val = this.toPrimitive(this.pop());
          if (val === THROWN_SENTINEL) continue;
          this.push(-(val as number));
          break;
        }

        // 比較 (==/===/!=/!== は ToPrimitive しない — identity 比較)
        case "Equal":
        case "StrictEqual": {
          const right = this.pop();
          const left = this.pop();
          if (isJSString(left) && isJSString(right)) {
            this.push(jsStringEquals(left, right));
          } else if (isJSString(left) || isJSString(right)) {
            this.push(false);
          } else if (instr.op === "Equal") {
            // == は ToPrimitive で型変換してから比較
            const l = this.toPrimitive(left); if (l === THROWN_SENTINEL) { continue; }
            const r = this.toPrimitive(right); if (r === THROWN_SENTINEL) { continue; }
            if (isJSString(l) && isJSString(r)) this.push(jsStringEquals(l, r));
            else this.push(l == r);
          } else {
            this.push(left === right);
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
          } else if (instr.op === "NotEqual") {
            const l = this.toPrimitive(left); if (l === THROWN_SENTINEL) { continue; }
            const r = this.toPrimitive(right); if (r === THROWN_SENTINEL) { continue; }
            if (isJSString(l) && isJSString(r)) this.push(!jsStringEquals(l, r));
            else this.push(l != r);
          } else {
            this.push(left !== right);
          }
          break;
        }
        case "LessThan": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          this.push((l as number) < (r as number));
          break;
        }
        case "GreaterThan": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          this.push((l as number) > (r as number));
          break;
        }
        case "LessEqual": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          this.push((l as number) <= (r as number));
          break;
        }
        case "GreaterEqual": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          this.push((l as number) >= (r as number));
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
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
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
              if (this.jit?.traceTier) {
                this.jit.tierLog.push(`[OSR] ${frame.func.name}: attempt at loop #${(frame as any).__loopCount}, locals=[${frame.locals.map(v => typeof v === 'number' ? v : typeof v).join(',')}], result=${osrResult !== null ? 'success' : 'fail'}`);
              }
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
        case "CreateObject": {
          const newObj = this.heap.allocate(createJSObject());
          jsObjSet(newObj, "__proto__", this.objectPrototype);
          this.push(newObj);
          this.maybeGC();
          break;
        }
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
        case "DefineGetter":
        case "DefineSetter": {
          const fn = this.pop(); // getter/setter 関数 (BytecodeFunction or closure)
          const obj = this.peek();
          const name = constants[instr.operand!] as string;
          if (isJSObject(obj)) {
            // JSObject: AccessorDescriptor をスロットに格納
            const existing = jsObjGet(obj, name);
            const desc = isAccessorDescriptor(existing) ? existing : createAccessorDescriptor();
            if (instr.op === "DefineGetter") {
              desc.get = fn;
            } else {
              desc.set = fn;
            }
            jsObjSet(obj, name, desc);
          } else {
            // plain object: Object.defineProperty を使用
            const target = obj as Record<string, unknown>;
            const existingDesc = Object.getOwnPropertyDescriptor(target, name) ?? {};
            const descriptor: PropertyDescriptor = {
              get: existingDesc.get,
              set: existingDesc.set,
              configurable: true,
              enumerable: true,
            };
            const self = this;
            if (instr.op === "DefineGetter") {
              descriptor.get = function(this: unknown) {
                return self.callGetterSetter(fn, this, undefined);
              };
            } else {
              descriptor.set = function(this: unknown, v: unknown) {
                self.callGetterSetter(fn, this, v);
              };
            }
            Object.defineProperty(target, name, descriptor);
          }
          break;
        }

        case "SetPropertyAssign": {
          const obj = this.pop();
          const value = this.pop();
          const name = constants[instr.operand!] as string;
          if (isJSObject(obj)) {
            const existing = jsObjGet(obj, name);
            if (isAccessorDescriptor(existing) && existing.set) {
              this.callGetterSetter(existing.set, obj, value);
            } else {
              jsObjSet(obj, name, value);
              const ic = instr.icSlot !== undefined ? frame.icSlots[instr.icSlot] : null;
              if (ic) icUpdate(ic, getHiddenClass(obj), name);
            }
          } else {
            (obj as Record<string, unknown>)[name] = value;
          }
          this.push(value);
          break;
        }
        case "GetProperty": {
          const obj = this.pop();
          if (obj === null || obj === undefined) {
            const name = constants[instr.operand!] as string;
            const err = new TypeError(`Cannot read properties of ${obj} (reading '${name}')`);
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
            break;
          }
          if (instr.icSlot !== undefined && isJSObject(obj)) {
            const ic = frame.icSlots[instr.icSlot];
            const hc = getHiddenClass(obj);
            if (ic.cachedHC === hc && ic.cachedOffset >= 0) {
              const val = getSlots(obj)[ic.cachedOffset];
              if (isAccessorDescriptor(val)) {
                this.push(val.get ? this.callGetterSetter(val.get, obj, undefined) : undefined);
              } else {
                this.push(val);
              }
              break;
            }
            const name = constants[instr.operand!] as string;
            if (ic.state !== "polymorphic") icUpdate(ic, hc, name);
            const val = jsObjGet(obj, name);
            if (isAccessorDescriptor(val)) {
              this.push(val.get ? this.callGetterSetter(val.get, obj, undefined) : undefined);
            } else {
              this.push(val);
            }
          } else {
            const name = constants[instr.operand!] as string;
            if (isJSObject(obj)) {
              const val = jsObjGet(obj, name);
              if (isAccessorDescriptor(val)) {
                this.push(val.get ? this.callGetterSetter(val.get, obj, undefined) : undefined);
              } else {
                this.push(val);
              }
            } else {
              // BytecodeFunction の prototype を遅延作成
              if (name === "prototype" && typeof obj === "object" && obj !== null && "bytecode" in obj && !(obj as any).prototype) {
                const proto = this.heap.allocate(createJSObject());
                jsObjSet(proto, "__proto__", this.objectPrototype);
                (obj as any).prototype = proto;
              }
              // 配列/文字列のメソッド: prototype を優先
              if (Array.isArray(obj) && name in this.arrayPrototype) {
                this.push(this.arrayPrototype[name]);
              } else if (isJSString(obj) && name in this.stringPrototype) {
                this.push(this.stringPrototype[name]);
              } else if (this.isBytecodeCallable(obj) && (name === "call" || name === "apply" || name === "bind")) {
                // BytecodeFunction / closure の .call / .apply / .bind
                const self = this;
                const callable = obj;
                if (name === "call") {
                  this.push(function(this: unknown, ...callArgs: unknown[]) {
                    return self.callFunction(callable, callArgs[0], callArgs.slice(1));
                  });
                } else if (name === "apply") {
                  this.push(function(this: unknown, thisArg: unknown, argsArray?: unknown[]) {
                    return self.callFunction(callable, thisArg, Array.isArray(argsArray) ? argsArray : []);
                  });
                } else {
                  this.push(function(this: unknown, thisArg: unknown, ...boundArgs: unknown[]) {
                    return function(...args: unknown[]) {
                      return self.callFunction(callable, thisArg, [...boundArgs, ...args]);
                    };
                  });
                }
              } else {
                this.push((obj as Record<string, unknown>)[name]);
              }
            }
          }
          break;
        }
        case "GetPropertyComputed": {
          const key = this.pop();
          const obj = this.pop() as Record<string, unknown>;
          const keyStr = isJSSymbol(key) ? key.key : isJSString(key) ? jsStringToString(key) : String(key);
          if (isJSObject(obj)) {
            this.push(jsObjGet(obj, keyStr));
          } else {
            this.push(obj[keyStr]);
          }
          break;
        }
        case "SetPropertyComputed": {
          const value = this.pop();
          const key = this.pop();
          const obj = this.pop() as Record<string, unknown>;
          if (Array.isArray(obj) && typeof key === "number") {
            setElement(obj, key, value);
          } else {
            const keyStr = isJSSymbol(key) ? key.key : isJSString(key) ? jsStringToString(key) : String(key);
            if (isJSObject(obj)) {
              jsObjSet(obj, keyStr, value);
            } else {
              obj[keyStr] = value;
            }
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
        // Iterator protocol
        case "GetIterator": {
          const obj = this.pop();
          if (Array.isArray(obj)) {
            this.push({ __arrayIter__: true, arr: obj, idx: 0 });
          } else if (isJSString(obj)) {
            // 文字列イテレータ: 1文字ずつ返す
            const str = jsStringToString(obj);
            const chars = [...str].map(c => internString(c));
            this.push({ __arrayIter__: true, arr: chars, idx: 0 });
          } else {
            // @@iterator を取得
            const iterFn = isJSObject(obj) ? jsObjGet(obj, "@@iterator") : (obj as any)?.["@@iterator"];
            if (!iterFn) throw new TypeError("obj is not iterable");
            const iterator = this.callAny(iterFn, obj, []);
            if (iterator === THROWN_SENTINEL) break;
            this.push(iterator);
          }
          break;
        }
        case "IteratorNext": {
          const iterator = this.pop();
          if ((iterator as any)?.__arrayIter__) {
            const ai = iterator as { arr: unknown[]; idx: number };
            if (ai.idx < ai.arr.length) {
              this.push({ value: ai.arr[ai.idx], done: false });
              ai.idx++;
            } else {
              this.push({ value: undefined, done: true });
            }
          } else {
            const nextFn = isJSObject(iterator) ? jsObjGet(iterator, "next") : (iterator as any)?.next;
            if (!nextFn) throw new TypeError("iterator.next is not a function");
            const result = this.callAny(nextFn, iterator, []);
            if (result === THROWN_SENTINEL) break;
            this.push(result);
          }
          break;
        }
        case "IteratorComplete": {
          // pop result, push result.done
          const result = this.pop();
          const done = isJSObject(result) ? jsObjGet(result, "done") : (result as any)?.done;
          this.push(!!done);
          break;
        }
        case "IteratorValue": {
          // pop result, push result.value
          const result = this.pop();
          const value = isJSObject(result) ? jsObjGet(result, "value") : (result as any)?.value;
          this.push(value);
          break;
        }

        case "DeleteProperty": {
          const obj = this.pop();
          const name = constants[instr.operand!] as string;
          if (isJSObject(obj)) {
            jsObjSet(obj, name, undefined);
            delete obj[name];
          } else if (obj && typeof obj === "object") {
            delete (obj as Record<string, unknown>)[name];
          }
          this.push(true);
          break;
        }
        case "DeletePropertyComputed": {
          const key = this.pop();
          const obj = this.pop();
          const keyStr = isJSString(key) ? jsStringToString(key) : String(key);
          if (isJSObject(obj)) {
            jsObjSet(obj, keyStr, undefined);
            delete (obj as any)[keyStr];
          } else if (obj && typeof obj === "object") {
            delete (obj as Record<string, unknown>)[keyStr];
          }
          this.push(true);
          break;
        }
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
          this.push(internString(jsminiTypeof(val)));
          break;
        }

        case "TypeOfGlobal": {
          const name = constants[instr.operand!] as string;
          if (!this.globals.has(name)) {
            this.push(internString("undefined"));
          } else {
            const val = this.globals.get(name);
            this.push(internString(jsminiTypeof(val)));
          }
          break;
        }

        // 更新
        case "Increment": {
          const v = this.toPrimitive(this.pop());
          if (v === THROWN_SENTINEL) continue;
          this.push((v as number) + 1);
          break;
        }
        case "Decrement": {
          const v = this.toPrimitive(this.pop());
          if (v === THROWN_SENTINEL) continue;
          this.push((v as number) - 1);
          break;
        }

        // throw
        case "Throw": {
          const throwValue = this.pop();
          if (!this.unwindToHandler(throwValue, this._runBaseFrameCount)) {
            // 現在の run() スコープ内にハンドラがない: JS 例外として上位に伝播
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

          if (typeof callee === "function") {
            // ネイティブ関数 (isNaN, parseInt, Math.floor 等)
            this.push((callee as Function)(...args));
          } else if (fn) {
            const locals = new Array(fn.localCount).fill(undefined);
            if (fn.hasRestParam) {
              const restIdx = fn.paramCount - 1;
              for (let i = 0; i < restIdx; i++) locals[i] = i < args.length ? args[i] : undefined;
              locals[restIdx] = args.slice(restIdx);
            } else {
              for (let i = 0; i < fn.paramCount; i++) locals[i] = i < args.length ? args[i] : undefined;
            }
            // arguments オブジェクト: パラメータの直後のスロット
            this.setArguments(fn, locals, args);
            if (fn.isAsync) {
              // Async: JIT (JSPI) を試みる
              if (this.feedback) this.feedback.recordCall(fn, args);
              if (this.jit) {
                const jitResult = this.jit.tryCall(fn, args, closureBoxes.map(b => b.value));
                if (jitResult !== null) { this.push(jitResult.result); break; }
              }
              // JIT 不可 → VM で実行
              const asyncPromise = this.runAsyncFunction(fn, locals, closureBoxes);
              this.push(asyncPromise);
            } else if (fn.isGenerator) {
              const genObj = this.createGeneratorObject(fn, locals, closureBoxes);
              this.push(genObj);
            } else {
              if (this.feedback) this.feedback.recordCall(fn, args);
              if (this.jit) {
                const upvalueValues = closureBoxes.map(b => b.value);
                const jitResult = this.jit.tryCall(fn, args, upvalueValues);
                if (jitResult !== null) { this.push(jitResult.result); break; }
              }
              this.frames.push({ func: fn, pc: 0, locals, thisValue: undefined, icSlots: this.createICSlots(fn), upvalueBoxes: closureBoxes });
            }
          } else {
            throw new TypeError("Not a function");
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
              locals[i] = i < args.length ? args[i] : undefined;
            }
            this.setArguments(fn, locals, args);
            if (fn.isAsync) {
              if (this.feedback) this.feedback.recordCall(fn, args);
              if (this.jit) {
                const jitResult = this.jit.tryCall(fn, args, closure.capturedBoxes.map(b => b.value), thisObj);
                if (jitResult !== null) { this.push(jitResult.result); break; }
              }
              const asyncPromise = this.runAsyncFunction(fn, locals, closure.capturedBoxes);
              this.push(asyncPromise);
            } else if (fn.isGenerator) {
              const genObj = this.createGeneratorObject(fn, locals, closure.capturedBoxes);
              this.push(genObj);
            } else {
              if (this.feedback) this.feedback.recordCall(fn, args);
              if (this.jit) {
                const jitResult = this.jit.tryCall(fn, args, closure.capturedBoxes.map(b => b.value), thisObj);
                if (jitResult !== null) { this.push(jitResult.result); break; }
              }
              this.frames.push({ func: fn, pc: 0, locals, thisValue: thisObj, icSlots: this.createICSlots(fn), upvalueBoxes: closure.capturedBoxes });
            }
          } else if (typeof method === "object" && method !== null && "bytecode" in method) {
            const fn = method as BytecodeFunction;
            const locals = new Array(fn.localCount).fill(undefined);
            for (let i = 0; i < fn.paramCount; i++) {
              locals[i] = i < args.length ? args[i] : undefined;
            }
            this.setArguments(fn, locals, args);
            if (fn.isAsync) {
              if (this.feedback) this.feedback.recordCall(fn, args);
              if (this.jit) {
                const jitResult = this.jit.tryCall(fn, args, [], thisObj);
                if (jitResult !== null) { this.push(jitResult.result); break; }
              }
              const asyncPromise = this.runAsyncFunction(fn, locals, []);
              this.push(asyncPromise);
            } else if (fn.isGenerator) {
              const genObj = this.createGeneratorObject(fn, locals, []);
              this.push(genObj);
            } else {
              if (this.feedback) this.feedback.recordCall(fn, args);
              if (this.jit) {
                const jitResult = this.jit.tryCall(fn, args, [], thisObj);
                if (jitResult !== null) { this.push(jitResult.result); break; }
              }
              this.frames.push({ func: fn, pc: 0, locals, thisValue: thisObj, icSlots: this.createICSlots(fn), upvalueBoxes: [] });
            }
          } else {
            throw new TypeError("Not a function");
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
            const proto = this.heap.allocate(createJSObject());
            jsObjSet(proto, "__proto__", this.objectPrototype);
            ctor.prototype = proto;
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
            // インスタンスフィールドの初期化
            if (ctor.__instanceFields) {
              for (const field of ctor.__instanceFields as any[]) {
                const name = field.key.name as string;
                let value: unknown = undefined;
                if (field.value) {
                  if (field.value.type === "Literal") {
                    value = field.value.value;
                  } else {
                    // 複雑な式は ExecExpr で評価
                    const idx = ctor.constants?.indexOf(field.value) ?? -1;
                    if (idx < 0) {
                      // constants に追加して ExecExpr で評価
                      // 簡易実装: undefined のまま
                    }
                  }
                }
                if (isJSObject(newObj)) {
                  jsObjSet(newObj, name, value);
                } else {
                  (newObj as Record<string, unknown>)[name] = value;
                }
              }
            }
            // BytecodeFunction
            const locals = new Array(ctor.localCount).fill(undefined);
            for (let i = 0; i < ctor.paramCount; i++) {
              locals[i] = i < args.length ? args[i] : undefined;
            }
            this.frames.push({ func: ctor, pc: 0, locals, thisValue: newObj, icSlots: this.createICSlots(ctor), upvalueBoxes: [] });
            (frame as any).__pendingNewObj = newObj;
          } else if (ctor.__closure) {
            // クロージャ
            const closure = ctor as { func: BytecodeFunction; capturedBoxes: UpvalueBox[] };
            const fn = closure.func;
            const locals = new Array(fn.localCount).fill(undefined);
            for (let i = 0; i < fn.paramCount; i++) {
              locals[i] = i < args.length ? args[i] : undefined;
            }
            this.frames.push({ func: fn, pc: 0, locals, thisValue: newObj, icSlots: this.createICSlots(fn), upvalueBoxes: closure.capturedBoxes });
            (frame as any).__pendingNewObj = newObj;
          } else if (typeof ctor === "function") {
            // ネイティブコンストラクタ (Object, Boolean, Number, etc.)
            const result = new ctor(...args);
            this.push(result);
          } else {
            throw new TypeError("Not a constructor");
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

        // Await: same mechanism as Yield (suspend via signal)
        case "Await": {
          const value = this.pop();
          throw new YieldSignal(value); // reuse YieldSignal for suspend
        }

        // Generator yield
        case "Yield": {
          const value = this.pop();
          // pc は次の命令を指すようにインクリメント済み（run ループで）
          frame.pc = frame.pc; // 現在の pc を保持（run ループが ++ した後）
          throw new YieldSignal(value);
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

    // トップレベル (baseFrameCount=0) の場合のみ最終結果を pop
    if (baseFrameCount === 0) {
      return this.sp >= 0 ? this.pop() : undefined;
    }
    return undefined;
  }
}
