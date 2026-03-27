import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WasmBuilder } from "./wasm-builder.js";

describe("JIT - Step 5-2: Wasm バイナリ生成", () => {
  it("add(3, 4) が Wasm 経由で 7 を返す", async () => {
    const builder = new WasmBuilder();
    // (func $add (param f64 f64) (result f64) local.get 0 local.get 1 f64.add)
    builder.addFunction("add", [0x7c, 0x7c], [0x7c], [
      0x20, 0x00, // local.get 0
      0x20, 0x01, // local.get 1
      0xa0,       // f64.add
      0x0b,       // end
    ]);
    const bytes = builder.build();
    const { instance } = await WebAssembly.instantiate(bytes);
    const add = instance.exports.add as (a: number, b: number) => number;
    assert.equal(add(3, 4), 7);
  });

  it("sub(10, 3) が Wasm 経由で 7 を返す", async () => {
    const builder = new WasmBuilder();
    builder.addFunction("sub", [0x7c, 0x7c], [0x7c], [
      0x20, 0x00, // local.get 0
      0x20, 0x01, // local.get 1
      0xa1,       // f64.sub
      0x0b,       // end
    ]);
    const bytes = builder.build();
    const { instance } = await WebAssembly.instantiate(bytes);
    const sub = instance.exports.sub as (a: number, b: number) => number;
    assert.equal(sub(10, 3), 7);
  });

  it("mul(3, 4) が Wasm 経由で 12 を返す", async () => {
    const builder = new WasmBuilder();
    builder.addFunction("mul", [0x7c, 0x7c], [0x7c], [
      0x20, 0x00,
      0x20, 0x01,
      0xa2,       // f64.mul
      0x0b,
    ]);
    const bytes = builder.build();
    const { instance } = await WebAssembly.instantiate(bytes);
    const mul = instance.exports.mul as (a: number, b: number) => number;
    assert.equal(mul(3, 4), 12);
  });

  it("生成されたバイナリが有効な Wasm モジュールである", async () => {
    const builder = new WasmBuilder();
    builder.addFunction("noop", [], [0x7c], [
      0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // f64.const 0
      0x0b,
    ]);
    const bytes = builder.build();
    const valid = await WebAssembly.validate(bytes);
    assert.equal(valid, true);
  });
});
