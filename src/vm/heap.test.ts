import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Heap } from "./heap.js";
import { createJSObject, setProperty } from "./js-object.js";
import { createSeqString, jsStringConcat } from "./js-string.js";
import { createJSArray } from "./js-array.js";

describe("Heap - Mark-and-Sweep GC", () => {
  describe("allocate + size", () => {
    it("オブジェクトを追跡する", () => {
      const heap = new Heap();
      assert.equal(heap.size(), 0);
      heap.allocate({ x: 1 });
      assert.equal(heap.size(), 1);
      heap.allocate({ y: 2 });
      assert.equal(heap.size(), 2);
    });

    it("プリミティブは追跡しない", () => {
      const heap = new Heap();
      heap.allocate(42);
      heap.allocate("hello");
      heap.allocate(true);
      assert.equal(heap.size(), 0);
    });
  });

  describe("mark + sweep", () => {
    it("ルートから到達可能なオブジェクトは残る", () => {
      const heap = new Heap();
      const alive = heap.allocate({ x: 1 });
      heap.allocate({ y: 2 }); // 参照されない → GC 対象

      const result = heap.collect([alive]);
      assert.equal(result.before, 2);
      assert.equal(result.marked, 1);
      assert.equal(result.swept, 1);
      assert.equal(heap.size(), 1);
    });

    it("全てのオブジェクトが到達可能なら何も回収しない", () => {
      const heap = new Heap();
      const a = heap.allocate({ x: 1 });
      const b = heap.allocate({ y: 2 });

      const result = heap.collect([a, b]);
      assert.equal(result.swept, 0);
      assert.equal(heap.size(), 2);
    });

    it("ルートがなければ全部回収される", () => {
      const heap = new Heap();
      heap.allocate({ x: 1 });
      heap.allocate({ y: 2 });

      const result = heap.collect([]);
      assert.equal(result.swept, 2);
      assert.equal(heap.size(), 0);
    });

    it("オブジェクトの参照チェーンを辿る", () => {
      const heap = new Heap();
      const inner = heap.allocate({ value: 42 });
      const outer = heap.allocate({ child: inner });
      heap.allocate({ dead: true }); // 参照されない

      const result = heap.collect([outer]);
      assert.equal(result.marked, 2); // outer + inner
      assert.equal(result.swept, 1); // dead
    });
  });

  describe("JSObject の GC", () => {
    it("JSObject の slots を辿る", () => {
      const heap = new Heap();
      const child = heap.allocate(createJSObject());
      setProperty(child, "value", 42);
      const parent = heap.allocate(createJSObject());
      setProperty(parent, "child", child);
      heap.allocate(createJSObject()); // 孤立

      const result = heap.collect([parent]);
      assert.equal(result.marked, 2);
      assert.equal(result.swept, 1);
    });
  });

  describe("JSString の GC", () => {
    it("ConsString の left/right を辿る", () => {
      const heap = new Heap();
      const left = heap.allocate(createSeqString("hello world "));
      const right = heap.allocate(createSeqString("this is long"));
      const cons = heap.allocate(jsStringConcat(left, right));
      heap.allocate(createSeqString("orphan string")); // 孤立

      const result = heap.collect([cons]);
      assert.equal(result.marked, 3); // cons + left + right
      assert.equal(result.swept, 1); // orphan
    });
  });

  describe("JSArray の GC", () => {
    it("配列の要素を辿る", () => {
      const heap = new Heap();
      const elem = heap.allocate(createJSObject());
      const arr = heap.allocate(createJSArray([elem]));
      heap.allocate(createJSObject()); // 孤立

      const result = heap.collect([arr]);
      assert.equal(result.marked, 2); // arr + elem
      assert.equal(result.swept, 1);
    });
  });

  describe("循環参照", () => {
    it("循環参照があっても無限ループしない", () => {
      const heap = new Heap();
      const a: Record<string, unknown> = heap.allocate({ name: "a" });
      const b: Record<string, unknown> = heap.allocate({ name: "b" });
      a.ref = b;
      b.ref = a; // 循環

      const result = heap.collect([a]);
      assert.equal(result.marked, 2);
      assert.equal(result.swept, 0);
    });
  });

  describe("GC トリガー", () => {
    it("shouldCollect は閾値を超えると true", () => {
      const heap = new Heap();
      for (let i = 0; i < 999; i++) heap.allocate({ i });
      assert.equal(heap.shouldCollect(), false);
      heap.allocate({ last: true });
      assert.equal(heap.shouldCollect(), true);
    });
  });

  describe("GC ログ", () => {
    it("traceGC で GC ログを記録", () => {
      const heap = new Heap();
      heap.traceGC = true;
      heap.allocate({ x: 1 });
      heap.allocate({ y: 2 });
      heap.collect([]);
      const log = heap.getGCLog();
      assert.equal(log.length, 1);
      assert.ok(log[0].includes("[GC]"));
      assert.ok(log[0].includes("sweep: 2"));
    });
  });
});
