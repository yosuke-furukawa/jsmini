// Wasm バイナリを手で組み立てるビルダー
// https://webassembly.github.io/spec/core/binary/

// Wasm セクション ID
const SECTION_TYPE = 1;
const SECTION_FUNCTION = 3;
const SECTION_EXPORT = 7;
const SECTION_CODE = 10;

// Wasm 型
export const WASM_TYPE = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
  func: 0x60,
} as const;

// Wasm 命令
export const WASM_OP = {
  local_get: 0x20,
  local_set: 0x21,
  // i32
  i32_const: 0x41,
  i32_add: 0x6a,
  i32_sub: 0x6b,
  i32_mul: 0x6c,
  i32_div_s: 0x6d,
  i32_rem_s: 0x6f,
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
} as const;

type FuncDef = {
  name: string;
  params: number[];   // 型バイト列 (例: [0x7c, 0x7c] = f64, f64)
  results: number[];   // 型バイト列 (例: [0x7c] = f64)
  body: number[];      // Wasm 命令列 (end 含む)
};

export class WasmBuilder {
  private functions: FuncDef[] = [];

  addFunction(name: string, params: number[], results: number[], body: number[]): void {
    this.functions.push({ name, params, results, body });
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

    // Export section
    const exportSection = this.buildExportSection();
    this.writeSection(buf, SECTION_EXPORT, exportSection);

    // Code section
    const codeSection = this.buildCodeSection();
    this.writeSection(buf, SECTION_CODE, codeSection);

    return new Uint8Array(buf);
  }

  private buildTypeSection(): number[] {
    const buf: number[] = [];
    // 関数ごとに型を定義
    writeLEB128(buf, this.functions.length);
    for (const fn of this.functions) {
      buf.push(WASM_TYPE.func);
      writeLEB128(buf, fn.params.length);
      buf.push(...fn.params);
      writeLEB128(buf, fn.results.length);
      buf.push(...fn.results);
    }
    return buf;
  }

  private buildFunctionSection(): number[] {
    const buf: number[] = [];
    writeLEB128(buf, this.functions.length);
    for (let i = 0; i < this.functions.length; i++) {
      writeLEB128(buf, i); // type index
    }
    return buf;
  }

  private buildExportSection(): number[] {
    const buf: number[] = [];
    writeLEB128(buf, this.functions.length);
    for (let i = 0; i < this.functions.length; i++) {
      const name = this.functions[i].name;
      const nameBytes = new TextEncoder().encode(name);
      writeLEB128(buf, nameBytes.length);
      buf.push(...nameBytes);
      buf.push(0x00); // export kind = func
      writeLEB128(buf, i); // func index
    }
    return buf;
  }

  private buildCodeSection(): number[] {
    const buf: number[] = [];
    writeLEB128(buf, this.functions.length);
    for (const fn of this.functions) {
      // 関数本体
      const bodyBuf: number[] = [];
      bodyBuf.push(0x00); // local declarations count = 0
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
