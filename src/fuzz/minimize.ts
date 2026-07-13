// 差分を保ったままソースを行単位で縮小する (delta debugging の簡易版)。
// 生成プログラムは有界なので in-process で安全に評価できる。

import { parse } from "../parser/parser.js";
import { runEngines, detectDivergence } from "./runner.js";

// 差分の「種類」を表すシグネチャ。値そのものではなくパターン (kind + error 名) で
// クラスタリングし、縮小中もこの signature が保たれることを条件にする。
export function divSignature(keys: Record<string, string>): string {
  const simplify = (k: string): string => {
    if (k.startsWith("V:")) return "value";
    if (k.startsWith("T:Error:")) return "throw:" + k.slice("T:Error:".length).split(" ")[0];
    if (k.startsWith("T:value:")) return "throw:value";
    if (k.startsWith("SKIP:")) return k;
    return k.split(" ")[0];
  };
  const sig = ["TW", "VM", "JIT"]
    .map((e) => `${e}=${keys[e] ? simplify(keys[e]) : "?"}`)
    .join(" ");
  // 完了値/種別は一致するが console.log の副作用だけ食い違うケースを区別する。
  const simplified = ["TW", "VM", "JIT"].map((e) => (keys[e] ? simplify(keys[e]) : "?"));
  const allSame = simplified.every((s) => s === simplified[0]);
  return allSame ? `${sig} (logs差)` : sig;
}

function stillDivergent(src: string, wantSig: string): boolean {
  try {
    parse(src);
  } catch {
    return false; // パースできなければ縮小候補として無効
  }
  const d = detectDivergence(src, runEngines(src));
  return d !== null && divSignature(d.keys) === wantSig;
}

// 行の連続範囲を貪欲に削除し、同じ差分シグネチャが保たれる最小形を探す。
export function minimize(source: string, maxRounds = 20): string {
  const initial = detectDivergence(source, runEngines(source));
  if (!initial) return source;
  const wantSig = divSignature(initial.keys);

  let lines = source.split("\n");
  for (let round = 0; round < maxRounds; round++) {
    let changed = false;
    // 大きい塊から小さい塊へ
    for (let size = Math.max(1, Math.floor(lines.length / 2)); size >= 1; size = Math.floor(size / 2)) {
      for (let i = 0; i + size <= lines.length; i++) {
        const candidate = [...lines.slice(0, i), ...lines.slice(i + size)];
        if (candidate.length === 0) continue;
        if (stillDivergent(candidate.join("\n"), wantSig)) {
          lines = candidate;
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
    if (!changed) break;
  }
  return lines.join("\n");
}
