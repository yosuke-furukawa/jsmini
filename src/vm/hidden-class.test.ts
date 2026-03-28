import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRootHC, transition, lookupOffset } from "./hidden-class.js";
import {
  createJSObject,
  isJSObject,
  getHiddenClass,
  getProperty,
  setProperty,
} from "./js-object.js";

describe("HiddenClass", () => {
  it("空の HC はプロパティなし", () => {
    const hc = getRootHC();
    assert.equal(hc.properties.size, 0);
    assert.equal(lookupOffset(hc, "x"), -1);
  });

  it("遷移でプロパティが追加される", () => {
    const hc0 = getRootHC();
    const hc1 = transition(hc0, "x");
    assert.equal(lookupOffset(hc1, "x"), 0);
    assert.equal(lookupOffset(hc1, "y"), -1);

    const hc2 = transition(hc1, "y");
    assert.equal(lookupOffset(hc2, "x"), 0);
    assert.equal(lookupOffset(hc2, "y"), 1);
  });

  it("同じ遷移パスは同じ HC を返す", () => {
    const hc0 = getRootHC();
    const hc1a = transition(hc0, "x");
    const hc1b = transition(hc0, "x");
    assert.equal(hc1a, hc1b); // 同一参照

    const hc2a = transition(hc1a, "y");
    const hc2b = transition(hc1b, "y");
    assert.equal(hc2a, hc2b);
  });

  it("異なる順序で追加すると異なる HC になる", () => {
    const hc0 = getRootHC();
    const hcXY = transition(transition(hc0, "x"), "y");
    const hcYX = transition(transition(hc0, "y"), "x");
    assert.notEqual(hcXY, hcYX);
    // ただし両方とも x, y を持つ
    assert.equal(lookupOffset(hcXY, "x"), 0);
    assert.equal(lookupOffset(hcXY, "y"), 1);
    assert.equal(lookupOffset(hcYX, "y"), 0);
    assert.equal(lookupOffset(hcYX, "x"), 1);
  });

  it("既存プロパティに遷移しても HC は変わらない", () => {
    const hc0 = getRootHC();
    const hc1 = transition(hc0, "x");
    const hc1again = transition(hc1, "x");
    assert.equal(hc1, hc1again);
  });
});

describe("JSObject", () => {
  it("空オブジェクトを作成できる", () => {
    const obj = createJSObject();
    assert.ok(isJSObject(obj));
    assert.equal(getHiddenClass(obj).properties.size, 0);
  });

  it("プロパティの設定と取得", () => {
    const obj = createJSObject();
    setProperty(obj, "x", 10);
    setProperty(obj, "y", 20);
    assert.equal(getProperty(obj, "x"), 10);
    assert.equal(getProperty(obj, "y"), 20);
  });

  it("プロパティの上書き", () => {
    const obj = createJSObject();
    setProperty(obj, "x", 10);
    setProperty(obj, "x", 99);
    assert.equal(getProperty(obj, "x"), 99);
  });

  it("HC が遷移する", () => {
    const obj = createJSObject();
    const hc0 = getHiddenClass(obj);
    setProperty(obj, "x", 10);
    const hc1 = getHiddenClass(obj);
    assert.notEqual(hc0, hc1);
    setProperty(obj, "y", 20);
    const hc2 = getHiddenClass(obj);
    assert.notEqual(hc1, hc2);
    // 上書きでは遷移しない
    setProperty(obj, "x", 99);
    assert.equal(getHiddenClass(obj), hc2);
  });

  it("同じ順序のプロパティ追加で HC を共有", () => {
    const a = createJSObject();
    setProperty(a, "x", 1);
    setProperty(a, "y", 2);

    const b = createJSObject();
    setProperty(b, "x", 3);
    setProperty(b, "y", 4);

    assert.equal(getHiddenClass(a), getHiddenClass(b));
  });

  it("異なる順序のプロパティ追加で HC が異なる", () => {
    const a = createJSObject();
    setProperty(a, "x", 1);
    setProperty(a, "y", 2);

    const b = createJSObject();
    setProperty(b, "y", 1);
    setProperty(b, "x", 2);

    assert.notEqual(getHiddenClass(a), getHiddenClass(b));
  });

  it("互換性: obj[name] でもアクセスできる", () => {
    const obj = createJSObject();
    setProperty(obj, "x", 42);
    assert.equal(obj["x"], 42);
    assert.equal(obj.x, 42);
  });

  it("未定義のプロパティは undefined を返す", () => {
    const obj = createJSObject();
    assert.equal(getProperty(obj, "x"), undefined);
  });
});
