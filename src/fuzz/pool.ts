// child.ts を常駐させ、1 ケースずつ実行する。hang はタイムアウトで
// kill→再起動、プロセスクラッシュ (レスポンス前に exit) はそれ自体を検出する。

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { EngineResult } from "./runner.js";

const CHILD = fileURLToPath(new URL("./child.ts", import.meta.url));

export type RunResult =
  | { status: "ok"; results: EngineResult[] }
  | { status: "timeout" } // hang: いずれかのエンジンが停止しない
  | { status: "crash"; info: string } // 子プロセスがレスポンス前に落ちた
  | { status: "harness-error"; info: string };

export class ChildRunner {
  private cp!: ChildProcess;
  private rl!: Interface;
  private ready!: Promise<void>;
  private pending: ((r: RunResult) => void) | null = null;
  private buf = ""; // 未処理の stdout 行 (crash 時の診断用)
  respawns = 0;

  constructor(private timeoutMs = 2000) {
    this.spawn();
  }

  private spawn(): void {
    this.cp = spawn(process.execPath, ["--import", "tsx", CHILD], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.cp.stdin!.on("error", () => {}); // 死んだ子への write の EPIPE を無視
    let stderr = "";
    this.cp.stderr!.on("data", (d) => { stderr += d.toString(); });
    this.rl = createInterface({ input: this.cp.stdout! });

    let markReady!: () => void;
    this.ready = new Promise((res) => { markReady = res; });
    this.rl.on("line", (line) => {
      if (line.trim() === "READY") { markReady(); return; }
      this.buf = line;
      const p = this.pending;
      if (p) { this.pending = null; p(this.parse(line)); }
    });
    // 子が予期せず exit → 実行中ケースがクラッシュ扱い
    this.cp.on("exit", (code, signal) => {
      const p = this.pending;
      if (p) {
        this.pending = null;
        p({ status: "crash", info: `child exited code=${code} signal=${signal} stderr=${stderr.slice(0, 500)}` });
      }
    });
  }

  private parse(line: string): RunResult {
    try {
      const obj = JSON.parse(line);
      if (obj.ok) return { status: "ok", results: obj.results as EngineResult[] };
      return { status: "harness-error", info: String(obj.harnessError) };
    } catch {
      return { status: "harness-error", info: `unparsable response: ${line.slice(0, 200)}` };
    }
  }

  private respawn(): void {
    this.respawns++;
    try { this.cp.removeAllListeners(); this.cp.kill("SIGKILL"); } catch {}
    this.spawn();
  }

  async run(source: string): Promise<RunResult> {
    await this.ready;
    return new Promise<RunResult>((resolve) => {
      let settled = false;
      const done = (r: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        this.pending = null;
        this.respawn();
        done({ status: "timeout" });
      }, this.timeoutMs);

      this.pending = (r) => {
        // crash の場合は子が既に死んでいるので再起動が必要
        if (r.status === "crash") this.respawn();
        done(r);
      };
      try {
        this.cp.stdin!.write(Buffer.from(source, "utf8").toString("base64") + "\n");
      } catch (e) {
        this.pending = null;
        this.respawn();
        done({ status: "crash", info: `write failed: ${String(e)}` });
      }
    });
  }

  dispose(): void {
    try { this.cp.removeAllListeners(); this.cp.kill("SIGKILL"); } catch {}
  }
}
