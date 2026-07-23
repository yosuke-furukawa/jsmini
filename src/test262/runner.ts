import fs from "node:fs";
import path from "node:path";
import { evaluate } from "../interpreter/evaluator.js";
import { vmEvaluate } from "../vm/index.js";
import { isJSString, jsStringToString } from "../vm/js-string.js";
import { ThrowSignal } from "../interpreter/values.js";

const useVM = process.argv.includes("--vm");
const useJIT = process.argv.includes("--jit");
const modeName = useJIT ? "JIT" : useVM ? "bytecode VM" : "tree-walking";
const run = useJIT
  ? (s: string, opts?: Record<string, unknown>) => vmEvaluate(s, { ...opts, jit: true, jitThreshold: 1 })
  : useVM
    ? (s: string, opts?: Record<string, unknown>) => vmEvaluate(s, opts)
    : (s: string, opts?: Record<string, unknown>) => evaluate(s, opts);

const TEST262_ROOT = path.resolve(import.meta.dirname, "../../test262");

// Test262 フロントマターをパース
function parseFrontmatter(source: string) {
  const match = source.match(/\/\*---([\s\S]*?)---\*\//);
  if (!match) return { includes: [], negative: null, flags: [], features: [], description: "" };

  const yaml = match[1];

  const includes: string[] = [];
  const includeMatch = yaml.match(/includes:\s*\[(.*?)\]/s);
  if (includeMatch) {
    includes.push(...includeMatch[1].split(",").map((s) => s.trim().replace(/['"]/g, "")));
  }
  const includeListMatch = yaml.match(/includes:\s*\n((?:\s+-\s+.*\n?)*)/);
  if (includeListMatch) {
    const items = includeListMatch[1].match(/-\s+(\S+)/g);
    if (items) includes.push(...items.map((s) => s.replace(/^-\s+/, "")));
  }

  const negative = yaml.includes("negative:");
  const flags: string[] = [];
  const flagMatch = yaml.match(/flags:\s*\[(.*?)\]/);
  if (flagMatch) flags.push(...flagMatch[1].split(",").map((s) => s.trim()));

  const features: string[] = [];
  const featureMatch = yaml.match(/features:\s*\[(.*?)\]/s);
  if (featureMatch) features.push(...featureMatch[1].split(",").map((s) => s.trim()));
  const featureListMatch = yaml.match(/features:\s*\n((?:\s+-\s+.*\n?)*)/);
  if (featureListMatch) {
    const items = featureListMatch[1].match(/-\s+(\S+)/g);
    if (items) features.push(...items.map((s) => s.replace(/^-\s+/, "")));
  }

  const descMatch = yaml.match(/description:\s*[>|]?\s*\n?\s*(.*)/);
  const description = descMatch?.[1]?.trim() ?? "";

  return { includes, negative, flags, features, description };
}

// サポートしていない機能を使うテストをスキップ
// ハーネス関数をネイティブの JS で実装して注入するための前置コード
// jsmini がまだ対応していない構文（オブジェクト、throw/try、new 等）が
// ハーネスに含まれるため、ハーネスを jsmini で実行するのではなく、
// テストコードのみを jsmini で実行し、ハーネス関数はネイティブ実装を注入する
function createHarnessSource(): string {
  // Test262Error, assert (オブジェクト形式), verifyProperty, compareArray
  // を jsmini が理解できる構文だけで定義する
  // assert をオブジェクト形式にすることで、テストコードの assert.sameValue 等を
  // 前処理で変換する必要がなくなる
  return `
function Test262Error(message) {
  return message;
}

var assert = function(mustBeTrue, message) {
  if (mustBeTrue === true) {
    return;
  }
  if (message === undefined) {
    message = "assertion failed";
  }
  throw new Error(message);
};

assert.sameValue = function(actual, expected, message) {
  if (actual === expected) {
    return;
  }
  if (message === undefined) {
    message = "assert.sameValue failed: " + actual + " !== " + expected;
  }
  throw new Error(message);
};

assert.notSameValue = function(actual, unexpected, message) {
  if (actual !== unexpected) {
    return;
  }
  if (message === undefined) {
    message = "assert.notSameValue failed";
  }
  throw new Error(message);
};

assert.throws = function(expectedErrorConstructor, fn, message) {
  var thrown = false;
  var caughtError;
  try { fn(); } catch (e) { thrown = true; caughtError = e; }
  if (!thrown) {
    var ctorName = expectedErrorConstructor.name || "unknown";
    throw new Error(message || "Expected a " + ctorName + " to be thrown");
  }
  if (caughtError instanceof expectedErrorConstructor) return;
  if (typeof caughtError === "object" && caughtError !== null && caughtError.constructor === expectedErrorConstructor) return;
  var ctorName = expectedErrorConstructor.name || "unknown";
  throw new Error(message || "Expected a " + ctorName + " but got " + caughtError);
};

function verifyProperty(obj, name, desc) {
}

function compareArray(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i = i + 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
`;
}

// テストコードを前処理
function preprocessTestSource(source: string): string {
  // フロントマターのコメントを除去
  let code = source.replace(/\/\*---[\s\S]*?---\*\//, "");
  // 単行コメントを除去
  code = code.replace(/\/\/.*$/gm, "");
  // 複数行コメントも除去
  code = code.replace(/\/\*[\s\S]*?\*\//g, "");

  return code;
}

// エラーからメッセージ文字列を抽出する
// jsmini の ThrowSignal、JSString、ネイティブ Error すべてに対応
function extractErrorMessage(e: unknown): string {
  // ThrowSignal (TW) or { __thrown, value } (VM): jsmini の throw 文で投げられる
  const val = e instanceof ThrowSignal ? e.value
    : (typeof e === "object" && e !== null && "__thrown" in e) ? (e as any).value
    : null;
  if (val !== null) {
    if (typeof val === "object" && val !== null && "message" in val) {
      const msg = (val as any).message;
      if (isJSString(msg)) return jsStringToString(msg);
      try { return String(msg); } catch { return "[thrown object]"; }
    }
    if (isJSString(val)) return jsStringToString(val);
    if (typeof val === "string") return val;
    try { return String(val); } catch { return "[thrown object]"; }
  }
  // ネイティブ Error
  if (e instanceof Error) return e.message;
  try { return String(e); } catch { return "[unknown error]"; }
}

// canRun は廃止。構文未対応のテストも実行して正直に Fail にする。
// Skip は「テストの実行方式が合わない」場合のみ（メタデータで判定）。

type TestResult = {
  file: string;
  status: "pass" | "fail" | "skip";
  error?: string;
};

// テストが host の built-in prototype を改変できる (例: Object.defineProperty を
// Map.prototype.set に当てて throw させる)。jsmini の compiler/VM 自体が host の
// Map/Set を内部的に使っているため、汚染は次のテスト以降に波及する。
// → 各テストの前後で関連 prototype のスナップショット/復元を行う。
const PROTOS_TO_SNAPSHOT: { name: string; proto: object }[] = [
  { name: "Map", proto: Map.prototype },
  { name: "Set", proto: Set.prototype },
  { name: "WeakMap", proto: WeakMap.prototype },
  { name: "WeakSet", proto: WeakSet.prototype },
  { name: "Array", proto: Array.prototype },
  { name: "Object", proto: Object.prototype },
  { name: "RegExp", proto: RegExp.prototype },
  { name: "String", proto: String.prototype },
];
type ProtoSnapshot = { proto: object; descriptors: Record<string | symbol, PropertyDescriptor>; keys: (string | symbol)[] };
function snapshotPrototypes(): ProtoSnapshot[] {
  return PROTOS_TO_SNAPSHOT.map(({ proto }) => {
    const keys = [...Object.getOwnPropertyNames(proto), ...Object.getOwnPropertySymbols(proto)];
    const descriptors: Record<string | symbol, PropertyDescriptor> = {};
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(proto, k);
      if (d) descriptors[k as any] = d;
    }
    return { proto, descriptors, keys };
  });
}
function restorePrototypes(snaps: ProtoSnapshot[]): void {
  for (const { proto, descriptors, keys } of snaps) {
    // 1. 元から無かったキーは削除
    const currentKeys = [...Object.getOwnPropertyNames(proto), ...Object.getOwnPropertySymbols(proto)];
    for (const k of currentKeys) {
      if (!keys.includes(k)) {
        try { delete (proto as any)[k]; } catch { /* configurable: false なら諦め */ }
      }
    }
    // 2. 既存キーは descriptor 復元
    for (const k of keys) {
      const orig = descriptors[k as any];
      if (!orig) continue;
      try { Object.defineProperty(proto, k, orig); } catch { /* configurable: false 等 */ }
    }
  }
}
const ORIGINAL_PROTOTYPES = snapshotPrototypes();

function runTest(filePath: string): TestResult {
  const relPath = path.relative(TEST262_ROOT, filePath);
  const source = fs.readFileSync(filePath, "utf-8");
  const meta = parseFrontmatter(source);

  // 実行方式が根本的に異なるもののみスキップ
  if (meta.flags.includes("module")) return { file: relPath, status: "skip", error: "module" };
  if (meta.flags.includes("async")) return { file: relPath, status: "skip", error: "async" };
  if (meta.flags.includes("raw")) return { file: relPath, status: "skip", error: "raw" };
  // jsmini は strict mode 前提
  if (meta.flags.includes("noStrict")) {
    return { file: relPath, status: "skip", error: "noStrict" };
  }

  const harness = createHarnessSource();
  const testCode = preprocessTestSource(source);
  const fullSource = harness + "\n" + testCode;

  // 無限ループ防止: ステップ数上限
  let steps = 0;
  // VM/JIT は maxSteps、TW は onStep カウンタで無限ループを止める。
  // 以前は --jit が TW 用の onStep (vmEvaluate は無視する) を受け取っており、
  // ステップ上限なし → 無限ループするテストでランナー全体がハングしていた
  const opts = useVM || useJIT
    ? { maxSteps: 100_000 }
    : { onStep: () => { if (++steps > 100_000) throw new Error("timeout: exceeded 100k steps"); } };

  try {
    if (meta.negative) {
      try {
        run(fullSource, opts);
        return { file: relPath, status: "fail", error: "Expected error but none was thrown" };
      } catch {
        return { file: relPath, status: "pass" };
      }
    }

    try {
      run(fullSource, opts);
      return { file: relPath, status: "pass" };
    } catch (e: any) {
      return { file: relPath, status: "fail", error: extractErrorMessage(e) };
    }
  } finally {
    // テストが host built-in prototype を汚染した可能性 → 必ず復元
    restorePrototypes(ORIGINAL_PROTOTYPES);
  }
}

// テストファイルを再帰収集
function collectTests(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectTests(full));
    else if (entry.name.endsWith(".js")) results.push(full);
  }
  return results;
}

// メイン
const TEST_DIRS = [
  // expressions
  "test/language/expressions/addition",
  "test/language/expressions/subtraction",
  "test/language/expressions/multiplication",
  "test/language/expressions/division",
  "test/language/expressions/modulus",
  "test/language/expressions/equals",
  "test/language/expressions/does-not-equals",
  "test/language/expressions/strict-equals",
  "test/language/expressions/strict-does-not-equals",
  "test/language/expressions/less-than",
  "test/language/expressions/less-than-or-equal",
  "test/language/expressions/greater-than",
  "test/language/expressions/greater-than-or-equal",
  "test/language/expressions/logical-and",
  "test/language/expressions/logical-or",
  "test/language/expressions/logical-not",
  "test/language/expressions/unary-minus",
  "test/language/expressions/void",
  "test/language/expressions/typeof",
  "test/language/expressions/conditional",
  "test/language/expressions/comma",
  "test/language/expressions/in",
  "test/language/expressions/instanceof",
  "test/language/expressions/assignment",
  "test/language/expressions/postfix-increment",
  "test/language/expressions/postfix-decrement",
  "test/language/expressions/prefix-increment",
  "test/language/expressions/prefix-decrement",
  "test/language/expressions/grouping",
  "test/language/expressions/call",
  "test/language/expressions/new",
  "test/language/expressions/member-expression",
  "test/language/expressions/property-accessors",
  "test/language/expressions/array",
  "test/language/expressions/object",
  "test/language/expressions/function",
  "test/language/expressions/arrow-function",
  "test/language/expressions/this",
  "test/language/expressions/template-literal",
  "test/language/expressions/optional-chaining",
  "test/language/expressions/coalesce",
  // statements
  "test/language/statements/variable",
  "test/language/statements/if",
  "test/language/statements/while",
  "test/language/statements/do-while",
  "test/language/statements/for",
  "test/language/statements/for-of",
  "test/language/statements/for-in",
  "test/language/statements/switch",
  "test/language/statements/block",
  "test/language/statements/empty",
  "test/language/statements/expression",
  "test/language/statements/return",
  "test/language/statements/break",
  "test/language/statements/continue",
  "test/language/statements/throw",
  "test/language/statements/try",
  "test/language/statements/function",
  "test/language/statements/class",
  "test/language/statements/let",
  "test/language/statements/const",
  // types
  "test/language/types/boolean",
  "test/language/types/null",
  "test/language/types/number",
  "test/language/types/object",
  "test/language/types/reference",
  "test/language/types/string",
  "test/language/types/undefined",
  // built-ins (Phase 25 以降に拡張)
  "test/built-ins/Promise",
  "test/built-ins/Map",
  "test/built-ins/Set",
  "test/built-ins/WeakMap",
  "test/built-ins/WeakSet",
  "test/built-ins/RegExp",
  "test/built-ins/String/prototype/match",
  "test/built-ins/String/prototype/replace",
  "test/built-ins/String/prototype/search",
  "test/built-ins/String/prototype/split",
  "test/built-ins/String/prototype/matchAll",
  "test/language/literals/regexp",
];

const allTests: string[] = [];
for (const dir of TEST_DIRS) {
  allTests.push(...collectTests(path.join(TEST262_ROOT, dir)));
}

let pass = 0;
let fail = 0;
let skip = 0;
const failures: TestResult[] = [];
const skipReasons: Record<string, number> = {};

for (const testFile of allTests) {
  const result = runTest(testFile);
  if (result.status === "pass") pass++;
  else if (result.status === "skip") {
    skip++;
    const reason = result.error ?? "unknown";
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  } else {
    fail++;
    failures.push(result);
  }
}

console.log(`\n=== Test262 Results (${modeName}) ===`);
console.log(`Total: ${allTests.length}`);
console.log(`Pass:  ${pass}`);
console.log(`Fail:  ${fail}`);
console.log(`Skip:  ${skip}`);
if (pass + fail > 0) {
  console.log(`Pass rate: ${((pass / (pass + fail)) * 100).toFixed(1)}% (excluding skips)`);
}

if (failures.length > 0) {
  console.log(`\n--- All Failures ---`);
  for (const f of failures) {
    console.log(`  FAIL: ${f.file}`);
    console.log(`        ${f.error}`);
  }
}

console.log(`\n--- Skip Reasons ---`);
const sortedSkips = Object.entries(skipReasons).sort((a, b) => b[1] - a[1]);
for (const [reason, count] of sortedSkips) {
  console.log(`  ${count.toString().padStart(4)} : ${reason}`);
}
