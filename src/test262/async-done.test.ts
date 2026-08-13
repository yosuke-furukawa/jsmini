import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

// test262 の async ランナー機構 (native $DONE 注入 + drainMicrotasks) を
// 両エンジンで検証する。runner.ts 本体は多数のテストファイルを走らせるため
// 単体では回しにくいので、機構だけをここで固定する。

type Engine = (src: string, opts: { globals: Record<string, unknown> }) => unknown;

// $DONE を注入して async スニペットを実行し、完了状態を返すヘルパ。
// run() は内部で drainMicrotasks() まで行うので、戻った時点で判定できる。
function runAsync(engine: Engine, body: string): { called: boolean; error: unknown } {
  const state = { called: false, error: undefined as unknown };
  const $DONE = (err: unknown) => {
    if (!state.called) {
      state.called = true;
      state.error = err;
    }
  };
  engine(body, { globals: { $DONE } });
  return state;
}

// TW / VM 両対応で globals を渡す薄いアダプタ
const engines: { name: string; run: Engine }[] = [
  { name: "TW", run: (src, opts) => evaluate(src, opts) },
  { name: "VM", run: (src, opts) => vmEvaluate(src, { globals: opts.globals }) },
];

for (const { name, run } of engines) {
  describe(`test262 async $DONE runner (${name})`, () => {
    it("Promise.then が解決したら $DONE() が引数なしで呼ばれる = pass", () => {
      const s = runAsync(run, `
        Promise.resolve(1).then(function() {}).then($DONE, $DONE);
      `);
      assert.equal(s.called, true);
      assert.equal(s.error, undefined);
    });

    it("async/await 完了で $DONE() = pass", () => {
      const s = runAsync(run, `
        (async function() {
          var x = await Promise.resolve(41);
          return x + 1;
        })().then(function() { $DONE(); }, $DONE);
      `);
      assert.equal(s.called, true);
      assert.equal(s.error, undefined);
    });

    it("拒否されると $DONE(error) にエラーが渡る = fail 判定", () => {
      const s = runAsync(run, `
        Promise.reject({ name: "Test262Error", message: "boom" })
          .then($DONE, $DONE);
      `);
      assert.equal(s.called, true);
      assert.notEqual(s.error, undefined);
    });

    it("$DONE が呼ばれないケースは called=false (未完了扱い)", () => {
      const s = runAsync(run, `
        var p = new Promise(function() {}); // 永久 pending
        p.then($DONE, $DONE);
      `);
      assert.equal(s.called, false);
    });

    it("二重 $DONE は最初の呼び出しだけ採用される", () => {
      const s = runAsync(run, `
        Promise.resolve().then(function() { $DONE(); $DONE({ name: "E", message: "late" }); });
      `);
      assert.equal(s.called, true);
      assert.equal(s.error, undefined);
    });
  });
}
