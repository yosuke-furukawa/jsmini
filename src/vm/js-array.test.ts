import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createJSArray,
  createEmptyJSArray,
  getElementKind,
  setElement,
  pushElement,
  isTrackedArray,
} from "./js-array.js";

describe("JSArray - Element Kind", () => {
  describe("createJSArray", () => {
    it("整数配列は SMI", () => {
      const arr = createJSArray([1, 2, 3]);
      assert.equal(getElementKind(arr), "SMI");
      assert.equal(arr[0], 1);
      assert.equal(arr[1], 2);
      assert.equal(arr[2], 3);
      assert.equal(arr.length, 3);
    });

    it("浮動小数配列は DOUBLE", () => {
      const arr = createJSArray([1.5, 2.5, 3.5]);
      assert.equal(getElementKind(arr), "DOUBLE");
    });

    it("整数 + 浮動小数混在は DOUBLE", () => {
      const arr = createJSArray([1, 2.5, 3]);
      assert.equal(getElementKind(arr), "DOUBLE");
    });

    it("文字列混在は GENERIC", () => {
      const arr = createJSArray([1, "hello", 3]);
      assert.equal(getElementKind(arr), "GENERIC");
    });

    it("空配列は SMI", () => {
      const arr = createJSArray([]);
      assert.equal(getElementKind(arr), "SMI");
    });

    it("null 混在は GENERIC", () => {
      const arr = createJSArray([1, null, 3]);
      assert.equal(getElementKind(arr), "GENERIC");
    });
  });

  describe("createEmptyJSArray", () => {
    it("空配列は SMI で開始", () => {
      const arr = createEmptyJSArray();
      assert.equal(getElementKind(arr), "SMI");
      assert.equal(arr.length, 0);
    });
  });

  describe("Element Kind 遷移 (一方通行)", () => {
    it("SMI → DOUBLE (浮動小数を追加)", () => {
      const arr = createJSArray([1, 2, 3]);
      assert.equal(getElementKind(arr), "SMI");
      setElement(arr, 1, 2.5);
      assert.equal(getElementKind(arr), "DOUBLE");
      assert.equal(arr[1], 2.5);
    });

    it("SMI → GENERIC (文字列を追加)", () => {
      const arr = createJSArray([1, 2, 3]);
      setElement(arr, 1, "hello");
      assert.equal(getElementKind(arr), "GENERIC");
    });

    it("DOUBLE → GENERIC (文字列を追加)", () => {
      const arr = createJSArray([1.5, 2.5]);
      assert.equal(getElementKind(arr), "DOUBLE");
      setElement(arr, 0, "hello");
      assert.equal(getElementKind(arr), "GENERIC");
    });

    it("GENERIC から戻れない (整数を追加しても GENERIC のまま)", () => {
      const arr = createJSArray([1, "hello"]);
      assert.equal(getElementKind(arr), "GENERIC");
      setElement(arr, 0, 42);
      assert.equal(getElementKind(arr), "GENERIC");
    });

    it("DOUBLE から SMI に戻れない", () => {
      const arr = createJSArray([1.5, 2.5]);
      assert.equal(getElementKind(arr), "DOUBLE");
      setElement(arr, 0, 1);
      assert.equal(getElementKind(arr), "DOUBLE");
    });
  });

  describe("pushElement", () => {
    it("SMI 配列に整数を push → SMI のまま", () => {
      const arr = createEmptyJSArray();
      pushElement(arr, 1);
      pushElement(arr, 2);
      pushElement(arr, 3);
      assert.equal(getElementKind(arr), "SMI");
      assert.deepEqual([...arr], [1, 2, 3]);
    });

    it("SMI 配列に浮動小数を push → DOUBLE に遷移", () => {
      const arr = createJSArray([1, 2]);
      pushElement(arr, 3.14);
      assert.equal(getElementKind(arr), "DOUBLE");
    });

    it("SMI 配列に文字列を push → GENERIC に遷移", () => {
      const arr = createJSArray([1, 2]);
      pushElement(arr, "hello");
      assert.equal(getElementKind(arr), "GENERIC");
    });
  });

  describe("isTrackedArray", () => {
    it("createJSArray で作った配列は tracked", () => {
      assert.equal(isTrackedArray(createJSArray([1, 2])), true);
    });

    it("createEmptyJSArray で作った配列は tracked", () => {
      assert.equal(isTrackedArray(createEmptyJSArray()), true);
    });

    it("普通の配列は tracked ではない", () => {
      assert.equal(isTrackedArray([1, 2, 3]), false);
    });

    it("非配列は tracked ではない", () => {
      assert.equal(isTrackedArray(42), false);
      assert.equal(isTrackedArray("hello"), false);
      assert.equal(isTrackedArray(null), false);
    });
  });

  describe("quicksort で使われるパターン", () => {
    it("整数配列の swap が SMI を維持", () => {
      const arr = createJSArray([5, 3, 1, 4, 2]);
      // swap(arr, 0, 2)
      const tmp = arr[0];
      setElement(arr, 0, arr[2]);
      setElement(arr, 2, tmp);
      assert.equal(getElementKind(arr), "SMI");
      assert.deepEqual([...arr], [1, 3, 5, 4, 2]);
    });

    it("ループで要素を代入しても SMI を維持", () => {
      const arr = createEmptyJSArray();
      for (let i = 0; i < 200; i++) {
        setElement(arr, i, (i * 7 + 13) % 200);
      }
      assert.equal(getElementKind(arr), "SMI");
      assert.equal(arr.length, 200);
    });
  });
});
