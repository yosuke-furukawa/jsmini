import type { BytecodeFunction } from "../vm/bytecode.js";
import { WasmBuilder, WASM_OP, WASM_TYPE, f64ToBytes, i32ToLEB128 } from "./wasm-builder.js";
import { detectArrayLocals } from "./array-analysis.js";

type SpecializationType = "i32" | "f64";

// 単一関数をコンパイル (後方互換)
export async function compileToWasm(
  func: BytecodeFunction,
  spec?: SpecializationType,
): Promise<((...args: number[]) => number) | null> {
  const result = compileToWasmSync(func, spec);
  return result;
}

// 単一関数をコンパイル (同期版)
export function compileToWasmSync(
  func: BytecodeFunction,
  spec?: SpecializationType,
): ((...args: number[]) => number) | null {
  const result = compileMultiSync([func], spec);
  if (!result) return null;
  return result.get(func.name) ?? null;
}

// 複数関数を 1 つの Wasm モジュールにコンパイル
export function compileMultiSync(
  funcs: BytecodeFunction[],
  spec?: SpecializationType,
): Map<string, (...args: number[]) => number> | null {
  const t = spec ?? "f64";
  const wasmType = t === "i32" ? WASM_TYPE.i32 : WASM_TYPE.f64;

  // 関数名 → インデックスのマッピング
  const funcIndex = new Map<string, number>();
  for (let i = 0; i < funcs.length; i++) {
    funcIndex.set(funcs[i].name, i);
  }

  // 配列ローカルの検出
  let anyArrayLocals = false;
  const arrayLocalsByFunc = new Map<string, Set<number>>();
  for (const func of funcs) {
    const als = detectArrayLocals(func);
    arrayLocalsByFunc.set(func.name, als);
    if (als.size > 0) anyArrayLocals = true;
  }

  // オブジェクトプロパティの検出
  let anyObjectProps = false;
  for (const func of funcs) {
    if (func.bytecode.some(i => i.op === "LoadThis" || i.op === "SetPropertyAssign")) {
      anyObjectProps = true;
      break;
    }
  }

  // Construct または CreateArray がある場合、bump allocator 用の heap pointer global が必要
  const anyConstruct = funcs.some(f => f.bytecode.some(i => i.op === "Construct" || (i.op === "CreateArray" && i.operand === 0)));

  const builder = new WasmBuilder();
  if (anyArrayLocals || anyObjectProps || anyConstruct) builder.enableMemory(1);
  // heap pointer global (global index 0): bump allocator の次の空きアドレス
  let heapPtrGlobal = -1;
  if (anyConstruct) {
    heapPtrGlobal = builder.addGlobal(WASM_TYPE.i32, true, 0);
  }

  for (const func of funcs) {
    const arrayLocals = arrayLocalsByFunc.get(func.name) ?? new Set();
    // オブジェクトプロパティのオフセット収集
    const objectPropOffsets = new Map<string, number>();
    let propCounter = 0;
    // 自身 + 関連関数 (Construct で呼ばれるコンストラクタ等) のプロパティを収集
    const propsFromFuncs = [func, ...funcs.filter(f => f !== func)];
    for (const pf of propsFromFuncs) {
      for (let ii = 0; ii < pf.bytecode.length; ii++) {
        const instr = pf.bytecode[ii];
        if ((instr.op === "GetProperty" || instr.op === "SetPropertyAssign") && instr.operand !== undefined) {
          if (instr.op === "GetProperty" && ii + 1 < pf.bytecode.length && pf.bytecode[ii + 1].op === "CallMethod") continue;
          const name = pf.constants[instr.operand] as string;
          if (name !== "length" && !objectPropOffsets.has(name)) {
            objectPropOffsets.set(name, propCounter++);
          }
        }
      }
    }
    const hasThis = func.bytecode.some(i => i.op === "LoadThis");
    // インライン候補: funcIndex に含まれる全関数
    const inlineCandidates = new Map<string, BytecodeFunction>();
    for (const f of funcs) inlineCandidates.set(f.name, f);
    const ctx: TranslateContext = {
      spec: t, isI32: t === "i32", wasmType, funcIndex,
      arrayLocals, hasMemory: anyArrayLocals || anyObjectProps,
      objectPropOffsets, hasThis,
      heapPtrGlobal,
      objectSize: objectPropOffsets.size * 4,
      inlineCandidates,
      inlineLocalOffset: 0,
      stringLocals: new Set(),
    };
    // hasThis な関数は this を追加パラメータ、upvalue も追加パラメータとして渡す
    const upvalueCount = func.upvalues?.length ?? 0;
    const paramCount = func.paramCount + (hasThis ? 1 : 0) + upvalueCount;
    const params = new Array(paramCount).fill(wasmType);
    const results = [wasmType];
    let extraLocals = func.localCount - func.paramCount;
    const needsTempLocal = func.bytecode.some(i => i.op === "SetPropertyComputed");
    const needsObjTemp = func.bytecode.some(i => i.op === "SetPropertyAssign");
    if (needsTempLocal) extraLocals++;
    if (needsObjTemp) extraLocals += 2;
    // インライン展開用の extra locals (コールバック引数退避)
    // LdaLocal + Call パターンがあればインライン引数の最大数分を追加
    let maxInlineArgs = 0;
    for (let i = 1; i < func.bytecode.length; i++) {
      if (func.bytecode[i].op === "Call" && func.bytecode[i - 1].op === "LdaLocal") {
        const argc = func.bytecode[i].operand!;
        if (argc > maxInlineArgs) maxInlineArgs = argc;
      }
      // CallMethod のインライン用: args + this (1個)
      if (func.bytecode[i].op === "CallMethod" && i >= 2 && func.bytecode[i - 1].op === "GetProperty" && func.bytecode[i - 2].op === "Dup") {
        const argc = func.bytecode[i].operand! + 1; // +1 for this
        if (argc > maxInlineArgs) maxInlineArgs = argc;
      }
    }
    extraLocals += maxInlineArgs;
    // Dup 用 temp local (+1)
    if (func.bytecode.some(i => i.op === "Dup")) extraLocals = Math.max(extraLocals, 1);
    const body = translateBytecode(func, ctx);
    if (!body) return null;
    builder.addFunction(func.name, params, results, body, extraLocals > 0 ? extraLocals : 0);
  }

  try {
    const bytes = builder.build();
    const mod = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(mod);
    const result = new Map<string, (...args: number[]) => number>();
    for (const func of funcs) {
      result.set(func.name, instance.exports[func.name] as (...args: number[]) => number);
    }
    // memory を export に含める
    if ((anyArrayLocals || anyObjectProps || anyConstruct) && instance.exports.memory) {
      (result as any).__memory = instance.exports.memory;
    }
    if (anyConstruct && instance.exports.__global_0) {
      (result as any).__heapPtr = instance.exports.__global_0;
    }
    return result;
  } catch {
    return null;
  }
}

// BytecodeFunction を WAT (WebAssembly Text Format) に変換
// 単一関数の WAT 変換 (関連関数も含めて変換)
export function disassembleToWat(func: BytecodeFunction, spec?: SpecializationType, allFuncs?: BytecodeFunction[]): string | null {
  const t = spec ?? "i32";
  const wasmType = t === "i32" ? WASM_TYPE.i32 : WASM_TYPE.f64;
  const typeName = t === "i32" ? "i32" : "f64";

  // 全関数の funcIndex を構築
  const funcs = allFuncs ?? [func];
  const funcIndex = new Map<string, number>();
  for (let i = 0; i < funcs.length; i++) {
    funcIndex.set(funcs[i].name, i);
  }

  const arrayLocals = detectArrayLocals(func);
  let hasMemory = arrayLocals.size > 0;
  if (!hasMemory && allFuncs) {
    hasMemory = allFuncs.some(f => detectArrayLocals(f).size > 0);
  }
  const objectPropOffsets = new Map<string, number>();
  let propCounter = 0;
  for (const instr of func.bytecode) {
    if ((instr.op === "GetProperty" || instr.op === "SetPropertyAssign") && instr.operand !== undefined) {
      const name = func.constants[instr.operand] as string;
      if (name !== "length" && !objectPropOffsets.has(name)) objectPropOffsets.set(name, propCounter++);
    }
  }
  const hasThis = func.bytecode.some(i => i.op === "LoadThis");
  if (objectPropOffsets.size > 0 || hasThis) hasMemory = true;
  const needsHeap = func.bytecode.some(i => i.op === "Construct" || (i.op === "CreateArray" && i.operand === 0));
  if (needsHeap) hasMemory = true;
  const inlineCandidates = new Map<string, BytecodeFunction>();
  if (allFuncs) for (const f of allFuncs) inlineCandidates.set(f.name, f);
  const ctx: TranslateContext = { spec: t, isI32: t === "i32", wasmType, funcIndex, arrayLocals, hasMemory, objectPropOffsets, hasThis, heapPtrGlobal: needsHeap ? 0 : -1, objectSize: objectPropOffsets.size * 4, inlineCandidates, inlineLocalOffset: 0, stringLocals: new Set() };

  const body = translateBytecode(func, ctx);
  if (!body) return null;

  // body (end 含む) を WAT テキストに変換
  const lines: string[] = [];
  const params = new Array(func.paramCount).fill(typeName).map((t, i) => `(param $p${i} ${t})`).join(" ");
  const locals = func.localCount - func.paramCount;
  const localDecls = locals > 0
    ? "\n" + Array.from({ length: locals }, (_, i) => `  (local $l${func.paramCount + i} ${typeName})`).join("\n")
    : "";

  lines.push(`(module`);
  lines.push(`  (func $${func.name} (export "${func.name}") ${params} (result ${typeName})${localDecls}`);

  let indent = 4;
  const pad = () => " ".repeat(indent);

  for (let i = 0; i < body.length; i++) {
    const op = body[i];
    switch (op) {
      case WASM_OP.local_get:
        lines.push(`${pad()}local.get ${body[++i]}`);
        break;
      case WASM_OP.local_set:
        lines.push(`${pad()}local.set ${body[++i]}`);
        break;
      case 0x22: // local.tee
        lines.push(`${pad()}local.tee ${body[++i]}`);
        break;
      case WASM_OP.i32_const: {
        const { value, bytesRead } = decodeLEB128Signed(body, i + 1);
        lines.push(`${pad()}i32.const ${value}`);
        i += bytesRead;
        break;
      }
      case WASM_OP.f64_const: {
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        for (let j = 0; j < 8; j++) view.setUint8(j, body[i + 1 + j]);
        const val = view.getFloat64(0, true);
        lines.push(`${pad()}f64.const ${val}`);
        i += 8;
        break;
      }
      case WASM_OP.i32_add: lines.push(`${pad()}i32.add`); break;
      case WASM_OP.i32_sub: lines.push(`${pad()}i32.sub`); break;
      case WASM_OP.i32_mul: lines.push(`${pad()}i32.mul`); break;
      case WASM_OP.i32_div_s: lines.push(`${pad()}i32.div_s`); break;
      case WASM_OP.i32_rem_s: lines.push(`${pad()}i32.rem_s`); break;
      case WASM_OP.i32_load:
        lines.push(`${pad()}i32.load align=${1 << body[++i]} offset=${body[++i]}`);
        break;
      case WASM_OP.i32_store:
        lines.push(`${pad()}i32.store align=${1 << body[++i]} offset=${body[++i]}`);
        break;
      case WASM_OP.i32_lt_s: lines.push(`${pad()}i32.lt_s`); break;
      case WASM_OP.i32_gt_s: lines.push(`${pad()}i32.gt_s`); break;
      case WASM_OP.i32_le_s: lines.push(`${pad()}i32.le_s`); break;
      case WASM_OP.i32_ge_s: lines.push(`${pad()}i32.ge_s`); break;
      case WASM_OP.i32_eqz: lines.push(`${pad()}i32.eqz`); break;
      case 0x46: lines.push(`${pad()}i32.eq`); break;
      case 0x47: lines.push(`${pad()}i32.ne`); break;
      case WASM_OP.f64_add: lines.push(`${pad()}f64.add`); break;
      case WASM_OP.f64_sub: lines.push(`${pad()}f64.sub`); break;
      case WASM_OP.f64_mul: lines.push(`${pad()}f64.mul`); break;
      case WASM_OP.f64_div: lines.push(`${pad()}f64.div`); break;
      case WASM_OP.f64_lt: lines.push(`${pad()}f64.lt`); break;
      case WASM_OP.f64_gt: lines.push(`${pad()}f64.gt`); break;
      case WASM_OP.f64_le: lines.push(`${pad()}f64.le`); break;
      case WASM_OP.f64_ge: lines.push(`${pad()}f64.ge`); break;
      case WASM_OP.f64_neg: lines.push(`${pad()}f64.neg`); break;
      case WASM_OP.call:
        lines.push(`${pad()}call ${body[++i]}`);
        break;
      case WASM_OP.return: lines.push(`${pad()}return`); break;
      case WASM_OP.drop: lines.push(`${pad()}drop`); break;
      case WASM_OP.if:
        lines.push(`${pad()}if`);
        i++; // block type byte
        indent += 2;
        break;
      case WASM_OP.else:
        indent -= 2;
        lines.push(`${pad()}else`);
        indent += 2;
        break;
      case WASM_OP.block:
        lines.push(`${pad()}block`);
        i++; // block type byte
        indent += 2;
        break;
      case WASM_OP.loop:
        lines.push(`${pad()}loop`);
        i++; // block type byte
        indent += 2;
        break;
      case WASM_OP.br:
        lines.push(`${pad()}br ${body[++i]}`);
        break;
      case WASM_OP.br_if:
        lines.push(`${pad()}br_if ${body[++i]}`);
        break;
      case WASM_OP.end:
        indent -= 2;
        if (indent < 4) indent = 4;
        lines.push(`${pad()}end`);
        break;
      default:
        lines.push(`${pad()};; unknown opcode 0x${op.toString(16)}`);
    }
  }
  lines.push(`  )`);
  lines.push(`)`);
  return lines.join("\n");
}

// LEB128 符号付きデコード
function decodeLEB128Signed(buf: number[], offset: number): { value: number; bytesRead: number } {
  let result = 0;
  let shift = 0;
  let byte: number;
  let pos = offset;
  do {
    byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  if (shift < 32 && (byte & 0x40)) {
    result |= -(1 << shift);
  }
  return { value: result, bytesRead: pos - offset };
}

type TranslateContext = {
  spec: SpecializationType;
  isI32: boolean;
  wasmType: number;
  funcIndex: Map<string, number>;
  arrayLocals: Set<number>;
  hasMemory: boolean;
  objectPropOffsets: Map<string, number>;
  hasThis: boolean;
  heapPtrGlobal: number;
  objectSize: number;
  inlineCandidates: Map<string, BytecodeFunction>;
  inlineLocalOffset: number;
  stringLocals: Set<number>;  // 文字列引数のローカル (offset, len のペアで 2 local 消費)
};

// jsmini バイトコード → Wasm 命令列に変換
function translateBytecode(func: BytecodeFunction, ctx: TranslateContext): number[] | null {
  const out: number[] = [];
  const result = translateRange(func, 0, func.bytecode.length, ctx, out);
  if (!result) return null;
  out.push(WASM_OP.end);
  return out;
}

// バイトコード範囲 [start, end) を Wasm に変換
function translateRange(
  func: BytecodeFunction,
  start: number,
  end: number,
  ctx: TranslateContext,
  out: number[],
): boolean {
  const { bytecode, constants } = func;
  const { isI32, funcIndex } = ctx;

  for (let pc = start; pc < end; pc++) {
    const instr = bytecode[pc];
    switch (instr.op) {
      case "LdaLocal":
        out.push(WASM_OP.local_get, instr.operand!);
        break;
      case "LdaUpvalue":
        // upvalue は通常パラメータの後に追加パラメータとして渡される
        // local index = func.paramCount + (hasThis ? 1 : 0) + upvalue index
        out.push(WASM_OP.local_get, func.paramCount + (ctx.hasThis ? 1 : 0) + instr.operand!);
        break;
      case "StaUpvalue":
        out.push(WASM_OP.local_set, func.paramCount + (ctx.hasThis ? 1 : 0) + instr.operand!);
        break;
      case "StaLocal":
        // jsmini の StaLocal は値をスタックに残す (peek)
        // Wasm の local.set は値を消費する
        // → local.tee を使って値を残す (後続の Pop で drop)
        out.push(0x22, instr.operand!); // local.tee
        break;
      case "LdaConst": {
        const val = constants[instr.operand!];
        // BytecodeFunction (クロージャ参照) → ダミー値 (インライン展開で消える)
        if (typeof val === "object" && val !== null && "bytecode" in val) {
          out.push(WASM_OP.i32_const, ...i32ToLEB128(0));
          break;
        }
        if (typeof val !== "number") return false;
        if (isI32) {
          out.push(WASM_OP.i32_const, ...i32ToLEB128(val | 0));
        } else {
          out.push(WASM_OP.f64_const, ...f64ToBytes(val));
        }
        break;
      }
      case "LdaTrue":
        if (!isI32) return false;
        out.push(WASM_OP.i32_const, ...i32ToLEB128(1));
        break;
      case "LdaFalse":
        if (!isI32) return false;
        out.push(WASM_OP.i32_const, ...i32ToLEB128(0));
        break;

      // 算術
      case "Add": out.push(isI32 ? WASM_OP.i32_add : WASM_OP.f64_add); break;
      case "Sub": out.push(isI32 ? WASM_OP.i32_sub : WASM_OP.f64_sub); break;
      case "Mul": out.push(isI32 ? WASM_OP.i32_mul : WASM_OP.f64_mul); break;
      case "Div": out.push(isI32 ? WASM_OP.i32_div_s : WASM_OP.f64_div); break;
      case "Mod":
        if (isI32) { out.push(WASM_OP.i32_rem_s); }
        else return false;
        break;
      case "Negate":
        if (isI32) return false;
        out.push(WASM_OP.f64_neg);
        break;
      case "Increment":
        if (isI32) { out.push(WASM_OP.i32_const, ...i32ToLEB128(1), WASM_OP.i32_add); }
        else { out.push(WASM_OP.f64_const, ...f64ToBytes(1), WASM_OP.f64_add); }
        break;
      case "Decrement":
        if (isI32) { out.push(WASM_OP.i32_const, ...i32ToLEB128(1), WASM_OP.i32_sub); }
        else { out.push(WASM_OP.f64_const, ...f64ToBytes(1), WASM_OP.f64_sub); }
        break;

      // 比較
      case "LessThan": out.push(isI32 ? WASM_OP.i32_lt_s : WASM_OP.f64_lt); break;
      case "GreaterThan": out.push(isI32 ? WASM_OP.i32_gt_s : WASM_OP.f64_gt); break;
      case "LessEqual": out.push(isI32 ? WASM_OP.i32_le_s : WASM_OP.f64_le); break;
      case "GreaterEqual": out.push(isI32 ? WASM_OP.i32_ge_s : WASM_OP.f64_ge); break;
      case "Equal":
      case "StrictEqual":
        if (isI32) { out.push(0x46); } // i32.eq
        else return false;
        break;
      case "NotEqual":
      case "StrictNotEqual":
        if (isI32) { out.push(0x47); } // i32.ne
        else return false;
        break;

      // 配列アクセス (linear memory 経由)
      case "GetPropertyComputed": {
        if (!ctx.hasMemory) return false;
        // メモリレイアウト: [length: i32][elem0: i32][elem1: i32]...
        // スタック: [base_addr, index] → i32.load(base + 4 + index * 4)
        if (isI32) {
          out.push(WASM_OP.i32_const, ...i32ToLEB128(4));
          out.push(WASM_OP.i32_mul);   // idx * 4
          out.push(WASM_OP.i32_add);   // base + idx * 4
          out.push(WASM_OP.i32_const, ...i32ToLEB128(4));
          out.push(WASM_OP.i32_add);   // + 4 (length ヘッダ分)
          out.push(WASM_OP.i32_load, 0x02, 0x00); // align=4, offset=0
        } else return false;
        break;
      }

      case "SetPropertyComputed": {
        if (!ctx.hasMemory) return false;
        // スタック: [base_addr, index, value]
        // → i32.store(base + index * 4, value)
        // Wasm の i32.store は [addr, value] を取る
        // スタック上: base, idx, val → addr を計算してから store
        // 一旦 value を temp local に退避する必要がある
        // → 呼び出し側で temp local を確保済みと仮定
        // 簡易実装: StaLocal で value を退避してから store
        // ただし temp local が必要...
        // 別アプローチ: コンパイラが SetPropertyComputed を見たとき
        // 直前のスタック構造を追跡して変換する
        //
        // swap のバイトコード:
        //   LdaLocal 0 (arr)    → base
        //   LdaLocal 2 (j)      → idx
        //   LdaLocal 3 (tmp)    → value
        //   SetPropertyComputed
        //
        // 必要な Wasm: base + idx * 4 のアドレスを計算、value を store
        // スタック: [base, idx, value]
        // → [base, idx*4] → [base+idx*4] → [base+idx*4, value] → store
        // しかし value は idx の上にある → 入れ替えが必要
        //
        // 回避策: value を取り出して、addr を計算して、store
        // Wasm にはスタック操作がないので local.tee を使う
        //
        // extraLocal を 1 つ確保して一時退避に使う:
        if (isI32) {
          // メモリレイアウト: [length: i32][elem0: i32][elem1: i32]...
          // スタック: [base, idx, value]
          // value を一時退避 (extraLocal の最後のスロット)
          const tempLocal = func.localCount; // 追加の temp local
          out.push(0x22, tempLocal);   // local.tee tempLocal (value を保存 + スタックに残す)
          out.push(WASM_OP.drop);      // value を消す → [base, idx]
          out.push(WASM_OP.i32_const, ...i32ToLEB128(4));
          out.push(WASM_OP.i32_mul);   // idx * 4 → [base, idx*4]
          out.push(WASM_OP.i32_add);   // base + idx*4 → [addr]
          out.push(WASM_OP.i32_const, ...i32ToLEB128(4));
          out.push(WASM_OP.i32_add);   // + 4 (length ヘッダ分) → [addr+4]
          out.push(WASM_OP.local_get, tempLocal); // value を復元 → [addr, value]
          out.push(WASM_OP.i32_store, 0x02, 0x00); // store → []
          // SetPropertyComputed は value をスタックに残すので push
          out.push(WASM_OP.local_get, tempLocal); // → [value]
        } else return false;
        break;
      }

      case "GetProperty": {
        const name = constants[instr.operand!] as string;
        // GetProperty + CallMethod パターン → CallMethod 側でインライン展開する
        // GetProperty はメソッド参照を push するが、インライン展開では不要
        // Dup で this が複製されてるので、ここでは method ref として dummy (0) を push
        if (pc + 1 < bytecode.length && bytecode[pc + 1].op === "CallMethod" && pc > 0 && bytecode[pc - 1].op === "Dup") {
          // VM では GetProperty が obj を pop する。Wasm でも同様に drop して dummy を push
          out.push(WASM_OP.drop);            // pop obj (Dup の2つ目を消費)
          out.push(WASM_OP.i32_const, 0x00); // dummy method ref (CallMethod で drop される)
          break;
        }
        if (name === "length" && ctx.hasMemory) {
          // 配列の length
          out.push(WASM_OP.i32_load, 0x02, 0x00);
          break;
        }
        // オブジェクトプロパティ: base + propOffset * 4
        const propOffset = ctx.objectPropOffsets.get(name);
        if (propOffset !== undefined && ctx.hasMemory && isI32) {
          const byteOffset = propOffset * 4;
          if (byteOffset > 0) {
            out.push(WASM_OP.i32_const, ...i32ToLEB128(byteOffset));
            out.push(WASM_OP.i32_add);
          }
          out.push(WASM_OP.i32_load, 0x02, 0x00);
          break;
        }
        return false;
      }

      case "SetPropertyAssign": {
        // this.x = value: スタック [value, base]
        const name = constants[instr.operand!] as string;
        const propOffset = ctx.objectPropOffsets.get(name);
        if (propOffset !== undefined && ctx.hasMemory && isI32) {
          const tempBase = func.localCount;
          const tempVal = func.localCount + 1;
          out.push(0x22, tempBase);    // local.tee tempBase (base)
          out.push(WASM_OP.drop);
          out.push(0x22, tempVal);     // local.tee tempVal (value)
          out.push(WASM_OP.drop);
          // addr = base + offset
          out.push(WASM_OP.local_get, tempBase);
          const byteOffset = propOffset * 4;
          if (byteOffset > 0) {
            out.push(WASM_OP.i32_const, ...i32ToLEB128(byteOffset));
            out.push(WASM_OP.i32_add);
          }
          out.push(WASM_OP.local_get, tempVal);
          out.push(WASM_OP.i32_store, 0x02, 0x00);
          // push value (代入式の値)
          out.push(WASM_OP.local_get, tempVal);
          break;
        }
        return false;
      }

      case "CreateArray": {
        const count = instr.operand!;
        if (count === 0 && ctx.heapPtrGlobal >= 0 && isI32) {
          // 空配列: bump allocate で領域確保
          // メモリレイアウト: [length=0][... 後で SetPropertyComputed で埋める]
          // length ヘッダだけ確保して base address を push
          out.push(WASM_OP.global_get, ctx.heapPtrGlobal);
          // length = 0 を書く
          out.push(WASM_OP.global_get, ctx.heapPtrGlobal);
          out.push(WASM_OP.i32_const, ...i32ToLEB128(0));
          out.push(WASM_OP.i32_store, 0x02, 0x00);
          // heap ptr を進める (length ヘッダ 4 bytes + 要素は SetPropertyComputed で書く)
          // 最大要素数を予測するのは難しいので、十分な領域を確保
          // → 1024 要素分 = 4100 bytes (4 + 1024*4)
          out.push(WASM_OP.global_get, ctx.heapPtrGlobal);
          out.push(WASM_OP.i32_const, ...i32ToLEB128(4 + 1024 * 4));
          out.push(WASM_OP.i32_add);
          out.push(WASM_OP.global_set, ctx.heapPtrGlobal);
          break;
        }
        return false;
      }

      case "LoadThis": {
        if (ctx.hasThis) {
          // this は paramCount 番目の追加パラメータ
          out.push(WASM_OP.local_get, func.paramCount);
          break;
        }
        return false;
      }

      // 条件分岐
      case "JumpIfFalse": {
        const target = instr.operand!;

        // パターン 1: ループ
        // JumpIfFalse がループ脱出で、target の直前に Jump(後方) がある
        // bytecode: [loopStart] ... test JumpIfFalse(exit) ... body ... Jump(loopStart) [exit]
        const lastBeforeTarget = target > 0 ? bytecode[target - 1] : null;
        if (lastBeforeTarget && lastBeforeTarget.op === "Jump" && lastBeforeTarget.operand! <= pc) {
          const loopStart = lastBeforeTarget.operand!;
          // 条件は既にスタック上にある (外側の translateRange が処理した)
          // これを drop して、ループ内で条件を再評価する
          out.push(WASM_OP.drop);

          // Wasm: block $exit { loop $loop { 条件; eqz; br_if $exit; body; 条件; eqz; br_if $exit; br $loop } }
          out.push(WASM_OP.block, 0x40);  // block $exit (void)
          out.push(WASM_OP.loop, 0x40);   // loop $loop (void)

          // ループ条件を評価: loopStart ～ JumpIfFalse の直前
          if (!translateRange(func, loopStart, pc, ctx, out)) return false;
          out.push(WASM_OP.i32_eqz);
          out.push(WASM_OP.br_if, 0x01);  // br_if $exit (条件 false なら脱出)

          // ループ本体: JumpIfFalse の次 ～ Jump の手前
          if (!translateRange(func, pc + 1, target - 1, ctx, out)) return false;

          out.push(WASM_OP.br, 0x00);    // br $loop (continue)
          out.push(WASM_OP.end);          // end loop
          out.push(WASM_OP.end);          // end block
          pc = target - 1; // for の pc++ で target へ
          break;
        }

        // パターン 2: if-then-return
        const trueBlock = bytecode.slice(pc + 1, target);
        const hasReturn = trueBlock.some(i => i.op === "Return");
        if (hasReturn) {
          out.push(WASM_OP.if, 0x40);
          if (!translateRange(func, pc + 1, target, ctx, out)) return false;
          out.push(WASM_OP.end);
          pc = target - 1;
          break;
        }

        // パターン 3: if-else (target に Jump がある)
        if (target < bytecode.length && bytecode[target].op === "Jump") {
          const elseEnd = bytecode[target].operand!;
          out.push(WASM_OP.if, 0x40);
          if (!translateRange(func, pc + 1, target, ctx, out)) return false;
          out.push(WASM_OP.else);
          if (!translateRange(func, target + 1, elseEnd, ctx, out)) return false;
          out.push(WASM_OP.end);
          pc = elseEnd - 1;
          break;
        }

        // パターン 4: if (void) — else なし、return なし、ループでもない
        // 単純な条件付き実行ブロック
        {
          out.push(WASM_OP.if, 0x40);
          if (!translateRange(func, pc + 1, target, ctx, out)) return false;
          out.push(WASM_OP.end);
          pc = target - 1;
          break;
        }
      }

      // Jump: ループの br は JumpIfFalse のループパターンで処理済み
      case "Jump":
        // 後方ジャンプはループパターンで、前方は if/else で処理されるべき
        return false;

      // 関数呼び出し
      case "LdaGlobal": {
        const name = constants[instr.operand!] as string;
        // 次の命令が Call/Construct で、呼び出し先が既知の関数なら skip
        if (typeof name === "string" && pc + 1 < bytecode.length) {
          const nextOp = bytecode[pc + 1].op;
          if ((nextOp === "Call" || nextOp === "Construct") && funcIndex.has(name)) {
            break; // skip — Call/Construct で処理
          }
        }
        return false;
      }

      case "Call": {
        const argc = instr.operand!;
        // パターン 1: LdaGlobal + Call → Wasm 内の関数呼び出し
        if (pc > 0 && bytecode[pc - 1].op === "LdaGlobal") {
          const name = constants[bytecode[pc - 1].operand!] as string;
          const idx = funcIndex.get(name);
          if (idx !== undefined) {
            out.push(WASM_OP.call, idx);
            break;
          }
        }
        // パターン 2: LdaLocal + Call → コールバック関数のインライン展開
        if (pc > 0 && bytecode[pc - 1].op === "LdaLocal") {
          // LdaLocal は既にスタックに fn を push しているが、fn は関数参照で Wasm に持てない
          // → fn を drop して、インライン候補から本体を展開
          const calleeName = bytecode[pc - 1].op === "LdaLocal" ? null : null;
          // inlineCandidates から paramCount が一致する関数を探す
          let inlineTarget: BytecodeFunction | null = null;
          for (const [name, candidate] of ctx.inlineCandidates) {
            if (candidate.paramCount === argc && candidate !== func) {
              // コールバックらしい関数を優先: 本体が短く、配列/ループがない
              const hasLoop = candidate.bytecode.some(i => i.op === "Jump" || i.op === "JumpIfFalse");
              if (!hasLoop) {
                inlineTarget = candidate;
                break;
              }
            }
          }
          if (inlineTarget && isI32) {
            // LdaLocal が push した fn 参照を drop
            out.push(WASM_OP.drop);
            // スタック上の引数 N 個を extra local に退避
            // スタック: [arg0, arg1, ..., argN-1] (argN-1 が top)
            const baseLocal = func.localCount + (func.bytecode.some(i => i.op === "SetPropertyComputed") ? 1 : 0) + (func.bytecode.some(i => i.op === "SetPropertyAssign") ? 2 : 0);
            for (let i = argc - 1; i >= 0; i--) {
              out.push(WASM_OP.local_set, baseLocal + i);
            }
            // インライン対象の本体を展開
            // LdaLocal K → local.get (baseLocal + K)
            const inlineBytecode = inlineTarget.bytecode;
            for (let j = 0; j < inlineBytecode.length; j++) {
              const ii = inlineBytecode[j];
              if (ii.op === "LdaLocal") {
                out.push(WASM_OP.local_get, baseLocal + ii.operand!);
              } else if (ii.op === "LdaUpvalue") {
                // 1 段クロージャ: upvalue は親関数のローカル変数
                // upvalue の parentSlot が親の locals のどこかを指す
                const uvInfo = inlineTarget.upvalues?.[ii.operand!];
                if (uvInfo && uvInfo.parentSlot >= 0) {
                  // 親関数 (= 今コンパイル中の func) の local を参照
                  out.push(WASM_OP.local_get, uvInfo.parentSlot);
                } else {
                  return false; // 多段 or 解決不能
                }
              } else if (ii.op === "StaUpvalue") {
                const uvInfo = inlineTarget.upvalues?.[ii.operand!];
                if (uvInfo && uvInfo.parentSlot >= 0) {
                  out.push(WASM_OP.local_set, uvInfo.parentSlot);
                } else {
                  return false;
                }
              } else if (ii.op === "Return") {
                break;
              } else {
                const saved = { ...ctx, inlineLocalOffset: baseLocal };
                if (!translateRange(inlineTarget, j, j + 1, saved, out)) return false;
              }
            }
            break;
          }
        }
        return false;
      }

      // prototype メソッドのインライン展開
      // パターン: Dup + GetProperty "method" + CallMethod N
      // → Dup で this がスタックトップに複製されている
      // → GetProperty の結果 (method ref) を drop して this を使ってインライン展開
      case "CallMethod": {
        const argc = instr.operand!;
        // 直前が GetProperty であること (method 取得)
        if (pc >= 2 && bytecode[pc - 1].op === "GetProperty" && bytecode[pc - 2].op === "Dup") {
          const methodName = constants[bytecode[pc - 1].operand!] as string;
          // inlineCandidates からメソッドを探す
          let inlineTarget: BytecodeFunction | null = null;
          for (const [name, candidate] of ctx.inlineCandidates) {
            if (candidate.name === methodName && candidate.paramCount === argc) {
              const hasLoop = candidate.bytecode.some(i => i.op === "Jump" || i.op === "JumpIfFalse");
              if (!hasLoop) { inlineTarget = candidate; break; }
            }
          }
          if (inlineTarget && isI32 && ctx.hasMemory) {
            // スタック: [..., args..., thisObj(Dup), methodRef(GetProperty)]
            // methodRef を drop
            out.push(WASM_OP.drop);

            // thisObj を extra local に退避
            const extraBase = func.localCount + (func.bytecode.some(i => i.op === "SetPropertyComputed") ? 1 : 0) + (func.bytecode.some(i => i.op === "SetPropertyAssign") ? 2 : 0);
            const thisLocal = extraBase + argc; // 引数の後に this
            // 引数を退避 (引数が this より先にスタックにあるので先に this を退避)
            out.push(WASM_OP.local_set, thisLocal);
            for (let i = argc - 1; i >= 0; i--) {
              out.push(WASM_OP.local_set, extraBase + i);
            }

            // dist の本体を展開
            // プロパティオフセットを dist の constants から構築
            const methodPropOffsets = new Map<string, number>();
            let propIdx = 0;
            for (const ii of inlineTarget.bytecode) {
              if (ii.op === "GetProperty" && ii.operand !== undefined) {
                const pname = inlineTarget.constants[ii.operand] as string;
                if (!methodPropOffsets.has(pname)) methodPropOffsets.set(pname, propIdx++);
              }
            }

            for (let j = 0; j < inlineTarget.bytecode.length; j++) {
              const ii = inlineTarget.bytecode[j];
              if (ii.op === "LoadThis") {
                // this → extra local から取得
                out.push(WASM_OP.local_get, thisLocal);
              } else if (ii.op === "GetProperty") {
                // this.x → i32.load(thisBase + propOffset * 4)
                const pname = inlineTarget.constants[ii.operand!] as string;
                // propOffset は caller (外側の関数) の objectPropOffsets を使う
                const off = ctx.objectPropOffsets.get(pname);
                if (off !== undefined) {
                  const byteOff = off * 4;
                  if (byteOff > 0) {
                    out.push(WASM_OP.i32_const, ...i32ToLEB128(byteOff));
                    out.push(WASM_OP.i32_add);
                  }
                  out.push(WASM_OP.i32_load, 0x02, 0x00);
                } else {
                  return false;
                }
              } else if (ii.op === "LdaLocal") {
                out.push(WASM_OP.local_get, extraBase + ii.operand!);
              } else if (ii.op === "Return") {
                break;
              } else {
                // 通常の命令はそのまま変換
                const saved = { ...ctx, inlineLocalOffset: extraBase };
                if (!translateRange(inlineTarget, j, j + 1, saved, out)) return false;
              }
            }
            break;
          }
        }
        return false;
      }

      case "Construct": {
        // new Vec(arg0, arg1): スタック [arg0, arg1, ctorRef]
        // ctorRef は LdaGlobal で push された — skip 済み (LdaGlobal ハンドラで)
        // bump allocate: base = heapPtr; heapPtr += objectSize
        if (ctx.heapPtrGlobal >= 0 && ctx.objectSize > 0 && isI32) {
          const argc = instr.operand!;
          // constructor を funcIndex から探す
          let ctorName: string | null = null;
          let needDrop = false;
          if (pc > 0) {
            const prev = bytecode[pc - 1];
            if (prev.op === "LdaGlobal") {
              ctorName = constants[prev.operand!] as string;
              needDrop = !funcIndex.has(ctorName);
            } else if (prev.op === "LdaLocal" || prev.op === "LdaUpvalue") {
              if (prev.op === "LdaUpvalue" && func.upvalues?.[prev.operand!]) {
                ctorName = func.upvalues[prev.operand!].name;
              } else {
                for (const c of constants) {
                  if (c && typeof c === "object" && "bytecode" in (c as any)) ctorName = (c as any).name;
                }
              }
              needDrop = true;
            }
          }
          if (ctorName) {
            const idx = funcIndex.get(ctorName);
            if (idx !== undefined) {
              // スタック: [arg0, arg1, ctorRef?]
              if (needDrop) out.push(WASM_OP.drop); // ctorRef を除去
              // スタック: [arg0, arg1]

              // bump allocate: base = heapPtr; heapPtr += objectSize
              out.push(WASM_OP.global_get, ctx.heapPtrGlobal); // [arg0, arg1, base]
              out.push(WASM_OP.global_get, ctx.heapPtrGlobal);
              out.push(WASM_OP.i32_const, ...i32ToLEB128(ctx.objectSize));
              out.push(WASM_OP.i32_add);
              out.push(WASM_OP.global_set, ctx.heapPtrGlobal);

              // call $ctor(arg0, arg1, base)
              out.push(WASM_OP.call, idx);
              out.push(WASM_OP.drop); // ctor return value (undefined) を捨てる
              // base address を結果として残す
              out.push(WASM_OP.global_get, ctx.heapPtrGlobal);
              out.push(WASM_OP.i32_const, ...i32ToLEB128(ctx.objectSize));
              out.push(WASM_OP.i32_sub);
              break;
            }
          }
        }
        return false;
      }

      case "Return":
        out.push(WASM_OP.return);
        break;
      case "LdaUndefined":
        if (isI32) { out.push(WASM_OP.i32_const, 0x00); }
        else { out.push(WASM_OP.f64_const, ...f64ToBytes(0)); }
        break;
      case "Pop":
        out.push(WASM_OP.drop);
        break;
      case "Dup": {
        // Wasm に dup 命令はない → temp local に保存して2回 get
        // Dup + GetProperty + CallMethod パターンの場合は後続で処理される
        // 汎用的に: extra local の最後を temp として使う
        const tempLocal = func.localCount + (func.bytecode.some(i => i.op === "SetPropertyComputed") ? 1 : 0) + (func.bytecode.some(i => i.op === "SetPropertyAssign") ? 2 : 0);
        out.push(WASM_OP.local_tee, tempLocal);
        out.push(WASM_OP.local_get, tempLocal);
        break;
      }
      default:
        return false;
    }
  }
  return true;
}
