import type { BytecodeFunction, Instruction } from "./bytecode.js";
import type { FeedbackCollector } from "../jit/feedback.js";
import type { JitManager } from "../jit/jit.js";
import { createJSArray, setElement, pushElement } from "./js-array.js";
import { createJSObject, isJSObject, getProperty as jsObjGet, setProperty as jsObjSet, getHiddenClass, getSlots, isAccessorDescriptor, createAccessorDescriptor, setPropertyChecked, STORE_OK, STORE_NO_SETTER, STORE_NOT_EXTENSIBLE, getPropAttrs, setPropAttrs, type JSObjectInternal } from "./js-object.js";
import { isJSString, createSeqString, jsStringConcat, jsStringEquals, jsStringToString, internString, arrayToPrimitiveString, toNumericOperand, type JSString } from "./js-string.js";
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

// `==` の比較で「オブジェクト」として扱う値 (JSString は primitive 扱い)。
// 両辺がこれなら参照比較で、ToPrimitive しない (JS 仕様 7.2.14)
function isEqObject(v: unknown): boolean {
  return (typeof v === "object" && v !== null && !isJSString(v)) || typeof v === "function";
}

// jsmini の typeof: Symbol は "@@symbol_" プレフィックスの文字列
function jsminiTypeof(val: unknown): string {
  if (isJSSymbol(val)) return "symbol";
  if (isJSString(val)) return "string";
  if (val === null) return "object";
  if (typeof val === "object" && val !== null && ("bytecode" in val && "paramCount" in val || "__closure" in val)) return "function";
  return typeof val;
}

// computed アクセス (obj[key]) の ToPropertyKey → 文字列化。
// jsmini のプレーンオブジェクトは host prototype が null で host String() が
// throw するので "[object Object]" に潰す (実 JS の ToString(object) と同じ)
function toPropertyKeyString(key: unknown): string {
  if (isJSSymbol(key)) return key.key;
  if (isJSString(key)) return jsStringToString(key);
  if (Array.isArray(key)) return arrayToPrimitiveString(key);
  if (key !== null && typeof key === "object") return "[object Object]";
  return String(key);
}

// toPrimitive/callInternal 内で例外が unwindToHandler で処理された場合の sentinel
const THROWN_SENTINEL = Symbol("thrown");

// クロージャ包み (upvalue キャプチャした関数/class) から中の BytecodeFunction を
// 取り出す。class が外側変数をキャプチャすると LdaConst でクロージャ化されるが、
// prototype はあくまで中の関数に属する — closure オブジェクト自身の prototype を
// 読むと undefined になり、メソッド定義や instanceof が壊れる
function ctorFuncOf(v: unknown): any {
  return v && typeof v === "object" && "__closure" in (v as any) ? (v as any).func : v;
}

// TDZ (Temporal Dead Zone): lexical (let/const) が宣言スロットを確保済みだが
// 初期化子がまだ実行されていない状態を表す穴。この値を読むと ReferenceError。
// undefined とは区別する (`let x; x` は undefined を返すが宣言前アクセスは throw)
export const TDZ_HOLE = Symbol("TDZ");

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

// Yield / Await で VM ループを抜けるためのシグナル。
// async generator では両方が出現するため kind で区別する
class YieldSignal {
  value: unknown;
  kind: "yield" | "await";
  constructor(value: unknown, kind: "yield" | "await" = "yield") {
    this.value = value;
    this.kind = kind;
  }
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
    // OSR コンパイル結果は関数単位でキャッシュ (undefined=未試行 / null=失敗 / fn=成功)。
    // 旧実装は __osrDone がフレーム単位だったため、ループ 100 回超の関数を
    // 呼ぶたびに IR 構築 + Wasm コンパイルを丸ごと再試行していた
    // (deltablue で呼び出しごとの隠れた常駐コストになっていた)
    const osrCached = (func as { __osrFn?: ((...a: number[]) => number) | null }).__osrFn;
    if (osrCached === null) return null;
    if (osrCached) return this.runOSRCompiled(frame, osrCached);
    // 関連関数を収集 (LdaGlobal + Call で参照される関数 + constants のクロージャ)
    const relatedFuncs = [func];
    const seen = new Set<string>([func.name]);
    // bytecode 内の LdaGlobal / LdaUpvalue + Call パターンから参照される関数
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
      // let/const で定義された関数は LdaUpvalue 経由で参照される
      if (instr.op === "LdaUpvalue" && instr.operand !== undefined) {
        const box = frame.upvalueBoxes[instr.operand];
        if (box?.value && typeof box.value === "object" && "bytecode" in box.value && !seen.has((box.value as BytecodeFunction).name)) {
          relatedFuncs.push(box.value as BytecodeFunction);
          seen.add((box.value as BytecodeFunction).name);
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
        (func as { __osrFn?: unknown }).__osrFn = null;
        return null;
      }
      wasmFn = result.get(func.name);
      if (!wasmFn) { (func as { __osrFn?: unknown }).__osrFn = null; return null; }
    }
    (func as { __osrFn?: unknown }).__osrFn = wasmFn;
    return this.runOSRCompiled(frame, wasmFn);
  }

  // OSR コンパイル済み関数を現在のフレーム状態で実行 (args 構築は毎回)
  private runOSRCompiled(frame: CallFrame, wasmFn: (...a: number[]) => number): unknown | null {
    const func = frame.func;

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
  private runAsyncFunction(func: BytecodeFunction, locals: unknown[], upvalueBoxes: UpvalueBox[], thisValue?: unknown): JSPromise {
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
          thisValue, // async メソッドの this (従来は undefined 固定で this が消えていた)
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
  // generator の呼び出し時パラメータ検証 (spec: FunctionDeclarationInstantiation は
  // 呼び出し時に走るため、分割パターンの TypeError は generator オブジェクト生成前)。
  // 副作用を避ける近似: getter (AccessorDescriptor) は呼ばず、非配列イテラブルの
  // 要素は辿らない。false-negative (見逃し) 側に倒す
  private validateParamShape(value: unknown, shape: any): void {
    if (!shape) return;
    if (shape.t === "d") {
      // デフォルト付き: undefined ならデフォルトが適用されるので検証不要
      if (value !== undefined) this.validateParamShape(value, shape.inner);
      return;
    }
    if (shape.t === "o") {
      if (value === null || value === undefined) {
        throw new TypeError(`Cannot destructure '${value}' as it is ${value === null ? "null" : "undefined"}.`);
      }
      for (const { key, inner } of shape.props) {
        let v: unknown;
        if (isJSObject(value)) {
          v = jsObjGet(value, key);
          if (isAccessorDescriptor(v)) continue; // getter は呼ばない
        } else if (Array.isArray(value) || typeof value !== "object") {
          continue; // 配列/プリミティブのプロパティ読みは undefined 側に倒す
        } else {
          v = (value as Record<string, unknown>)[key];
        }
        this.validateParamShape(v, inner);
      }
      return;
    }
    if (shape.t === "a") {
      const iterable = Array.isArray(value)
        || typeof value === "string" || isJSString(value)
        || (value !== null && (typeof value === "object" || typeof value === "function")
            && ((value as any)[Symbol.iterator] !== undefined || (value as any)["@@iterator"] !== undefined
                || (isJSObject(value) && jsObjGet(value, "@@iterator") !== undefined)));
      if (!iterable) throw new TypeError("obj is not iterable");
      if (Array.isArray(value)) {
        for (let i = 0; i < shape.elems.length; i++) {
          if (shape.elems[i]) this.validateParamShape(value[i], shape.elems[i]);
        }
      }
    }
  }

  private validateGeneratorParams(func: BytecodeFunction, locals: unknown[]): void {
    const shapes = func.paramShapes;
    if (!shapes) return;
    for (let i = 0; i < func.paramCount && i < shapes.length; i++) {
      if (shapes[i]) this.validateParamShape(locals[i], shapes[i]);
    }
  }

  private createGeneratorObject(func: BytecodeFunction, locals: unknown[], upvalueBoxes: UpvalueBox[]): GeneratorObject {
    this.validateGeneratorParams(func, locals);
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

  // AsyncGenerator オブジェクト (spec 27.6 の近似)。
  // next/return/throw が JSPromise を返し、リクエストはキューで直列化。
  // body 内の Await (kind: "await") は resume、Yield (kind: "yield") は
  // 値を await してから {value, done:false} で決着する。
  // 制約: await 拒否を body の try/catch に届ける手段が VM に無いため
  // (sync generator に throw() が無いのと同根)、拒否は generator 全体の
  // 完了 + reject として扱う
  private createAsyncGeneratorObject(func: BytecodeFunction, locals: unknown[], upvalueBoxes: UpvalueBox[], thisValue?: unknown): Record<string, unknown> {
    this.validateGeneratorParams(func, locals);
    const vm = new VM();
    vm.globals = this.globals;
    vm.heap = this.heap;
    vm.objectPrototype = this.objectPrototype;
    vm.arrayPrototype = this.arrayPrototype;
    vm.stringPrototype = this.stringPrototype;

    let pc = 0;
    let savedLocals = locals.slice();
    let savedStack: unknown[] = [];
    let finished = false;
    let running = false;

    type Req = { type: "next" | "return" | "throw"; arg: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
    const queue: Req[] = [];

    const settle = (fn: (req: Req) => void): void => {
      const req = queue.shift()!;
      running = false;
      fn(req);
      pump();
    };

    const finish = (fn: (req: Req) => void): void => {
      finished = true;
      settle(fn);
    };

    function resume(input: unknown): void {
      vm.sp = -1;
      for (const v of savedStack) vm.push(v);
      if (pc > 0) vm.push(input); // Await/Yield の式の結果
      vm.frames.push({
        func, pc, locals: savedLocals, thisValue,
        icSlots: vm.createICSlots(func),
        upvalueBoxes,
      });
      try {
        vm._runBaseFrameCount = vm.frames.length - 1;
        const result = vm.run(vm.frames.length - 1);
        finish((req) => req.resolve({ value: result, done: true }));
      } catch (e) {
        if (e instanceof YieldSignal) {
          const fr = vm.frames[vm.frames.length - 1];
          pc = fr.pc;
          savedLocals = fr.locals;
          savedStack = [];
          for (let si = 0; si <= vm.sp; si++) savedStack.push(vm.stack[si]);
          vm.frames.pop();
          if (e.kind === "await") {
            JSPromise.resolve(e.value).then(
              (v: unknown) => resume(v),
              (err: unknown) => finish((req) => req.reject(err)),
            );
          } else {
            // yield: 値も await してから決着 (spec AsyncGeneratorYield)
            JSPromise.resolve(e.value).then(
              (v: unknown) => settle((req) => req.resolve({ value: v, done: false })),
              (err: unknown) => finish((req) => req.reject(err)),
            );
          }
        } else {
          const thrown = (e as any)?.__thrown ? (e as any).value : e;
          finish((req) => req.reject(thrown));
        }
      }
    }

    function pump(): void {
      if (running || queue.length === 0) return;
      const req = queue[0];
      if (finished) {
        queue.shift();
        if (req.type === "throw") req.reject(req.arg);
        else req.resolve({ value: req.type === "return" ? req.arg : undefined, done: true });
        pump();
        return;
      }
      if (req.type === "return") {
        // 簡易: finally は実行しない (sync generator の return と同等)
        finish((r) => r.resolve({ value: r.arg, done: true }));
        return;
      }
      if (req.type === "throw") {
        // 中断点への例外注入は未対応 → generator を終了して reject
        finish((r) => r.reject(r.arg));
        return;
      }
      running = true;
      resume(req.arg);
    }

    const enqueue = (type: Req["type"], arg: unknown): JSPromise =>
      new JSPromise((resolve, reject) => {
        queue.push({ type, arg, resolve: resolve!, reject: reject! });
        pump();
      });

    const genObj: Record<string, unknown> = {
      next: (value?: unknown) => enqueue("next", value),
      return: (value?: unknown) => enqueue("return", value),
      throw: (value?: unknown) => enqueue("throw", value),
      "@@asyncIterator": () => genObj,
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
  // JSObject への属性チェック付き store (spec 9.1.9 OrdinarySet の近似)。
  // writable:false / non-extensible / setter 無し accessor → strict の TypeError。
  // 戻り値: true = 完了 (データ書込 or setter 呼び出し) / false = unwind 済み
  storeJSObjectChecked(obj: JSObjectInternal, name: string, value: unknown): boolean {
    const r = setPropertyChecked(obj, name, value);
    if (r === STORE_OK) return true;
    if (typeof r === "object") {
      // setter 内で throw され外側ハンドラに unwind 済みなら false (caller は break)
      if (this.callGetterSetter(r.set, obj, value) === THROWN_SENTINEL) return false;
      return true;
    }
    const err = new TypeError(
      r === STORE_NOT_EXTENSIBLE ? `Cannot add property ${name}, object is not extensible`
      : r === STORE_NO_SETTER ? `Cannot set property ${name} of object which has only a getter`
      : `Cannot assign to read only property '${name}' of object`);
    if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
    return false;
  }

  // getter/setter を同一 VM で同期実行する。以前は別 VM を起動していたため、
  // getter 内の throw が外側フレームの catch ハンドラに一切到達できなかった
  // (フレームスタックが分断される)。callFunction は外側ハンドラへ unwind し、
  // 処理された場合は THROWN_SENTINEL を返す — caller は伝播チェックすること
  callGetterSetter(fn: unknown, thisValue: unknown, arg: unknown): unknown {
    return this.callFunction(fn, thisValue, arg === undefined ? [] : [arg]);
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
    if (func.hasRestParam) {
      const restIdx = func.paramCount - 1;
      for (let i = 0; i < restIdx; i++) locals[i] = i < args.length ? args[i] : undefined;
      locals[restIdx] = args.slice(restIdx);
    } else {
      for (let i = 0; i < args.length && i < func.paramCount; i++) {
        locals[i] = args[i];
      }
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
    // 配列は join(",") 相当の文字列に (host に任せると jsmini オブジェクト要素の
    // null proto で throw する)。数値文脈は toNumericOperand が文字列から変換する
    if (Array.isArray(value)) return internString(arrayToPrimitiveString(value));

    const obj = value as Record<string, unknown>;
    let methodFound = false;
    for (const name of ["valueOf", "toString"]) {
      // JSObject (Hidden Class) の場合は jsObjGet、それ以外は普通のプロパティアクセス
      const method = isJSObject(value) ? jsObjGet(value, name) : obj[name];
      if (typeof method === "function") {
        // ネイティブ関数 (e.g. new String() の valueOf/toString)。
        // C.prototype は素の host {} なので host の Object.prototype.toString が
        // 見え、それは host string "[object Object]" を返す → JSString に intern
        // しないと LessThan 等が「片方だけ JSString」で数値比較経路に落ちる
        methodFound = true;
        const result = (method as Function).call(value);
        if (typeof result === "string") return internString(result);
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
    try {
      while (true) {
        try {
          return this._runLoop(baseFrameCount);
        } catch (e: any) {
          // YieldSignal などの内部制御フローはそのまま伝播させる
          if (e instanceof YieldSignal) throw e;
          // VM 内 Throw opcode (`__thrown`) は _runLoop 内で処理済み — ここに来るのは
          // host が投げた素の Error (WeakMap の primitive 拒否、host 例外 etc)。
          // VM の try/catch ハンドラに変換。
          if (e?.__thrown) throw e;
          if (this.unwindToHandler(e, baseFrameCount)) continue;
          throw e;
        }
      }
    } finally { this._runBaseFrameCount = prevBase; }
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
                    // ボックスが既にあるなら、box が真のソース (StaUpvalue で更新済み)
                    // locals をボックスの値で同期 (LdaLocal との整合性のため)
                    frame.locals[uv.parentSlot] = box.value;
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
          this.push(toNumericOperand(l) - toNumericOperand(r));
          break;
        }
        case "Mul": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          this.push(toNumericOperand(l) * toNumericOperand(r));
          break;
        }
        case "Div": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          this.push(toNumericOperand(l) / toNumericOperand(r));
          break;
        }
        case "Mod": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          this.push(toNumericOperand(l) % toNumericOperand(r));
          break;
        }
        case "Exp": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          this.push(toNumericOperand(l) ** toNumericOperand(r));
          break;
        }
        // ビット演算・シフトも被演算子を ToPrimitive してから数値化する (JS の ToNumber → ToInt32)。
        // これを省くと ({}) & 1 のようなオブジェクト被演算子で host が "Cannot convert object to
        // primitive value" を投げてしまう (正しくは NaN → 0)。
        case "BitAnd": { const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue; const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue; this.push(toNumericOperand(l) & toNumericOperand(r)); break; }
        case "BitOr": { const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue; const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue; this.push(toNumericOperand(l) | toNumericOperand(r)); break; }
        case "BitXor": { const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue; const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue; this.push(toNumericOperand(l) ^ toNumericOperand(r)); break; }
        case "BitNot": { const v = this.toPrimitive(this.pop()); if (v === THROWN_SENTINEL) continue; this.push(~toNumericOperand(v)); break; }
        case "ShiftLeft": { const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue; const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue; this.push(toNumericOperand(l) << toNumericOperand(r)); break; }
        case "ShiftRight": { const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue; const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue; this.push(toNumericOperand(l) >> toNumericOperand(r)); break; }
        case "UShiftRight": { const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue; const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue; this.push(toNumericOperand(l) >>> toNumericOperand(r)); break; }
        case "IsNullish": {
          const val = this.pop();
          this.push(val === null || val === undefined);
          break;
        }
        case "RequireCoercible": {
          const val = this.peek();
          if (val === null || val === undefined) {
            const err = new TypeError(`Cannot destructure '${val}' as it is ${val === null ? "null" : "undefined"}.`);
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
          }
          break;
        }
        case "Negate": {
          const val = this.toPrimitive(this.pop());
          if (val === THROWN_SENTINEL) continue;
          this.push(-toNumericOperand(val));
          break;
        }

        // 比較 (==/===/!=/!== は ToPrimitive しない — identity 比較)
        case "Equal":
        case "StrictEqual": {
          const right = this.pop();
          const left = this.pop();
          if (isJSString(left) && isJSString(right)) {
            this.push(jsStringEquals(left, right));
          } else if (instr.op === "StrictEqual") {
            // === は型が違えば false。片方だけ JSString なら相手は文字列でないので false
            this.push(isJSString(left) || isJSString(right) ? false : left === right);
          } else {
            // == (JS 仕様 7.2.14)。両辺オブジェクトなら参照比較。
            // ToPrimitive は片辺が primitive のときだけ — これを怠ると
            // 別オブジェクト同士が "[object Object]" == "[object Object]" で
            // true になる (deltablue の strength == REQUIRED が誤爆した)
            if (isEqObject(left) && isEqObject(right)) {
              this.push(left === right);
            } else {
              const l = this.toPrimitive(left); if (l === THROWN_SENTINEL) { continue; }
              const r = this.toPrimitive(right); if (r === THROWN_SENTINEL) { continue; }
              if (isJSString(l) && isJSString(r)) this.push(jsStringEquals(l, r));
              else {
                // JSString は host string に解いて host の == に委ねる。
                // string↔number/boolean の ToNumber 段 ("5" == 5 → true) を
                // host が正しくやってくれる (以前は片方 JSString = 即 false だった)
                const lh = isJSString(l) ? jsStringToString(l) : l;
                const rh = isJSString(r) ? jsStringToString(r) : r;
                this.push(lh == rh);
              }
            }
          }
          break;
        }
        case "NotEqual":
        case "StrictNotEqual": {
          const right = this.pop();
          const left = this.pop();
          if (isJSString(left) && isJSString(right)) {
            this.push(!jsStringEquals(left, right));
          } else if (instr.op === "NotEqual") {
            if (isEqObject(left) && isEqObject(right)) {
              this.push(left !== right);
            } else {
              const l = this.toPrimitive(left); if (l === THROWN_SENTINEL) { continue; }
              const r = this.toPrimitive(right); if (r === THROWN_SENTINEL) { continue; }
              if (isJSString(l) && isJSString(r)) this.push(!jsStringEquals(l, r));
              else {
                const lh = isJSString(l) ? jsStringToString(l) : l;
                const rh = isJSString(r) ? jsStringToString(r) : r;
                this.push(lh != rh);
              }
            }
          } else {
            this.push(isJSString(left) || isJSString(right) ? true : left !== right);
          }
          break;
        }
        case "LessThan": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          if (isJSString(l) && isJSString(r)) this.push(jsStringToString(l) < jsStringToString(r));
          else this.push(toNumericOperand(l) < toNumericOperand(r));
          break;
        }
        case "GreaterThan": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          if (isJSString(l) && isJSString(r)) this.push(jsStringToString(l) > jsStringToString(r));
          else this.push(toNumericOperand(l) > toNumericOperand(r));
          break;
        }
        case "LessEqual": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          if (isJSString(l) && isJSString(r)) this.push(jsStringToString(l) <= jsStringToString(r));
          else this.push(toNumericOperand(l) <= toNumericOperand(r));
          break;
        }
        case "GreaterEqual": {
          const r = this.toPrimitive(this.pop()); if (r === THROWN_SENTINEL) continue;
          const l = this.toPrimitive(this.pop()); if (l === THROWN_SENTINEL) continue;
          if (isJSString(l) && isJSString(r)) this.push(jsStringToString(l) >= jsStringToString(r));
          else this.push(toNumericOperand(l) >= toNumericOperand(r));
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
        case "LdaLocalTDZ": {
          const slot = instr.operand!;
          const box = (frame as any).__localBoxes?.get(slot) as UpvalueBox | undefined;
          const v = box ? box.value : frame.locals[slot];
          if (v === TDZ_HOLE) {
            const err = new ReferenceError("Cannot access lexical binding before initialization");
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
            break;
          }
          this.push(v);
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
        case "StaLocalTDZ": {
          // lexical への再代入: 初期化前 (穴) なら ReferenceError
          const slot = instr.operand!;
          const box = (frame as any).__localBoxes?.get(slot) as UpvalueBox | undefined;
          const cur = box ? box.value : frame.locals[slot];
          if (cur === TDZ_HOLE) {
            const err = new ReferenceError("Cannot access lexical binding before initialization");
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
            break;
          }
          const val = this.peek();
          frame.locals[slot] = val;
          if (box) box.value = val;
          break;
        }
        case "CheckTDZ": {
          // const 再代入時の TDZ 優先判定: 穴なら ReferenceError (const の TypeError より先)
          const slot = instr.operand!;
          const box = (frame as any).__localBoxes?.get(slot) as UpvalueBox | undefined;
          const cur = box ? box.value : frame.locals[slot];
          if (cur === TDZ_HOLE) {
            const err = new ReferenceError("Cannot access lexical binding before initialization");
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
          }
          break;
        }
        case "StaHole": {
          // lexical スコープ入口: スロットを TDZ の穴で初期化
          const slot = instr.operand!;
          frame.locals[slot] = TDZ_HOLE;
          const box = (frame as any).__localBoxes?.get(slot) as UpvalueBox | undefined;
          if (box) box.value = TDZ_HOLE;
          break;
        }

        // Upvalue (クロージャでキャプチャされた外部変数)
        case "LdaUpvalue":
          this.push(frame.upvalueBoxes[instr.operand!].value);
          break;
        case "LdaUpvalueTDZ": {
          const v = frame.upvalueBoxes[instr.operand!].value;
          if (v === TDZ_HOLE) {
            const err = new ReferenceError("Cannot access lexical binding before initialization");
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
            break;
          }
          this.push(v);
          break;
        }
        case "StaUpvalue":
          frame.upvalueBoxes[instr.operand!].value = this.peek();
          break;
        case "StaUpvalueTDZ": {
          const b = frame.upvalueBoxes[instr.operand!];
          if (b.value === TDZ_HOLE) {
            const err = new ReferenceError("Cannot access lexical binding before initialization");
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
            break;
          }
          b.value = this.peek();
          break;
        }

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
        case "CheckGlobal": {
          // callee の存在チェック (push しない)。args→callee のスタック順を
          // 保ったまま「callee 参照解決が引数評価より先」の JS 仕様を実現する
          const name = constants[instr.operand!] as string;
          if (!this.globals.has(name)) {
            const err = new ReferenceError(`${name} is not defined`);
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
          }
          break;
        }
        case "StaGlobalStrict": {
          // 代入専用。宣言 (var/function/組み込み) されていないグローバルへの代入は
          // strict の ReferenceError (暗黙グローバルを作らない)。
          const name = constants[instr.operand!] as string;
          if (!this.globals.has(name)) {
            const err = new ReferenceError(`${name} is not defined`);
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
            break;
          }
          const val = this.peek();
          this.globals.set(name, val);
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
            // 属性チェック付き store (writable:false/frozen → TypeError, setter → 呼び出し)
            if (!this.storeJSObjectChecked(obj, name, value)) break;
            const ic = instr.icSlot !== undefined ? frame.icSlots[instr.icSlot] : null;
            if (ic) icUpdate(ic, getHiddenClass(obj), name);
          } else if (isJSString(obj) || isJSSymbol(obj)) {
            // プリミティブ (文字列/シンボル) へのプロパティ代入は strict の TypeError。
            // 文字列は intern 共有オブジェクトなので黙って書くと状態が漏れる
            const err = new TypeError(`Cannot create property '${name}' on ${isJSString(obj) ? "string" : "symbol"}`);
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
            break;
          } else {
            (obj as Record<string, unknown>)[name] = value;
          }
          break;
        }
        case "DefineMethodProp": {
          // class メソッド定義: non-enumerable / writable / configurable (spec 準拠)。
          // object リテラルのメソッドは enumerable なので SetProperty のまま
          const value = this.pop();
          const target = this.peek();
          const name = constants[instr.operand!] as string;
          if (isJSObject(target)) {
            jsObjSet(target, name, value);
            const a = getPropAttrs(target, name);
            if (!a || a.enumerable) {
              // enumerable:false を記録 (writable/configurable は true)
              (target.__attrs__ ?? (target.__attrs__ = new Map())).set(name, { writable: true, enumerable: false, configurable: true });
            }
          } else if (target && (typeof target === "object" || typeof target === "function")) {
            Object.defineProperty(target, name, { value, writable: true, enumerable: false, configurable: true });
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
            if (!this.storeJSObjectChecked(obj, name, value)) break;
            const ic = instr.icSlot !== undefined ? frame.icSlots[instr.icSlot] : null;
            if (ic) icUpdate(ic, getHiddenClass(obj), name);
          } else if (isJSString(obj) || isJSSymbol(obj)) {
            const err = new TypeError(`Cannot create property '${name}' on ${isJSString(obj) ? "string" : "symbol"}`);
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
            break;
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
                {
                  const gv = val.get ? this.callGetterSetter(val.get, obj, undefined) : undefined;
                  if (gv === THROWN_SENTINEL) continue;
                  this.push(gv);
                }
              } else {
                this.push(val);
              }
              break;
            }
            const name = constants[instr.operand!] as string;
            if (ic.state !== "polymorphic") icUpdate(ic, hc, name);
            const val = jsObjGet(obj, name);
            if (isAccessorDescriptor(val)) {
              {
                const gv = val.get ? this.callGetterSetter(val.get, obj, undefined) : undefined;
                if (gv === THROWN_SENTINEL) continue;
                this.push(gv);
              }
            } else {
              this.push(val);
            }
          } else {
            const name = constants[instr.operand!] as string;
            if (isJSObject(obj)) {
              const val = jsObjGet(obj, name);
              if (isAccessorDescriptor(val)) {
                {
                  const gv = val.get ? this.callGetterSetter(val.get, obj, undefined) : undefined;
                  if (gv === THROWN_SENTINEL) continue;
                  this.push(gv);
                }
              } else {
                this.push(val);
              }
            } else {
              // closure オブジェクトの name/length は中の BytecodeFunction へ転送
              if ((name === "name" || name === "length") && typeof obj === "object" && obj !== null && "__closure" in obj) {
                const cf = (obj as any).func;
                this.push(name === "name" ? internString(cf?.name ?? "") : (cf?.length ?? 0));
                break;
              }
              if (name === "name" && typeof obj === "object" && obj !== null && "bytecode" in obj) {
                this.push(internString((obj as any).name ?? ""));
                break;
              }
              // BytecodeFunction の prototype を遅延作成 (closure は中の func に委譲)
              {
                const fnObj = ctorFuncOf(obj);
                if (name === "prototype" && fnObj && typeof fnObj === "object" && "bytecode" in fnObj) {
                  if (!fnObj.prototype) {
                    const proto = this.heap.allocate(createJSObject());
                    jsObjSet(proto, "__proto__", this.objectPrototype);
                    jsObjSet(proto, "constructor", fnObj);
                    setPropAttrs(proto, "constructor", { writable: true, enumerable: false, configurable: true });
                    fnObj.prototype = proto;
                  }
                  this.push(fnObj.prototype);
                  break;
                }
              }
              // 配列/文字列のメソッド: prototype を優先
              if (Array.isArray(obj) && name in this.arrayPrototype) {
                this.push(this.arrayPrototype[name]);
              } else if (isJSString(obj) && name in this.stringPrototype) {
                this.push(this.stringPrototype[name]);
              } else if (isJSString(obj)) {
                // user 拡張 (`String.prototype.parseJSON = ...` 等) のフォールバック:
                // host string に unwrap して method を取得し、wrapper で呼び出す
                const str = jsStringToString(obj);
                const nativeFn = (str as any)[name];
                if (typeof nativeFn === "function") {
                  this.push((...a: unknown[]) => {
                    const nativeArgs = a.map(x => isJSString(x) ? jsStringToString(x) : x);
                    const result = (nativeFn as Function).apply(str, nativeArgs);
                    if (typeof result === "string") return internString(result);
                    if (Array.isArray(result)) return result.map((s: unknown) => typeof s === "string" ? internString(s) : s);
                    return result;
                  });
                } else {
                  this.push(nativeFn);
                }
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
          const keyStr = toPropertyKeyString(key);
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
            const keyStr = toPropertyKeyString(key);
            if (isJSObject(obj)) {
              if (!this.storeJSObjectChecked(obj, keyStr, value)) break;
            } else if (isJSString(obj) || isJSSymbol(obj)) {
              const err = new TypeError(`Cannot create property '${keyStr}' on ${isJSString(obj) ? "string" : "symbol"}`);
              if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
              break;
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
        case "GetAsyncIterator": {
          // @@asyncIterator があれば呼ぶ。無ければ GetIterator と同じ扱い
          // (sync iterable / 配列 / 文字列は for await / yield* 側の Await が決着させる)
          const aObj = this.peek();
          let aIterFn = isJSObject(aObj) ? jsObjGet(aObj, "@@asyncIterator") : (aObj as any)?.["@@asyncIterator"];
          if (isAccessorDescriptor(aIterFn)) {
            // getter 経由 (get [Symbol.asyncIterator]() {...}) — 呼んで値を得る
            this.pop();
            aIterFn = aIterFn.get !== undefined ? this.callGetterSetter(aIterFn.get, aObj, undefined) : undefined;
            if (aIterFn === THROWN_SENTINEL) break;
            this.push(aObj); // 下の共通処理のため戻す
          }
          if (aIterFn !== undefined && aIterFn !== null) {
            this.pop();
            // GetMethod: null/undefined 以外の非 callable は TypeError
            // (@@iterator へはフォールバックしない)
            if (typeof aIterFn !== "function" && !this.isBytecodeCallable(aIterFn)) {
              throw new TypeError("Symbol.asyncIterator is not callable");
            }
            const iterator = this.callAny(aIterFn, aObj, []);
            if (iterator === THROWN_SENTINEL) break;
            this.push(iterator);
            break;
          }
          // @@asyncIterator が無い → fallthrough して GetIterator と同じ処理
        }
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
            // @@iterator を取得 (host Symbol.iterator にもフォールバック: host Map/Set 等)
            let iterFn = isJSObject(obj) ? jsObjGet(obj, "@@iterator") : (obj as any)?.["@@iterator"];
            if (!iterFn && obj !== null && typeof obj === "object" && typeof (obj as any)[Symbol.iterator] === "function") {
              iterFn = (obj as any)[Symbol.iterator].bind(obj);
            }
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
            // configurable:false の削除は strict の TypeError
            if (getPropAttrs(obj, name)?.configurable === false) {
              const err = new TypeError(`Cannot delete property '${name}' of object`);
              if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
              break;
            }
            jsObjSet(obj, name, undefined);
            delete obj[name];
            obj.__attrs__?.delete(name);
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
            if (getPropAttrs(obj, keyStr)?.configurable === false) {
              const err = new TypeError(`Cannot delete property '${keyStr}' of object`);
              if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
              break;
            }
            jsObjSet(obj, keyStr, undefined);
            delete (obj as any)[keyStr];
            obj.__attrs__?.delete(keyStr);
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
            // jsmini 関数: prototype チェーンを辿る (closure は中の func から)
            const proto = ctorFuncOf(right)?.prototype;
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
          this.push(toNumericOperand(v) + 1);
          break;
        }
        case "Decrement": {
          const v = this.toPrimitive(this.pop());
          if (v === THROWN_SENTINEL) continue;
          this.push(toNumericOperand(v) - 1);
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
        case "ThrowConstAssign": {
          const name = constants[instr.operand!] as string;
          const err = new TypeError(`Assignment to constant variable '${name}'`);
          if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
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
            if (fn.isAsync && fn.isGenerator) {
              this.push(this.createAsyncGeneratorObject(fn, locals, closureBoxes));
            } else if (fn.isAsync) {
              // Async: JIT (JSPI) を試みる
              const __jc = (fn as { __jitCached?: unknown }).__jitCached;
              if (this.feedback && __jc === undefined) this.feedback.recordCall(fn, args);
              // VM 行き確定 (__jc === null) なら tryCall もクロージャ値の map() も払わない
              if (this.jit && __jc !== null) {
                const jitResult = this.jit.tryCall(fn, args, closureBoxes.map(b => b.value), undefined, closureBoxes);
                if (jitResult !== null) { this.push(jitResult.result); break; }
              }
              // JIT 不可 → VM で実行
              const asyncPromise = this.runAsyncFunction(fn, locals, closureBoxes);
              this.push(asyncPromise);
            } else if (fn.isGenerator) {
              const genObj = this.createGeneratorObject(fn, locals, closureBoxes);
              this.push(genObj);
            } else {
              const __jc = (fn as { __jitCached?: unknown }).__jitCached;
              if (this.feedback && __jc === undefined) this.feedback.recordCall(fn, args);
              // VM 行き確定 (__jc === null) なら tryCall もクロージャ値の map() も払わない
              if (this.jit && __jc !== null) {
                const upvalueValues = closureBoxes.map(b => b.value);
                const jitResult = this.jit.tryCall(fn, args, upvalueValues, undefined, closureBoxes);
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
            if (fn.isAsync && fn.isGenerator) {
              this.push(this.createAsyncGeneratorObject(fn, locals, closure.capturedBoxes, thisObj));
            } else if (fn.isAsync) {
              const __jc = (fn as { __jitCached?: unknown }).__jitCached;
              if (this.feedback && __jc === undefined) this.feedback.recordCall(fn, args);
              // VM 行き確定 (__jc === null) なら tryCall もクロージャ値の map() も払わない
              if (this.jit && __jc !== null) {
                const jitResult = this.jit.tryCall(fn, args, closure.capturedBoxes.map(b => b.value), thisObj, closure.capturedBoxes);
                if (jitResult !== null) { this.push(jitResult.result); break; }
              }
              const asyncPromise = this.runAsyncFunction(fn, locals, closure.capturedBoxes, thisObj);
              this.push(asyncPromise);
            } else if (fn.isGenerator) {
              const genObj = this.createGeneratorObject(fn, locals, closure.capturedBoxes);
              this.push(genObj);
            } else {
              const __jc = (fn as { __jitCached?: unknown }).__jitCached;
              if (this.feedback && __jc === undefined) this.feedback.recordCall(fn, args);
              // VM 行き確定 (__jc === null) なら tryCall もクロージャ値の map() も払わない
              if (this.jit && __jc !== null) {
                const jitResult = this.jit.tryCall(fn, args, closure.capturedBoxes.map(b => b.value), thisObj, closure.capturedBoxes);
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
            if (fn.isAsync && fn.isGenerator) {
              this.push(this.createAsyncGeneratorObject(fn, locals, [], thisObj));
            } else if (fn.isAsync) {
              const __jc = (fn as { __jitCached?: unknown }).__jitCached;
              if (this.feedback && __jc === undefined) this.feedback.recordCall(fn, args);
              // VM 行き確定 (__jc === null) なら tryCall もクロージャ値の map() も払わない
              if (this.jit && __jc !== null) {
                const jitResult = this.jit.tryCall(fn, args, [], thisObj);
                if (jitResult !== null) { this.push(jitResult.result); break; }
              }
              const asyncPromise = this.runAsyncFunction(fn, locals, [], thisObj);
              this.push(asyncPromise);
            } else if (fn.isGenerator) {
              const genObj = this.createGeneratorObject(fn, locals, []);
              this.push(genObj);
            } else {
              const __jc = (fn as { __jitCached?: unknown }).__jitCached;
              if (this.feedback && __jc === undefined) this.feedback.recordCall(fn, args);
              // VM 行き確定 (__jc === null) なら tryCall もクロージャ値の map() も払わない
              if (this.jit && __jc !== null) {
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
          // prototype が未設定なら作成 (closure は中の func が prototype を持つ)
          const protoSrc = ctorFuncOf(ctor);
          if (protoSrc && protoSrc.bytecode && !protoSrc.prototype) {
            const proto = this.heap.allocate(createJSObject());
            jsObjSet(proto, "__proto__", this.objectPrototype);
            jsObjSet(proto, "constructor", protoSrc);
            setPropAttrs(proto, "constructor", { writable: true, enumerable: false, configurable: true });
            protoSrc.prototype = proto;
          }
          const newObj = this.heap.allocate(createJSObject());
          this.maybeGC();
          if (protoSrc && protoSrc.prototype) {
            jsObjSet(newObj, "__proto__", protoSrc.prototype);
          }
          if (ctor.__nativeConstructor && !ctor.bytecode) {
            // ネイティブコンストラクタ (Error 等)。bytecode を持つ場合は
            // native の派生クラス (class E extends Error) なので bytecode 側で
            // 実行する (__nativeConstructor は setPrototypeOf の静的継承で
            // 親から見えてしまうため own の bytecode を優先)
            if (ctor.name === "Error") {
              this.push({ message: args[0] ?? "" });
            } else {
              throw new Error(`Unknown native constructor: ${ctor.name}`);
            }
          } else if (ctor.bytecode) {
            // インスタンスフィールドは ctor バイトコードの prologue が
            // this.k = expr として初期化する (リテラル限定だった AST 解釈を廃止)
            // BytecodeFunction
            const locals = new Array(ctor.localCount).fill(undefined);
            if (ctor.hasRestParam) {
              // rest param (派生クラスのデフォルト ctor の引数転送等)
              const restIdx = ctor.paramCount - 1;
              for (let i = 0; i < restIdx; i++) locals[i] = i < args.length ? args[i] : undefined;
              locals[restIdx] = args.slice(restIdx);
            } else {
              for (let i = 0; i < ctor.paramCount; i++) {
                locals[i] = i < args.length ? args[i] : undefined;
              }
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

        // class 継承 (Phase 39)
        case "ClassLink": {
          // stack: [child, parent] → pop parent, peek child (child は残す)
          const parentValue = this.pop() as any;
          const childValue = this.peek() as any;
          if (parentValue === null || parentValue === undefined) break; // class C extends null
          // closure 包み (外側変数をキャプチャした class) は中の func が
          // prototype/タグの実体
          const parent = ctorFuncOf(parentValue);
          const child = ctorFuncOf(childValue);
          // prototype チェーン: child.prototype (host object) → parent.prototype。
          // GetProperty の host フォールバックが host proto チェーンを辿るので
          // メソッド継承はこのリンクだけで効く (parent が host Error 等でも同様)
          const parentProto = parent.prototype;
          if (child.prototype && parentProto && typeof parentProto === "object") {
            Object.setPrototypeOf(child.prototype, parentProto);
          }
          // 静的側: child (BytecodeFunction = host object) の proto を parent に。
          // finish() が全内部フィールドを own prop で持つのでシャドウは安全
          if (typeof parent === "object" || typeof parent === "function") {
            try { Object.setPrototypeOf(child, parent); } catch { /* host 制約 */ }
          }
          // __superClass は super() の呼び出し対象なので closure 値のまま保持
          // (closure の capturedBoxes を失うと親 ctor の upvalue 読みが壊れる)。
          // prototype 解決 (__homeProto) は func 側から
          child.__superClass = parentValue;
          child.__homeProto = parentProto; // ctor 内の super.m 用
          // メソッドに super 解決情報をタグ付け (super()/super.m 用)。
          // instance メソッド → parent.prototype、static メソッド → parent
          const INTERNAL_KEYS = new Set(["name", "length", "paramCount", "localCount", "hasRestParam", "isGenerator", "isAsync", "paramShapes",
            "bytecode", "constants", "handlers", "icSlotCount", "upvalues", "__jitCached",
            "prototype", "__instanceFields", "__superClass", "__homeProto"]);
          const tagFns = (holder: unknown, home: unknown) => {
            if (!holder || typeof holder !== "object") return;
            for (const key of Object.getOwnPropertyNames(holder)) {
              if (INTERNAL_KEYS.has(key)) continue;
              // descriptor 経由で読む — getter を発火させない。host object に
              // accessor descriptor で定義された getter を `holder[key]` で読むと
              // this=prototype で getter 本体が走り、未初期化フィールド参照で throw
              const desc = Object.getOwnPropertyDescriptor(holder, key);
              const raw = desc && "value" in desc ? desc.value : undefined;
              // 外側変数を参照するメソッドは closure 化される → 中の func にタグ付け。
              // closure オブジェクト自身にも付けておく (呼び出し経路で両方見られる)
              const v = ctorFuncOf(raw);
              if (v && typeof v === "object" && "bytecode" in v) {
                v.__superClass = parentValue;
                v.__homeProto = home;
                if (raw !== v) { (raw as any).__superClass = parentValue; (raw as any).__homeProto = home; }
              }
            }
          };
          tagFns(child.prototype, parentProto);
          tagFns(child, parent);
          break;
        }
        case "CallSuper":
        case "CallSuperArray": {
          let superArgs: unknown[];
          if (instr.op === "CallSuperArray") {
            const arr = this.pop();
            superArgs = Array.isArray(arr) ? arr : [];
          } else {
            const argc = instr.operand!;
            superArgs = new Array(argc);
            for (let i = argc - 1; i >= 0; i--) superArgs[i] = this.pop();
          }
          const parentCtor = (frame.func as any).__superClass;
          if (!parentCtor) {
            const err = new SyntaxError("'super' keyword unexpected here");
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
            break;
          }
          const self = frame.thisValue;
          if (parentCtor.__nativeConstructor && !parentCtor.bytecode) {
            // jsmini の native コンストラクタ (Error): Construct の native 分岐と
            // 同じプロパティを this に与える
            if (parentCtor.name === "Error" && isJSObject(self)) {
              jsObjSet(self, "message", superArgs[0] ?? "");
            }
            this.push(undefined);
            break;
          }
          if (typeof parentCtor === "function") {
            // host コンストラクタ: 一時インスタンスを作って own props を this にコピー
            try {
              const tmp = new (parentCtor as new (...a: unknown[]) => object)(...superArgs);
              if (tmp && typeof tmp === "object" && isJSObject(self)) {
                for (const k of Object.getOwnPropertyNames(tmp)) {
                  jsObjSet(self, k, (tmp as Record<string, unknown>)[k]);
                }
              }
            } catch (e) {
              if (!this.unwindToHandler(e, this._runBaseFrameCount)) throw e;
              break;
            }
            this.push(undefined);
            break;
          }
          // 親の instance fields は親 ctor の prologue が初期化する
          const superResult = this.callFunction(parentCtor, self, superArgs);
          if (superResult === THROWN_SENTINEL) continue;
          this.push(undefined);
          break;
        }
        case "GetSuperProp": {
          const name = constants[instr.operand!] as string;
          const fn = frame.func as any;
          const home = fn.__homeProto ?? fn.__superClass?.prototype;
          if (!home) {
            const err = new SyntaxError("'super' keyword unexpected here");
            if (!this.unwindToHandler(err, this._runBaseFrameCount)) throw err;
            break;
          }
          const val = isJSObject(home) ? jsObjGet(home, name) : (home as Record<string, unknown>)[name];
          this.push(val);
          break;
        }

        // spread 呼び出し (Phase 39): 引数配列 + callFunction による同期実行。
        // Call/CallMethod のホットパス (JIT profiling 等) は通らないが、
        // spread 呼び出しは頻度が低いので許容
        case "CallSpread": {
          const callee = this.pop();
          const arr = this.pop();
          const args = Array.isArray(arr) ? arr : [];
          try {
            const result = this.callFunction(callee, undefined, args);
            if (result === THROWN_SENTINEL) continue;
            this.push(result);
          } catch (e) {
            if (!this.unwindToHandler(e, this._runBaseFrameCount)) throw e;
          }
          break;
        }
        case "CallMethodSpread": {
          const method = this.pop();
          const obj = this.pop();
          const arr = this.pop();
          const args = Array.isArray(arr) ? arr : [];
          try {
            const result = this.callFunction(method, obj, args);
            if (result === THROWN_SENTINEL) continue;
            this.push(result);
          } catch (e) {
            if (!this.unwindToHandler(e, this._runBaseFrameCount)) throw e;
          }
          break;
        }
        case "ConstructSpread": {
          const ctor = this.pop() as any;
          const arr = this.pop();
          const args = Array.isArray(arr) ? arr : [];
          try {
            if (ctor && typeof ctor === "object" && ctor.__nativeConstructor && !ctor.bytecode) {
              // native コンストラクタ (Error)
              this.push(ctor.name === "Error" ? { message: args[0] ?? "" } : (() => { throw new Error(`Unknown native constructor: ${ctor.name}`); })());
              break;
            }
            if (typeof ctor === "function") {
              this.push(new (ctor as new (...a: unknown[]) => object)(...args));
              break;
            }
            // BytecodeFunction / closure: Construct と同じ流儀で newObj を作り同期実行
            const target = (ctor && typeof ctor === "object" && "__closure" in ctor) ? (ctor as any).func : ctor;
            if (!target || typeof target !== "object" || !("bytecode" in target)) {
              throw new TypeError("Not a constructor");
            }
            if (!target.prototype) {
              const proto = this.heap.allocate(createJSObject());
              jsObjSet(proto, "__proto__", this.objectPrototype);
              jsObjSet(proto, "constructor", target);
              setPropAttrs(proto, "constructor", { writable: true, enumerable: false, configurable: true });
              target.prototype = proto;
            }
            const newObj = this.heap.allocate(createJSObject());
            this.maybeGC();
            jsObjSet(newObj, "__proto__", target.prototype);
            // instance fields は ctor prologue が初期化する
            const result = this.callFunction(ctor, newObj, args);
            if (result === THROWN_SENTINEL) continue;
            this.push(typeof result === "object" && result !== null ? result : newObj);
          } catch (e) {
            if (!this.unwindToHandler(e, this._runBaseFrameCount)) throw e;
          }
          break;
        }
        case "CopyDataProps": {
          // {...src}: src の own enumerable props を target (peek) にコピー。
          // null/undefined/プリミティブは no-op (spec 準拠)
          const src = this.pop();
          const target = this.peek();
          if (src === null || src === undefined || !isJSObject(target)) break;
          if (isJSString(src)) {
            const s = jsStringToString(src);
            for (let i = 0; i < s.length; i++) jsObjSet(target, String(i), internString(s[i]));
          } else if (Array.isArray(src)) {
            for (let i = 0; i < src.length; i++) jsObjSet(target, String(i), src[i]);
          } else if (isJSObject(src)) {
            let unwound = false;
            for (const [k] of getHiddenClass(src).properties) {
              if (k === "__proto__") continue;
              if (getPropAttrs(src, k)?.enumerable === false) continue; // non-enumerable は spread 対象外
              const v = jsObjGet(src, k);
              if (isAccessorDescriptor(v)) {
                const gv = v.get ? this.callGetterSetter(v.get, src, undefined) : undefined;
                if (gv === THROWN_SENTINEL) { unwound = true; break; }
                jsObjSet(target, k, gv);
              } else {
                jsObjSet(target, k, v);
              }
            }
            if (unwound) break;
          } else if (typeof src === "object") {
            for (const k of Object.keys(src)) jsObjSet(target, k, (src as Record<string, unknown>)[k]);
          }
          break;
        }

        // Return
        case "Return": {
          let returnValue = this.pop();
          // 型フィードバック: 戻り値の型を記録 (JIT の運命が未決定の間だけ。
          // 決定後も毎 Return で Map 引き + classifyType すると
          // プロファイリング常駐コストがベンチ全体を数%遅くする)
          if (this.feedback && (frame.func as { __jitCached?: unknown }).__jitCached === undefined) {
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
          throw new YieldSignal(value, "await");
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
