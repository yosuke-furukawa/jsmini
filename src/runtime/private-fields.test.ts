import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

// Phase 42: class private # の全ポジション対応の回帰テスト。
// private 名はパーサで不可視プレフィックス付きに mangle される
// (hasOwnProperty("#x") 等から観測不能になる近似)

const engines: { name: string; run: (src: string) => unknown[] }[] = [
  {
    name: "TW",
    run: (src) => {
      const logs: unknown[] = [];
      evaluate(src, { log: (...a: unknown[]) => logs.push(a.length === 1 ? a[0] : a) });
      return logs;
    },
  },
  {
    name: "VM",
    run: (src) => {
      const logs: unknown[] = [];
      vmEvaluate(src, { console: { log: (...a: unknown[]) => logs.push(a.length === 1 ? a[0] : a) } });
      return logs;
    },
  },
];

for (const { name, run } of engines) {
  describe(`class private # (${name})`, () => {
    it("private メソッド呼び出し", () => {
      assert.deepEqual(run(`
        class C { #m() { return 42; } call() { return this.#m(); } }
        console.log(new C().call());
      `), [42]);
    });

    it("static private メソッド/フィールド", () => {
      assert.deepEqual(run(`
        class C {
          static #x = 7;
          static #m() { return C.#x + 1; }
          static run() { return C.#m(); }
        }
        console.log(C.run());
      `), [8]);
    });

    it("private getter/setter", () => {
      assert.deepEqual(run(`
        class C {
          #v = 0;
          get #x() { return this.#v; }
          set #x(n) { this.#v = n; }
          run() { this.#x = 5; return this.#x; }
        }
        console.log(new C().run());
      `), [5]);
    });

    it("private generator / async generator メソッド", () => {
      assert.deepEqual(run(`
        class C {
          *#g() { yield 3; }
          async *#ag() { yield 4; }
          sync() { return this.#g().next().value; }
          async() { return this.#ag(); }
        }
        var c = new C();
        console.log(c.sync());
        c.async().next().then(function(r) { console.log(r.value); });
      `), [3, 4]);
    });

    it("#x in obj (brand check)", () => {
      assert.deepEqual(run(`
        class C { #x = 1; static has(o) { return #x in o; } }
        console.log(C.has(new C()), C.has({}));
      `), [[true, false]]);
    });

    it("private 名は外から観測できない", () => {
      assert.deepEqual(run(`
        class C { #x = 1; #m() {} }
        var c = new C();
        console.log(
          Object.prototype.hasOwnProperty.call(c, "#x"),
          Object.prototype.hasOwnProperty.call(C.prototype, "#m"),
          "#x" in c
        );
      `), [[false, false, false]]);
    });

    it("Unicode private 名とエスケープが同じキーになる", () => {
      // #\u{6F} と #o は同一。℘ など Unicode ID_Start も可
      assert.deepEqual(run(String.raw`
        class C {
          #\u{6F}_ = 1;
          #℘() { return this.#o_; }
          get() { return this.#℘(); }
        }
        console.log(new C().get());
      `), [1]);
    });

    it("Unicode の public 識別子", () => {
      assert.deepEqual(run(`
        var ℘ = 1;
        class C { ℘() { return 2; } }
        console.log(℘ + new C().℘());
      `), [3]);
    });
  });
}
