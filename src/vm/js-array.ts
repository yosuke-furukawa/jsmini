// Element Kind 付き配列
// V8 の PACKED_SMI_ELEMENTS / PACKED_DOUBLE_ELEMENTS / PACKED_ELEMENTS に対応

export type ElementKind = "SMI" | "DOUBLE" | "GENERIC";

const ELEMENT_KIND = Symbol("elementKind");

// Element Kind 付き配列を作成
export function createJSArray(elements: unknown[]): unknown[] {
  const arr = [...elements] as unknown[] & { [ELEMENT_KIND]?: ElementKind };
  arr[ELEMENT_KIND] = classifyElements(elements);
  return arr;
}

// 空配列を作成 (SMI として開始)
export function createEmptyJSArray(): unknown[] {
  const arr = [] as unknown[] & { [ELEMENT_KIND]?: ElementKind };
  arr[ELEMENT_KIND] = "SMI";
  return arr;
}

// Element Kind を取得
export function getElementKind(arr: unknown[]): ElementKind {
  return (arr as any)[ELEMENT_KIND] ?? classifyElements(arr);
}

// 配列要素を設定 (Element Kind を自動遷移)
export function setElement(arr: unknown[], index: number, value: unknown): void {
  arr[index] = value;
  transitionElementKind(arr, value);
}

// 配列に要素を追加 (Element Kind を自動遷移)
export function pushElement(arr: unknown[], value: unknown): void {
  arr.push(value);
  transitionElementKind(arr, value);
}

// Element Kind が JSArray として追跡されているか
export function isTrackedArray(arr: unknown): arr is unknown[] {
  return Array.isArray(arr) && ELEMENT_KIND in (arr as any);
}

// 要素から Element Kind を分類
function classifyElements(elements: unknown[]): ElementKind {
  let kind: ElementKind = "SMI";
  for (const el of elements) {
    if (typeof el !== "number") return "GENERIC";
    if (!Number.isInteger(el)) kind = "DOUBLE";
  }
  return kind;
}

// 一方通行の Element Kind 遷移
// SMI → DOUBLE → GENERIC (戻れない)
function transitionElementKind(arr: unknown[], newValue: unknown): void {
  const current = (arr as any)[ELEMENT_KIND] as ElementKind | undefined;
  if (!current || current === "GENERIC") return;

  if (typeof newValue !== "number") {
    (arr as any)[ELEMENT_KIND] = "GENERIC";
  } else if (current === "SMI" && !Number.isInteger(newValue)) {
    (arr as any)[ELEMENT_KIND] = "DOUBLE";
  }
}
