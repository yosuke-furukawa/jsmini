import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { ChildRunner } from "./pool.js";
import { detectDivergence } from "./runner.js";

describe("ChildRunner - 常駐子プロセス実行", () => {
  const runner = new ChildRunner(3000);
  after(() => runner.dispose());

  it("通常ケースは ok で EngineResult を返す", async () => {
    const r = await runner.run("let s=0; for(let i=0;i<5;i++){ s+=i; } s;");
    assert.equal(r.status, "ok");
    if (r.status === "ok") {
      assert.equal(r.results.length, 3);
      assert.equal(detectDivergence("x", r.results), null);
    }
  });

  it("hang はタイムアウトで検出し、その後も実行を継続できる (再起動)", async () => {
    const shortRunner = new ChildRunner(800);
    const hang = await shortRunner.run("while (true) {}");
    assert.equal(hang.status, "timeout");
    assert.ok(shortRunner.respawns >= 1);
    // 再起動後も動くこと
    const after = await shortRunner.run("6 * 7;");
    assert.equal(after.status, "ok");
    shortRunner.dispose();
  });

  it("throw も ok として EngineResult に載る", async () => {
    const r = await runner.run("throw new TypeError('x');");
    assert.equal(r.status, "ok");
    if (r.status === "ok") assert.equal(detectDivergence("x", r.results), null);
  });

  it("連続実行が壊れない (10 ケース)", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await runner.run(`(${i} + 1);`);
      assert.equal(r.status, "ok");
    }
  });
});
