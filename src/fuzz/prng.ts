// 決定的な擬似乱数生成器 (mulberry32)。
// seed が同じなら同じ列を返すため、見つけたバグを seed で再現できる。

export class Rng {
  private state: number;

  constructor(seed: number) {
    // 0 だと縮退するので必ず非ゼロにする
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  // [0, 1) の浮動小数
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // [0, n) の整数
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  // [lo, hi] の整数 (両端含む)
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  // 確率 p (既定 0.5) で true
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  // 配列から 1 要素
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  // 重み付き選択: [[value, weight], ...]
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of entries) total += w;
    let r = this.next() * total;
    for (const [v, w] of entries) {
      r -= w;
      if (r < 0) return v;
    }
    return entries[entries.length - 1][0];
  }
}

// 文字列/数値から安定した 32bit seed を作る (イテレーションごとの seed 導出に使う)
export function hashSeed(base: number, i: number): number {
  let h = (base ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ i, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
