// jsmini 差分ファザ CLI。
//
// jsmini の 3 エンジン (Tree-Walking / Bytecode VM / VM+JIT) で同じプログラムを
// 実行し、結果が食い違えば (divergence) バグ候補として報告する。Fuzzilli 流の
// 差分ファジング。本家 Fuzzilli が生成した .js コーパスの再生にも対応 (--corpus)。
//
// 使い方:
//   npm run fuzz                         # 既定 (生成 2000 件)
//   npm run fuzz -- --iterations 50000   # 件数指定
//   npm run fuzz -- --seed 12345         # ベース seed 固定 (再現用)
//   npm run fuzz -- --corpus ./corpus    # ディレクトリ内の .js を再生
//   npm run fuzz -- --repro 12345        # seed から 1 件を詳細表示
//   npm run fuzz -- --repro bug.js       # ファイルの 1 件を詳細表示
//   npm run fuzz -- --isolate            # 生成モードでも子プロセス隔離 (hang 耐性)
//   npm run fuzz -- --timeout 3000       # hang タイムアウト(ms)

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generate } from "./generator.js";
import { hashSeed } from "./prng.js";
import { runEngines, detectDivergence, type EngineResult } from "./runner.js";
import { ChildRunner, type RunResult } from "./pool.js";
import { minimize, divSignature } from "./minimize.js";
import { canonThrow } from "./normalize.js";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";

type Args = {
  iterations: number;
  seed: number;
  corpus: string | null;
  repro: string | null;
  isolate: boolean;
  timeout: number;
  out: string;
  quiet: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    iterations: 2000,
    seed: (Date.now() & 0x7fffffff) >>> 0,
    corpus: null,
    repro: null,
    isolate: false,
    timeout: 2000,
    out: "fuzz-findings",
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--iterations" || v === "-n") a.iterations = Number(argv[++i]);
    else if (v === "--seed") a.seed = Number(argv[++i]) >>> 0;
    else if (v === "--corpus") a.corpus = argv[++i];
    else if (v === "--repro") a.repro = argv[++i];
    else if (v === "--isolate") a.isolate = true;
    else if (v === "--timeout") a.timeout = Number(argv[++i]);
    else if (v === "--out") a.out = argv[++i];
    else if (v === "--quiet" || v === "-q") a.quiet = true;
  }
  return a;
}

type Finding = {
  kind: "divergence" | "timeout" | "crash" | "harness-error";
  origin: string; // seed=... or file path
  source: string;
  signature: string;
  keys?: Record<string, string>;
  info?: string;
};

// ---- 1 件の RunResult を Finding に変換 (バグでなければ null) ----
function classify(origin: string, source: string, r: RunResult): Finding | null {
  if (r.status === "timeout") {
    return { kind: "timeout", origin, source, signature: "timeout" };
  }
  if (r.status === "crash") {
    return { kind: "crash", origin, source, signature: "crash:" + crashSig(r.info), info: r.info };
  }
  if (r.status === "harness-error") {
    return { kind: "harness-error", origin, source, signature: "harness-error", info: r.info };
  }
  return classifyResults(origin, source, r.results);
}

function classifyResults(origin: string, source: string, results: EngineResult[]): Finding | null {
  const d = detectDivergence(source, results);
  if (!d) return null;
  return { kind: "divergence", origin, source, signature: divSignature(d.keys), keys: d.keys };
}

function crashSig(info: string): string {
  const m = info.match(/([A-Za-z]*Error): [^\n]{0,40}/) ?? info.match(/signal=(\w+)/);
  return m ? m[0].slice(0, 50) : "unknown";
}

// ---- 詳細表示 (--repro) ----
function reproVerbose(source: string): void {
  console.log("=== source ===");
  console.log(source);
  console.log("\n=== per-engine 実行結果 (生値・メッセージ込み) ===");
  const engines: [string, () => unknown][] = [
    ["TW ", () => evaluate(source, { log: (...x: unknown[]) => logs.push(x) })],
    ["VM ", () => vmEvaluate(source, { console: { log: (...x: unknown[]) => logs.push(x) }, maxSteps: 5_000_000 })],
    ["JIT", () => vmEvaluate(source, { console: { log: (...x: unknown[]) => logs.push(x) }, jit: true, jitThreshold: 4, maxSteps: 5_000_000 })],
  ];
  let logs: unknown[][] = [];
  for (const [name, run] of engines) {
    logs = [];
    try {
      const v = run();
      console.log(`${name} => VALUE:`, safe(v), logs.length ? `| logs=${logs.length}` : "");
    } catch (e: any) {
      const unwrapped = e?.__thrown ? e.value : (e?.constructor?.name === "ThrowSignal" ? e.value : e);
      console.log(`${name} => THROW:`, canonThrow(e), "|", String(unwrapped?.message ?? unwrapped).slice(0, 80));
    }
  }
  const results = runEngines(source);
  const d = detectDivergence(source, results);
  console.log("\n=== 判定 ===");
  console.log(d ? `DIVERGENCE  signature: ${divSignature(d.keys)}` : "一致 (差分なし)");
  if (d) for (const [e, k] of Object.entries(d.keys)) console.log(`  ${e}: ${k}`);
}

function safe(v: unknown): string {
  try { return JSON.stringify(v)?.slice(0, 120) ?? String(v); } catch { return String(v); }
}

// ---- レポート出力 ----
function report(findings: Finding[], args: Args, ran: number, elapsedMs: number): void {
  const clusters = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = clusters.get(f.signature) ?? [];
    arr.push(f);
    clusters.set(f.signature, arr);
  }
  console.log("\n" + "=".repeat(70));
  console.log(`実行: ${ran} 件 / ${(elapsedMs / 1000).toFixed(1)}s   バグ候補: ${findings.length} 件 / クラスタ ${clusters.size} 種`);
  console.log("=".repeat(70));

  if (findings.length === 0) {
    console.log("差分・hang・クラッシュは検出されませんでした。");
    return;
  }

  // クラスタを件数降順で
  const sorted = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);
  if (existsSync(args.out)) rmSync(args.out, { recursive: true, force: true });
  mkdirSync(args.out, { recursive: true });

  let idx = 0;
  const indexLines: string[] = [`# fuzz findings (${findings.length} 件 / ${clusters.size} クラスタ)`, ""];
  for (const [sig, arr] of sorted) {
    idx++;
    const rep = arr[0];
    // 生成由来なら縮小 (divergence のみ; timeout/crash は縮小しない)
    let minimized = rep.source;
    if (rep.kind === "divergence") {
      try { minimized = minimize(rep.source); } catch {}
    }
    const file = join(args.out, `cluster${String(idx).padStart(2, "0")}.js`);
    const header = [
      `// signature: ${sig}`,
      `// kind: ${rep.kind}   count: ${arr.length}`,
      `// origin: ${rep.origin}`,
      rep.keys ? `// keys: ${JSON.stringify(rep.keys)}` : "",
      rep.info ? `// info: ${rep.info.slice(0, 300)}` : "",
      "",
    ].filter(Boolean).join("\n");
    writeFileSync(file, header + minimized + "\n");

    console.log(`\n[${idx}] ${sig}   (${arr.length} 件)  ${rep.kind}`);
    console.log(`    例: ${rep.origin}  ->  ${file}`);
    if (rep.kind === "divergence") {
      const oneLine = minimized.replace(/\s+/g, " ").slice(0, 100);
      console.log(`    minimized: ${oneLine}`);
    }
    indexLines.push(`## [${idx}] ${sig} — ${arr.length} 件 (${rep.kind})`, "```js", minimized, "```", "");
  }
  writeFileSync(join(args.out, "SUMMARY.md"), indexLines.join("\n"));
  console.log(`\n詳細: ${join(args.out, "SUMMARY.md")} と cluster*.js`);
}

// ---- 実行ドライバ ----
async function runGenerative(args: Args): Promise<Finding[]> {
  const findings: Finding[] = [];
  const runner = args.isolate ? new ChildRunner(args.timeout) : null;
  const progressEvery = Math.max(1, Math.floor(args.iterations / 20));
  for (let i = 0; i < args.iterations; i++) {
    const seed = hashSeed(args.seed, i);
    const source = generate(seed);
    const origin = `seed=${args.seed} i=${i} (gen=${seed})`;
    let f: Finding | null;
    if (runner) {
      f = classify(origin, source, await runner.run(source));
    } else {
      f = classifyResults(origin, source, runEngines(source));
    }
    if (f) findings.push(f);
    if (!args.quiet && (i + 1) % progressEvery === 0) {
      process.stdout.write(`\r  ${i + 1}/${args.iterations}  findings=${findings.length}   `);
    }
  }
  if (!args.quiet) process.stdout.write("\n");
  runner?.dispose();
  return findings;
}

async function runCorpus(args: Args): Promise<Finding[]> {
  const dir = args.corpus!;
  const files = readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  console.log(`コーパス再生: ${files.length} ファイル (${dir})  ※子プロセス隔離`);
  const runner = new ChildRunner(args.timeout); // コーパスは任意 JS なので常に隔離
  const findings: Finding[] = [];
  for (let i = 0; i < files.length; i++) {
    const path = join(dir, files[i]);
    const source = readFileSync(path, "utf8");
    const f = classify(path, source, await runner.run(source));
    if (f) findings.push(f);
    if (!args.quiet && (i + 1) % Math.max(1, Math.floor(files.length / 20)) === 0) {
      process.stdout.write(`\r  ${i + 1}/${files.length}  findings=${findings.length}   `);
    }
  }
  if (!args.quiet) process.stdout.write("\n");
  runner.dispose();
  return findings;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.repro) {
    // 数値なら生成 seed として直接 generate、そうでなければファイルパスとして読む。
    const src = /^\d+$/.test(args.repro)
      ? generate(Number(args.repro))
      : readFileSync(args.repro, "utf8");
    reproVerbose(src);
    return;
  }

  const t0 = Date.now();
  const findings = args.corpus ? await runCorpus(args) : await runGenerative(args);
  const ran = args.corpus
    ? readdirSync(args.corpus).filter((f) => f.endsWith(".js")).length
    : args.iterations;
  report(findings, args, ran, Date.now() - t0);
  process.exit(findings.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
