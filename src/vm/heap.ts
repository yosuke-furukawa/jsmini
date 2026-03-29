// GC ヒープ — 全オブジェクトを追跡する Mark-and-Sweep GC

import { isJSObject, getSlots, type JSObjectInternal } from "./js-object.js";
import { isJSString, type JSString } from "./js-string.js";
import { isTrackedArray } from "./js-array.js";

// ヒープ上の全オブジェクトにつける印
const GC_MARK = Symbol("gcMark");

type Markable = { [GC_MARK]?: boolean };

export class Heap {
  private objects: Markable[] = [];
  private allocCount = 0;
  private gcThreshold = 1000;
  private gcLog: string[] = [];
  traceGC = false;
  // 統計
  private totalAllocated = 0;
  private totalSwept = 0;
  private gcCount = 0;
  private peakSize = 0;

  // オブジェクトをヒープに登録
  allocate<T>(value: T): T {
    if (typeof value === "object" && value !== null) {
      (value as Markable)[GC_MARK] = false;
      this.objects.push(value as Markable);
      this.totalAllocated++;
      if (this.objects.length > this.peakSize) this.peakSize = this.objects.length;
    }
    this.allocCount++;
    return value;
  }

  // 現在のヒープサイズ
  size(): number {
    return this.objects.length;
  }

  // allocate 回数
  getAllocCount(): number {
    return this.allocCount;
  }

  // GC が必要か判定
  shouldCollect(): boolean {
    return this.allocCount >= this.gcThreshold;
  }

  // Mark-and-Sweep を実行
  collect(roots: unknown[]): { before: number; marked: number; swept: number } {
    const before = this.objects.length;

    // Mark フェーズ
    const marked = this.mark(roots);

    // Sweep フェーズ
    const swept = this.sweep();

    // 閾値を動的に調整: 生存オブジェクト数の 2 倍
    this.gcThreshold = Math.max(1000, (before - swept) * 2);
    this.allocCount = 0;

    this.totalSwept += swept;
    this.gcCount++;

    if (this.traceGC) {
      const msg = `[GC] heap: ${before} → mark: ${marked}, sweep: ${swept} → heap: ${this.objects.length}`;
      this.gcLog.push(msg);
    }

    return { before, marked, swept };
  }

  getGCLog(): string[] {
    return this.gcLog;
  }

  getStats(): { totalAllocated: number; totalSwept: number; gcCount: number; peakSize: number; currentSize: number } {
    return {
      totalAllocated: this.totalAllocated,
      totalSwept: this.totalSwept,
      gcCount: this.gcCount,
      peakSize: this.peakSize,
      currentSize: this.objects.length,
    };
  }

  // --- Mark フェーズ ---
  private mark(roots: unknown[]): number {
    // 全オブジェクトの mark をクリア
    for (const obj of this.objects) {
      obj[GC_MARK] = false;
    }

    // ルートから辿って mark
    let markCount = 0;
    const visited = new Set<unknown>();

    const markValue = (value: unknown): void => {
      if (value === null || value === undefined) return;
      if (typeof value !== "object" && typeof value !== "function") return;
      if (visited.has(value)) return;
      visited.add(value);

      // ヒープオブジェクトなら mark
      if (GC_MARK in (value as Markable)) {
        (value as Markable)[GC_MARK] = true;
        markCount++;
      }

      // 子を辿る
      if (isJSObject(value)) {
        // JSObject: __slots__ の全要素を辿る
        const slots = getSlots(value);
        for (const slot of slots) {
          markValue(slot);
        }
      } else if (isJSString(value)) {
        // JSString: ConsString の left/right を辿る
        const str = value as JSString;
        if (str.kind === "cons") {
          markValue(str.left);
          markValue(str.right);
        } else if (str.kind === "sliced") {
          markValue(str.parent);
        }
      } else if (Array.isArray(value)) {
        // 配列: 全要素を辿る
        for (const elem of value) {
          markValue(elem);
        }
      } else if (typeof value === "object") {
        // 一般オブジェクト: 全プロパティを辿る
        for (const key of Object.keys(value as Record<string, unknown>)) {
          markValue((value as Record<string, unknown>)[key]);
        }
        // bytecode 関数の constants も辿る
        if ("constants" in (value as any)) {
          for (const c of (value as any).constants) {
            markValue(c);
          }
        }
      }
    };

    for (const root of roots) {
      markValue(root);
    }

    return markCount;
  }

  // --- Sweep フェーズ ---
  private sweep(): number {
    let swept = 0;
    const alive: Markable[] = [];

    for (const obj of this.objects) {
      if (obj[GC_MARK]) {
        alive.push(obj);
      } else {
        swept++;
      }
    }

    this.objects = alive;
    return swept;
  }
}
