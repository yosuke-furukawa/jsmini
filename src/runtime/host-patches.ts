// host JS の built-in prototype に jsmini 固有の boundary 変換を一度だけ
// パッチ。JSString / BytecodeFunction を unwrap してから host に渡す。
// vm/index.ts と interpreter/evaluator.ts の両方から import される (idempotent)。

import { isJSString, jsStringToString, internString, internMatchResult } from "../vm/js-string.js";

const PATCHED = Symbol.for("jsmini.host-patches.applied");

if (!(globalThis as any)[PATCHED]) {
  (globalThis as any)[PATCHED] = true;

  // RegExp.prototype.test / exec: JSString 引数を string に unwrap。
  //
  // exec の結果整形は「呼び出し元」で分岐する:
  // - 引数が JSString = jsmini コードからの呼び出し → 要素 / input / groups を
  //   internString した配列に整形して返す (test262 の `__executed[0] === "..."` は
  //   JSString の intern 同一性で比較されるため、host string のままだと false)
  // - 引数が host string = host 内部からの呼び出し (String.prototype.replace が
  //   RegExp.prototype[Symbol.replace] 経由で exec を呼ぶ等) → raw のまま返す。
  //   ここで JSString を混ぜると host engine の置換ロジックが壊れる (Phase 28 で判明)
  const origTest = RegExp.prototype.test;
  const origExec = RegExp.prototype.exec;
  RegExp.prototype.test = function(this: RegExp, s: unknown) {
    return origTest.call(this, isJSString(s) ? jsStringToString(s) : String(s));
  } as any;
  RegExp.prototype.exec = function(this: RegExp, s: unknown) {
    if (!isJSString(s)) return origExec.call(this, String(s));
    const result = origExec.call(this, jsStringToString(s));
    if (result === null) return null;
    return internMatchResult(result); // 要素/input/groups を intern (index 等は保持)
  } as any;

  // Object.prototype.hasOwnProperty: JSString 引数を string に変換
  const origHasOwn = Object.prototype.hasOwnProperty;
  Object.prototype.hasOwnProperty = function(this: object, key: unknown) {
    return origHasOwn.call(this, isJSString(key) ? jsStringToString(key) : key as PropertyKey);
  } as any;

  // Map.prototype.forEach / Set.prototype.forEach: BytecodeFunction を wrap する側は
  // VM 側で動的に必要なので、wrap helper を渡せる仕組みは vm/index.ts 側に残す。
  // ここではそのフックを後付けできる形で。
}
