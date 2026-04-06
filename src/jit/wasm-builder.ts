// Wasm バイナリを手で組み立てるビルダー
// https://webassembly.github.io/spec/core/binary/

// Wasm セクション ID
const SECTION_TYPE = 1;
const SECTION_FUNCTION = 3;
const SECTION_MEMORY = 5;
const SECTION_GLOBAL = 6;
const SECTION_EXPORT = 7;
const SECTION_CODE = 10;

// Wasm 型
export const WASM_TYPE = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
  func: 0x60,
  struct: 0x5f,
  array: 0x5e,
  ref: 0x64,       // ref (non-null) + heap type
  ref_null: 0x63,  // ref null + heap type
} as const;

// Wasm 命令
export const WASM_OP = {
  local_get: 0x20,
  local_set: 0x21,
  local_tee: 0x22,
  global_get: 0x23,
  global_set: 0x24,
  // i32
  i32_const: 0x41,
  i32_add: 0x6a,
  i32_sub: 0x6b,
  i32_mul: 0x6c,
  i32_div_s: 0x6d,
  i32_rem_s: 0x6f,
  i32_load: 0x28,
  i32_store: 0x36,
  f64_load: 0x2b,
  f64_store: 0x39,
  i32_eqz: 0x45,
  i32_lt_s: 0x48,
  i32_gt_s: 0x4a,
  i32_le_s: 0x4c,
  i32_ge_s: 0x4e,
  // f64
  f64_const: 0x44,
  f64_add: 0xa0,
  f64_sub: 0xa1,
  f64_mul: 0xa2,
  f64_div: 0xa3,
  f64_lt: 0x63,
  f64_gt: 0x64,
  f64_le: 0x65,
  f64_ge: 0x66,
  f64_neg: 0x9a,
  end: 0x0b,
  return: 0x0f,
  if: 0x04,
  else: 0x05,
  block: 0x02,
  loop: 0x03,
  br: 0x0c,
  br_if: 0x0d,
  call: 0x10,
  drop: 0x1a,
  // Wasm GC (0xfb prefix)
  struct_new: 0xfb,       // 0xfb 0x00 + type_idx
  struct_get: 0xfb,       // 0xfb 0x02 + type_idx + field_idx
  struct_set: 0xfb,       // 0xfb 0x05 + type_idx + field_idx
} as const;

// Wasm GC の sub-opcodes (0xfb prefix の後)
export const WASM_GC_OP = {
  struct_new: 0x00,
  struct_new_default: 0x01,
  struct_get: 0x02,
  struct_get_s: 0x03,
  struct_get_u: 0x04,
  struct_set: 0x05,
  array_new: 0x06,
  array_new_default: 0x07,
  array_new_fixed: 0x08,
  array_get: 0x0b,
  array_get_s: 0x0c,
  array_get_u: 0x0d,
  array_set: 0x0e,
  array_len: 0x0f,
} as const;

// ref 型のバイト列を生成 (params/results で使用)
export function refType(typeIdx: number, nullable = false): number[] {
  return [nullable ? 0x63 : 0x64, typeIdx];
}

type StructField = {
  type: number;    // value type (e.g. WASM_TYPE.i32)
  mutable: boolean;
};

type StructDef = {
  fields: StructField[];
};

type ArrayDef = {
  elementType: number;  // value type (e.g. WASM_TYPE.i32)
  mutable: boolean;
};

export type LocalGroup = {
  count: number;
  type: number[];  // type bytes (single byte for i32/f64, multi-byte for ref types)
};

type FuncDef = {
  name: string;
  paramCount: number;   // パラメータ数
  params: number[];     // パラメータ型のエンコード済みバイト列
  resultCount: number;  // 結果数
  results: number[];    // 結果型のエンコード済みバイト列
  body: number[];       // Wasm 命令列 (end 含む)
  extraLocals: number;  // params 以外のローカル変数の数
  extraLocalGroups?: LocalGroup[];  // 複数型の extra locals (指定時は extraLocals を無視)
};

export class WasmBuilder {
  private functions: FuncDef[] = [];
  private structs: StructDef[] = [];
  private arrays: ArrayDef[] = [];
  private memoryPages = 0;
  private globals: { type: number; mutable: boolean; initValue: number }[] = [];

  // struct 型を追加。返り値は type index (struct → array → func の順)
  addStruct(fields: StructField[]): number {
    const idx = this.structs.length;
    this.structs.push({ fields });
    return idx;
  }

  // array 型を追加。返り値は type index
  addArray(elementType: number, mutable = true): number {
    const idx = this.structs.length + this.arrays.length;
    this.arrays.push({ elementType, mutable });
    return idx;
  }

  addFunction(name: string, params: number[], results: number[], body: number[], extraLocals = 0, paramCount?: number, resultCount?: number, extraLocalGroups?: LocalGroup[]): void {
    this.functions.push({
      name,
      paramCount: paramCount ?? params.length,
      params,
      resultCount: resultCount ?? results.length,
      results,
      body,
      extraLocals,
      extraLocalGroups,
    });
  }

  enableMemory(pages = 1): void {
    this.memoryPages = pages;
  }

  // mutable global 変数を追加。返り値は global index
  addGlobal(type: number, mutable: boolean, initValue: number): number {
    const idx = this.globals.length;
    this.globals.push({ type, mutable, initValue });
    return idx;
  }

  build(): Uint8Array {
    const buf: number[] = [];

    // マジックナンバー + バージョン
    buf.push(0x00, 0x61, 0x73, 0x6d); // \0asm
    buf.push(0x01, 0x00, 0x00, 0x00); // version 1

    // Type section
    const typeSection = this.buildTypeSection();
    this.writeSection(buf, SECTION_TYPE, typeSection);

    // Function section
    const funcSection = this.buildFunctionSection();
    this.writeSection(buf, SECTION_FUNCTION, funcSection);

    // Memory section
    if (this.memoryPages > 0) {
      const memSection = this.buildMemorySection();
      this.writeSection(buf, SECTION_MEMORY, memSection);
    }

    // Global section
    if (this.globals.length > 0) {
      const globalSection = this.buildGlobalSection();
      this.writeSection(buf, SECTION_GLOBAL, globalSection);
    }

    // Export section
    const exportSection = this.buildExportSection();
    this.writeSection(buf, SECTION_EXPORT, exportSection);

    // Code section
    const codeSection = this.buildCodeSection();
    this.writeSection(buf, SECTION_CODE, codeSection);

    return new Uint8Array(buf);
  }

  private buildGlobalSection(): number[] {
    const buf: number[] = [];
    writeLEB128(buf, this.globals.length);
    for (const g of this.globals) {
      buf.push(g.type);            // value type
      buf.push(g.mutable ? 0x01 : 0x00); // mutability
      // init expr
      if (g.type === WASM_TYPE.i32) {
        buf.push(0x41); // i32.const
        const initBytes = i32ToLEB128(g.initValue);
        buf.push(...initBytes);
      } else {
        buf.push(0x41, 0x00); // fallback i32.const 0
      }
      buf.push(0x0b); // end
    }
    return buf;
  }

  private buildMemorySection(): number[] {
    const buf: number[] = [];
    writeLEB128(buf, 1); // 1 つのメモリ
    buf.push(0x00);      // limits: min のみ (max なし)
    writeLEB128(buf, this.memoryPages);
    return buf;
  }

  // composite type のオフセット (struct → array → func の順)
  get structCount(): number { return this.structs.length; }
  get arrayCount(): number { return this.arrays.length; }
  // func の type index は structs + arrays の後
  get funcTypeOffset(): number { return this.structs.length + this.arrays.length; }

  private buildTypeSection(): number[] {
    const buf: number[] = [];
    // struct + array + func の合計
    writeLEB128(buf, this.structs.length + this.arrays.length + this.functions.length);
    // struct 型 (type index 0, 1, ...)
    for (const s of this.structs) {
      buf.push(WASM_TYPE.struct);
      writeLEB128(buf, s.fields.length);
      for (const f of s.fields) {
        buf.push(f.type);
        buf.push(f.mutable ? 0x01 : 0x00);
      }
    }
    // array 型 (type index structs.length, ...)
    for (const a of this.arrays) {
      buf.push(WASM_TYPE.array);
      buf.push(a.elementType);
      buf.push(a.mutable ? 0x01 : 0x00);
    }
    // func 型 (type index structs.length + arrays.length, ...)
    for (const fn of this.functions) {
      buf.push(WASM_TYPE.func);
      writeLEB128(buf, fn.paramCount);
      buf.push(...fn.params);
      writeLEB128(buf, fn.resultCount);
      buf.push(...fn.results);
    }
    return buf;
  }

  private buildFunctionSection(): number[] {
    const buf: number[] = [];
    writeLEB128(buf, this.functions.length);
    for (let i = 0; i < this.functions.length; i++) {
      writeLEB128(buf, this.funcTypeOffset + i); // type index
    }
    return buf;
  }

  private buildExportSection(): number[] {
    const buf: number[] = [];
    const exportCount = this.functions.length + (this.memoryPages > 0 ? 1 : 0) + this.globals.length;
    writeLEB128(buf, exportCount);
    for (let i = 0; i < this.functions.length; i++) {
      const name = this.functions[i].name;
      const nameBytes = new TextEncoder().encode(name);
      writeLEB128(buf, nameBytes.length);
      buf.push(...nameBytes);
      buf.push(0x00); // export kind = func
      writeLEB128(buf, i); // func index
    }
    // Memory export
    if (this.memoryPages > 0) {
      const memName = new TextEncoder().encode("memory");
      writeLEB128(buf, memName.length);
      buf.push(...memName);
      buf.push(0x02); // export kind = memory
      writeLEB128(buf, 0); // memory index = 0
    }
    // Global exports
    for (let i = 0; i < this.globals.length; i++) {
      const gName = new TextEncoder().encode(`__global_${i}`);
      writeLEB128(buf, gName.length);
      buf.push(...gName);
      buf.push(0x03); // export kind = global
      writeLEB128(buf, i);
    }
    return buf;
  }

  private buildCodeSection(): number[] {
    const buf: number[] = [];
    writeLEB128(buf, this.functions.length);
    for (const fn of this.functions) {
      // 関数本体
      const bodyBuf: number[] = [];
      if (fn.extraLocalGroups && fn.extraLocalGroups.length > 0) {
        // 複数グループの extra locals
        writeLEB128(bodyBuf, fn.extraLocalGroups.length);
        for (const group of fn.extraLocalGroups) {
          writeLEB128(bodyBuf, group.count);
          bodyBuf.push(...group.type);
        }
      } else if (fn.extraLocals > 0) {
        // ローカル変数宣言: 1 グループ (count, type)
        bodyBuf.push(0x01); // 1 group
        writeLEB128(bodyBuf, fn.extraLocals);
        // params と同じ型 (全部同一型)
        bodyBuf.push(fn.params.length > 0 ? fn.params[0] : WASM_TYPE.i32);
      } else {
        bodyBuf.push(0x00); // local declarations count = 0
      }
      bodyBuf.push(...fn.body);
      // body size
      writeLEB128(buf, bodyBuf.length);
      buf.push(...bodyBuf);
    }
    return buf;
  }

  private writeSection(buf: number[], id: number, content: number[]): void {
    buf.push(id);
    writeLEB128(buf, content.length);
    buf.push(...content);
  }
}

// LEB128 可変長整数エンコード (符号なし)
function writeLEB128(buf: number[], value: number): void {
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    buf.push(byte);
  } while (value !== 0);
}

// i32 を LEB128 符号付きで変換 (Wasm の i32.const 用)
export function i32ToLEB128(value: number): number[] {
  const buf: number[] = [];
  let v = value | 0;
  let more = true;
  while (more) {
    let byte = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    buf.push(byte);
  }
  return buf;
}

// f64 を little-endian バイト列に変換 (Wasm は little-endian 固定)
export function f64ToBytes(value: number): number[] {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, value, true); // true = little-endian
  return [...new Uint8Array(buf)];
}
