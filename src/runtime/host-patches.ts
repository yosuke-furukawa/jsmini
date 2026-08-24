// host JS の built-in prototype に jsmini 固有の boundary 変換を一度だけ
// パッチ。JSString / BytecodeFunction を unwrap してから host に渡す。
// vm/index.ts と interpreter/evaluator.ts の両方から import される (idempotent)。

import { isJSString, jsStringToString, internString, internMatchResult } from "../vm/js-string.js";

const PATCHED = Symbol.for("jsmini.host-patches.applied");

// VM のクロージャ (BytecodeFunction / __closure) は host から直接呼べないため、
// 呼び出し方を VM 側から登録してもらう (vmEvaluate 初期化時。promise.ts の
// setHandlerCaller と同じパターン)。TW の JSFunction は汎用ラップで host callable
// になって届くのでこのフックは不要。
// フックはグローバル共有 (Symbol.for) — 本モジュールは PATCHED ガードで最初の
// 1 インスタンスしかパッチしないため、モジュール複製時もフックを見失わないように
const CALLER_KEY = Symbol.for("jsmini.host-patches.closureCaller");
export function setClosureCaller(fn: (cb: unknown, args: unknown[]) => unknown): void {
  (globalThis as any)[CALLER_KEY] = fn;
}
const isEngineClosure = (v: unknown): boolean =>
  typeof v === "object" && v !== null && ("__closure" in v || ("bytecode" in v && "paramCount" in v));
// jsmini の callable (host 関数 / VM クロージャ) を host から呼べる形に。callable でなければ null
function toHostCallable(v: unknown): ((...a: unknown[]) => unknown) | null {
  if (typeof v === "function") return v as (...a: unknown[]) => unknown;
  const caller = (globalThis as any)[CALLER_KEY];
  if (isEngineClosure(v) && caller) return (...a: unknown[]) => caller(v, a);
  return null;
}

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

  // --- RegExp well-known symbol メソッド (Phase 47) ---
  // jsmini は Symbol キーを "@@name" 文字列に写像するため、`re[Symbol.replace](...)`
  // は host RegExp の "@@replace" 文字列プロパティ読みになる。host の Symbol 実体
  // メソッドへ委譲する薄いラッパを RegExp.prototype に文字列キーで生やす。
  // 文字列境界: 引数の JSString は unwrap、結果の host string は intern。
  // コールバック (関数 replacement) は両エンジンの汎用ラップ済み host callable で
  // 届くが、引数 intern / 戻り値 unwrap はしてくれないのでここで行う
  const toHostStr = (s: unknown): string => isJSString(s) ? jsStringToString(s) : String(s);
  const symMatch = RegExp.prototype[Symbol.match];
  const symMatchAll = RegExp.prototype[Symbol.matchAll];
  const symReplace = RegExp.prototype[Symbol.replace];
  const symSearch = RegExp.prototype[Symbol.search];
  const symSplit = RegExp.prototype[Symbol.split];
  const rp = RegExp.prototype as unknown as Record<string, unknown>;
  rp["@@match"] = function(this: RegExp, s: unknown) {
    const m = symMatch.call(this, toHostStr(s));
    return m === null ? null : internMatchResult(m);
  };
  rp["@@matchAll"] = function(this: RegExp, s: unknown) {
    // イテレータではなく配列で近似 (vm.stringPrototype.matchAll と同じ方針)
    const out: unknown[] = [];
    for (const m of symMatchAll.call(this, toHostStr(s))) out.push(internMatchResult(m));
    return out;
  };
  rp["@@search"] = function(this: RegExp, s: unknown) {
    return symSearch.call(this, toHostStr(s));
  };
  rp["@@split"] = function(this: RegExp, s: unknown, limit?: unknown) {
    const r = symSplit.call(this, toHostStr(s), limit as number | undefined);
    return r.map(v => typeof v === "string" ? internString(v) : v);
  };
  rp["@@replace"] = function(this: RegExp, s: unknown, repl: unknown) {
    const cb = toHostCallable(repl);
    if (cb) {
      const out = symReplace.call(this, toHostStr(s), (...args: unknown[]) => {
        const r = cb(...args.map(a => typeof a === "string" ? internString(a) : a));
        return isJSString(r) ? jsStringToString(r) : String(r);
      });
      return internString(out);
    }
    return internString(symReplace.call(this, toHostStr(s), toHostStr(repl)));
  };

  // --- Map/WeakMap の getOrInsert / getOrInsertComputed (ES2026 upsert 提案) ---
  // host にはまだ無いので手実装。callback は wrap 済み host callable で届く
  const defineUpsert = (proto: Map<unknown, unknown> | WeakMap<object, unknown>) => {
    const p = proto as unknown as Record<string, unknown>;
    p.getOrInsert = function(this: Map<unknown, unknown>, k: unknown, v: unknown) {
      if (!this.has(k)) this.set(k, v);
      return this.get(k);
    };
    p.getOrInsertComputed = function(this: Map<unknown, unknown>, k: unknown, cb: unknown) {
      const call = toHostCallable(cb);
      if (!call) throw new TypeError("callbackfn is not a function");
      if (!this.has(k)) this.set(k, call(k));
      return this.get(k);
    };
  };
  defineUpsert(Map.prototype as Map<unknown, unknown>);
  defineUpsert(WeakMap.prototype as unknown as WeakMap<object, unknown>);
}
