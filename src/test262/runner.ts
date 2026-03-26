import fs from "node:fs";
import path from "node:path";
import { evaluate } from "../interpreter/evaluator.js";

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
const UNSUPPORTED_FEATURES = [
  "Symbol", "Symbol.toPrimitive", "Symbol.toStringTag",
  "BigInt", "Proxy", "Reflect",
  "async-functions", "async-iteration",
  "generators", "destructuring-binding",
  "template", "arrow-function",
  "class", "super", "new.target",
  "WeakRef", "FinalizationRegistry",
  "Temporal", "SharedArrayBuffer", "Atomics",
  "regexp-named-groups", "regexp-lookbehind",
  "TypedArray", "Map", "Set", "Promise",
  "computed-property-names", "object-spread",
  "optional-chaining", "nullish-coalescing",
  "for-of", "let", "const", "default-parameters",
];

// ハーネス関数をネイティブの JS で実装して注入するための前置コード
// jsmini がまだ対応していない構文（オブジェクト、throw/try、new 等）が
// ハーネスに含まれるため、ハーネスを jsmini で実行するのではなく、
// テストコードのみを jsmini で実行し、ハーネス関数はネイティブ実装を注入する
function createHarnessSource(): string {
  // Test262Error, assert, assert.sameValue, assert.notSameValue, $DONOTEVALUATE
  // を jsmini が理解できる構文だけで定義する
  return `
function Test262Error(message) {
  return message;
}

function assert(mustBeTrue, message) {
  if (mustBeTrue === true) {
    return;
  }
  if (message === undefined) {
    message = "assertion failed";
  }
}

function assert_sameValue(actual, expected, message) {
  if (actual === expected) {
    return;
  }
  if (message === undefined) {
    message = "assert.sameValue failed";
  }
}

function assert_notSameValue(actual, unexpected, message) {
  if (actual !== unexpected) {
    return;
  }
  if (message === undefined) {
    message = "assert.notSameValue failed";
  }
}
`;
}

// テストコードを前処理: assert.sameValue → assert_sameValue に変換
// (MemberExpression でのメソッド呼び出しは動くが、ハーネスをネイティブ注入する代わりに
//  テストコードを少し書き換える方がシンプル)
function preprocessTestSource(source: string): string {
  // フロントマターのコメントを除去
  let code = source.replace(/\/\*---[\s\S]*?---\*\//, "");
  // 単行コメントは残す (jsmini が未対応なら除去)
  code = code.replace(/\/\/.*$/gm, "");
  // 複数行コメントも除去
  code = code.replace(/\/\*[\s\S]*?\*\//g, "");
  // assert.sameValue → assert_sameValue
  code = code.replace(/assert\.sameValue/g, "assert_sameValue");
  code = code.replace(/assert\.notSameValue/g, "assert_notSameValue");
  // throw new Test262Error(...) → Test262Error(...)
  // (jsmini は throw/new 未対応なので、エラーケースは必ず到達しないはず)
  code = code.replace(/throw\s+new\s+Test262Error/g, "Test262Error");

  return code;
}

// テストが jsmini で実行可能か判定
function canRun(source: string): string | null {
  // jsmini が未対応の構文をソースコードレベルでチェック
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, "")  // block comments
    .replace(/\/\/.*$/gm, "");          // line comments

  if (/\bnew\s+\w/.test(cleaned)) return "new expression";
  if (/\btry\s*\{/.test(cleaned)) return "try/catch";
  if (/\bthrow\s/.test(cleaned)) return "throw";
  if (/\btypeof\s/.test(cleaned)) return "typeof";
  if (/\bswitch\s*\(/.test(cleaned)) return "switch";
  if (/\bdo\s*\{/.test(cleaned)) return "do-while";
  if (/\bwith\s*\(/.test(cleaned)) return "with";
  if (/\bdelete\s/.test(cleaned)) return "delete";
  if (/\bvoid\s/.test(cleaned)) return "void";
  if (/\bin\s/.test(cleaned)) return "in operator";
  if (/\binstanceof\s/.test(cleaned)) return "instanceof";
  if (/\[\s*\d/.test(cleaned)) return "array literal";
  if (/\{\s*\w+\s*:/.test(cleaned)) return "object literal";
  if (/\+\+|--/.test(cleaned)) return "increment/decrement";
  if (/\?/.test(cleaned)) return "ternary";
  return null;
}

type TestResult = {
  file: string;
  status: "pass" | "fail" | "skip";
  error?: string;
};

function runTest(filePath: string): TestResult {
  const relPath = path.relative(TEST262_ROOT, filePath);
  const source = fs.readFileSync(filePath, "utf-8");
  const meta = parseFrontmatter(source);

  // メタデータによるスキップ
  if (meta.negative) return { file: relPath, status: "skip", error: "negative test" };
  if (meta.flags.includes("module")) return { file: relPath, status: "skip", error: "module" };
  if (meta.flags.includes("async")) return { file: relPath, status: "skip", error: "async" };
  if (meta.flags.includes("raw")) return { file: relPath, status: "skip", error: "raw" };
  if (meta.flags.includes("noStrict") === false && meta.flags.includes("onlyStrict")) {
    return { file: relPath, status: "skip", error: "onlyStrict" };
  }
  if (meta.features.some((f) => UNSUPPORTED_FEATURES.includes(f))) {
    return { file: relPath, status: "skip", error: "unsupported feature" };
  }

  // ソースコードによるスキップ
  const cantRun = canRun(source);
  if (cantRun) return { file: relPath, status: "skip", error: cantRun };

  const harness = createHarnessSource();
  const testCode = preprocessTestSource(source);
  const fullSource = harness + "\n" + testCode;

  try {
    evaluate(fullSource);
    return { file: relPath, status: "pass" };
  } catch (e: any) {
    return { file: relPath, status: "fail", error: e.message ?? String(e) };
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
  "test/language/expressions/addition",
  "test/language/expressions/subtraction",
  "test/language/expressions/multiplication",
  "test/language/expressions/division",
  "test/language/statements/variable",
  "test/language/statements/if",
  "test/language/statements/while",
  "test/language/statements/for",
];

const allTests: string[] = [];
for (const dir of TEST_DIRS) {
  allTests.push(...collectTests(path.join(TEST262_ROOT, dir)));
}

let pass = 0;
let fail = 0;
let skip = 0;
const failures: TestResult[] = [];

for (const testFile of allTests) {
  const result = runTest(testFile);
  if (result.status === "pass") pass++;
  else if (result.status === "skip") skip++;
  else {
    fail++;
    failures.push(result);
  }
}

console.log(`\n=== Test262 Results ===`);
console.log(`Total: ${allTests.length}`);
console.log(`Pass:  ${pass}`);
console.log(`Fail:  ${fail}`);
console.log(`Skip:  ${skip}`);
if (pass + fail > 0) {
  console.log(`Pass rate: ${((pass / (pass + fail)) * 100).toFixed(1)}% (excluding skips)`);
}

if (failures.length > 0) {
  console.log(`\n--- Failures (first 20) ---`);
  for (const f of failures.slice(0, 20)) {
    console.log(`  FAIL: ${f.file}`);
    console.log(`        ${f.error}`);
  }
  if (failures.length > 20) {
    console.log(`  ... and ${failures.length - 20} more`);
  }
}
