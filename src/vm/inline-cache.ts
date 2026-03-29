// Inline Cache — プロパティアクセスのキャッシュ
// V8 の monomorphic IC に相当する最小実装

import type { HiddenClass } from "./hidden-class.js";
import { lookupOffset } from "./hidden-class.js";

export type ICState = "uninitialized" | "monomorphic" | "polymorphic";

export type ICSlot = {
  state: ICState;
  cachedHC: HiddenClass | null;
  cachedOffset: number;
};

export function createICSlot(): ICSlot {
  return { state: "uninitialized", cachedHC: null, cachedOffset: -1 };
}

// IC ヒット判定: HC が一致すればキャッシュ済みオフセットを返す
// -1 = ミス
export function icLookup(slot: ICSlot, hc: HiddenClass): number {
  if (slot.state === "monomorphic" && slot.cachedHC === hc) {
    return slot.cachedOffset;
  }
  return -1;
}

// IC 更新: ミス時にオフセットを記録
export function icUpdate(slot: ICSlot, hc: HiddenClass, name: string): number {
  const offset = lookupOffset(hc, name);
  if (slot.state === "uninitialized") {
    // 初回 → monomorphic
    slot.state = "monomorphic";
    slot.cachedHC = hc;
    slot.cachedOffset = offset;
  } else if (slot.state === "monomorphic" && slot.cachedHC !== hc) {
    // 別の HC → polymorphic (フォールバック)
    slot.state = "polymorphic";
    slot.cachedHC = null;
    slot.cachedOffset = -1;
  }
  return offset;
}
