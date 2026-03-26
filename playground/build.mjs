import * as esbuild from "esbuild";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// jsmini エンジン + CodeMirror をバンドルするエントリポイント
const entryContent = `
// jsmini engine
export { tokenize } from "../src/lexer/lexer.ts";
export { parse } from "../src/parser/parser.ts";
export { evaluate } from "../src/interpreter/evaluator.ts";

// CodeMirror
export { basicSetup } from "codemirror";
export { javascript } from "@codemirror/lang-javascript";
export { oneDark } from "@codemirror/theme-one-dark";
export { EditorView, keymap } from "@codemirror/view";
export { Prec } from "@codemirror/state";
`;
const entryPath = resolve(__dirname, "_entry.ts");
writeFileSync(entryPath, entryContent);

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: [entryPath],
  bundle: true,
  format: "iife",
  globalName: "jsmini",
  outfile: resolve(__dirname, "jsmini.bundle.js"),
  platform: "browser",
  target: ["es2020"],
  sourcemap: true,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
