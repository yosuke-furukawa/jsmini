import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

// Phase 48: catch 句の分割パラメータ + optional catch binding

const engines: { name: string; run: (src: string) => unknown }[] = [
  { name: "TW", run: (src) => evaluate(src) },
  { name: "VM", run: (src) => vmEvaluate(src) },
];

for (const { name, run } of engines) {
  const eq = (src: string, want: unknown) => assert.equal(run(src), want, src);

  describe(`catch 句の分割パラメータ (${name})`, () => {
    it("配列パターン", () => {
      eq(`var r; try { throw [1, 2]; } catch ([a, b]) { r = a + b; } r;`, 3);
      eq(`function f() { try { throw [7]; } catch ([x]) { return x; } } f();`, 7);
    });

    it("オブジェクトパターン (デフォルト値/rest 含む)", () => {
      eq(`var r; try { throw {message: "hi"}; } catch ({message}) { r = message === "hi"; } r;`, true);
      eq(`var r; try { throw {}; } catch ({message: m = "d"}) { r = m === "d"; } r;`, true);
      eq(`var r; try { throw {a: 1, b: 2}; } catch ({a, ...rest}) { r = a + rest.b; } r;`, 3);
    });

    it("optional catch binding (catch {})", () => {
      eq(`var r = "before"; try { throw 1; } catch {} r;`, "before");
      eq(`var n = 0; try { throw 1; } catch { n = 1; } finally { n += 10; } n;`, 11);
    });

    it("null/undefined の分割は TypeError (RequireObjectCoercible)", () => {
      assert.throws(() => run(`try { throw null; } catch ({x}) {}`), TypeError);
    });

    it("catch パラメータのスコープ", () => {
      // VM は catch 変数のシャドウが未実装 (識別子 catch も同じ既知の近似) のため
      // ブロックスコープの厳密性は TW のみ検証
      if (name === "TW") {
        eq(`function f() { var a = "outer"; try { throw ["inner"]; } catch ([a]) {} return a; } f();`, "outer");
      }
      // 両エンジン: catch 内でパターン束縛が参照できる
      eq(`function f() { try { throw ["v"]; } catch ([x]) { return x === "v"; } } f();`, true);
    });
  });
}
