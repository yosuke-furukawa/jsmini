// host JS の built-in prototype に jsmini 固有の boundary 変換を一度だけ
// パッチ。JSString / BytecodeFunction を unwrap してから host に渡す。
// vm/index.ts と interpreter/evaluator.ts の両方から import される (idempotent)。

import { isJSString, jsStringToString, internString } from "../vm/js-string.js";

const PATCHED = Symbol.for("jsmini.host-patches.applied");

if (!(globalThis as any)[PATCHED]) {
  (globalThis as any)[PATCHED] = true;

  // RegExp.prototype.test / exec: JSString 引数を string に unwrap。
  // 注意: exec の result の matched substring を JSString に intern してしまうと、
  // host String.prototype.replace が内部で exec を呼び、結果の文字列の length/index
  // を使って置換するロジックが壊れる (JSString の length は数値として取れるが、
  // host engine の C++ replace 実装が host string を期待しているため挙動がおかしくなる)。
  // → result はそのまま (host string のまま) 返す。jsmini ユーザが exec の結果を
  // 直接使う場合は host string になるが、length/charAt 等は普通に動くので実用上問題なし
  const origTest = RegExp.prototype.test;
  const origExec = RegExp.prototype.exec;
  RegExp.prototype.test = function(this: RegExp, s: unknown) {
    return origTest.call(this, isJSString(s) ? jsStringToString(s) : String(s));
  } as any;
  RegExp.prototype.exec = function(this: RegExp, s: unknown) {
    return origExec.call(this, isJSString(s) ? jsStringToString(s) : String(s));
  } as any;

  // Map.prototype.forEach / Set.prototype.forEach: BytecodeFunction を wrap する側は
  // VM 側で動的に必要なので、wrap helper を渡せる仕組みは vm/index.ts 側に残す。
  // ここではそのフックを後付けできる形で。
}
