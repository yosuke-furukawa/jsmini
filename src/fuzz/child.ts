// REPRL 風の常駐子プロセス。stdin から base64 ソースを 1 行受け取り、
// jsmini 各エンジンで実行して EngineResult[] を JSON 1 行で返す。
//
// 隔離目的: 生成/コーパスのプログラムが無限ループやプロセスクラッシュを
// 起こしても、親がタイムアウトで kill→再起動できるようにする (Fuzzilli の
// reset ループに相当)。

import { createInterface } from "node:readline";
import { runEngines } from "./runner.js";

process.stdout.write("READY\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let payload: string;
  try {
    const source = Buffer.from(trimmed, "base64").toString("utf8");
    const results = runEngines(source);
    payload = JSON.stringify({ ok: true, results });
  } catch (e: any) {
    // runEngines 自体が投げるのは想定外 (各エンジンは内部で catch 済み)。
    // ここに来たら子プロセス側ハーネスの異常として報告する。
    payload = JSON.stringify({ ok: false, harnessError: String(e?.stack ?? e) });
  }
  process.stdout.write(payload + "\n");
});
