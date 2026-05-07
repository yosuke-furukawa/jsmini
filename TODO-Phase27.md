# TODO Phase 27 — Map / Set / WeakMap / WeakSet

## 動機

PLAN-v6 P1 の最後の big rock。`for (const [k, v] of map)` や
`new Set([1,2,3])` のようなモダン JS 慣用句を unblock し、test262 の
`built-ins/Map` `built-ins/Set` を取り込めるようにする。

Phase 26 で Math/Date を host JS の薄いラッパーで動かす方針が刺さった
(VM Math = host Math、Date = host Date)。Map/Set も同じく host Map/Set
をラップする方針で進める — ただし jsmini 固有の落とし穴がいくつかある
(JSString の identity、iterator protocol、Symbol.iterator 接続)。

## 検証したいこと

1. `new Map([["a", 1], ["b", 2]])` の iterable 引数が動く (Array-of-Array)
2. `new Map(otherMap)` のように既存 iterable を引き継げる
3. `m.get("a")` で **JSString 同士の identity 問題** が起きない
   (`internString` で同じ文字列は同じインスタンスのはず — 要検証)
4. `for (const [k, v] of m)` が `[Symbol.iterator]` 経由で動く
5. `m.forEach((v, k) => ...)` のコールバックが TW/VM 両方で呼べる
6. `instanceof Map` が動く (`MapCtor.prototype = Map.prototype` パターン)
7. WeakMap/WeakSet の key に JSObject を渡したときに GC まわりが破綻しないか
   (host WeakMap の key 制約は object/symbol — JSObject 自体は object なので OK のはず)

## ステップ

### 27-1: Map (VM)

- [x] 27-1a: `MapCtor` を host `Map` のラッパーとして定義
      - `new Map()` / `new Map(iterable)` 両対応
      - iterable 引数は jsmini の Array (host Array) でも、`@@iterator` を
        持つ user-defined iterable でも受け付ける
      - 後者のために、引数を host iterable に変換するヘルパー
        `toHostIterable(v)` を作る (Symbol.iterator を呼んで next を回し、
        host Array にフラット化)
- [x] 27-1b: prototype メソッド: `get, set, has, delete, clear, size,
      forEach, keys, values, entries`
      - キーは isJSString → そのまま使う (intern 済みなら identity OK)
      - 値が JSString のときも素通しでよい
      - `forEach(cb, thisArg)` は VM の callFunction でラップ
- [x] 27-1c: `Map.prototype[Symbol.iterator]` → `entries()` を返す
      VM の `@@iterator` プロトコルとつなぐ。返す iterator は
      `{ next: () => { value, done } }` 形式
- [x] 27-1d: `MapCtor.prototype = Map.prototype` で `instanceof Map` 動作

### 27-2: Set (VM)

- [x] 27-2a: `SetCtor` を host `Set` のラッパーとして定義
- [x] 27-2b: prototype メソッド: `add, has, delete, clear, size,
      forEach, keys, values, entries`
      - `keys` は `values` と同じ (Set の慣例)
- [x] 27-2c: `Set.prototype[Symbol.iterator]` → `values()`
- [x] 27-2d: `instanceof Set`

### 27-3: WeakMap / WeakSet (VM)

- [x] 27-3a: `WeakMapCtor` / `WeakSetCtor` を host のラッパーで定義
      - メソッド: `get/set/has/delete` (WeakMap), `add/has/delete` (WeakSet)
      - `size` / iterator は **無い** (仕様通り)
- [x] 27-3b: 主要な失敗ケース確認:
      - key に primitive を渡したら TypeError
      - key に JSObject を渡したら正しく動く

### 27-4: TW (interpreter/evaluator.ts)

- [x] 27-4a: VM 27-1〜27-3 を TW に移植
- [x] 27-4b: TW 側の for-of が Map/Set を回せることを確認
      (TW の for-of 実装は VM とは別系統なので、`@@iterator` 経路を踏むか
      要確認)

### 27-5: テスト

- [x] 27-5a: `src/runtime/phase27.test.ts` を作成
      - Map: 基本 (set/get/has/delete/size)、iterable 引数、forEach、
        for-of、Symbol.iterator、instanceof、JSString キー
      - Set: 基本 (add/has/delete)、iterable 引数、forEach、for-of
      - WeakMap/WeakSet: 基本動作、primitive key で TypeError
- [x] 27-5b: TW/VM の両方で同じテストを通す

### 27-6: SunSpider 試行 (任意)

- [x] 27-6a: SunSpider の Map/Set 出現確認 → bench/sunspider/ の 5 本には
      出てこないので skip

### 27-7: test262 (オプション)

- [ ] 27-7a: sparse-checkout で `test/built-ins/Map` `test/built-ins/Set`
      `test/built-ins/WeakMap` `test/built-ins/WeakSet` を追加 (要ユーザー確認、skip)
- [ ] 27-7b: pre/post 計測 (skip)

### 27-8: まとめ

- [x] 27-8a: LEARN-Phase27.md (Wasm Map/Set 実装の話含む)
- [ ] 27-8b: BENCHMARK.md 追記 (任意 — TODO/LEARN に必要な内容あり、skip)

## 技術メモ

### Map は host Map のラッパーで OK、ただし iterable 引数に注意

```ts
// 素朴版
const MapCtor: any = function(this: unknown, iterable?: unknown) {
  if (!new.target) throw new TypeError("Map must be called with new");
  const m = new Map();
  if (iterable !== undefined && iterable !== null) {
    // ここが落とし穴: iterable が host Array でも、要素 [k, v] が
    // jsmini の Array (HiddenClass オブジェクト) かもしれない
    for (const entry of toHostIterable(iterable)) {
      const [k, v] = unwrapArrayLike(entry);
      m.set(k, v);
    }
  }
  return m;
};
MapCtor.prototype = Map.prototype;
```

### Iterable 引数は VM の iterator protocol 経由で吸収

`new Map(otherMap)` のように `@@iterator` を持つオブジェクトを渡された
ケースをサポートするには、wrapper 内で iterator を回す必要がある:

```ts
function* toHostIterable(v: any) {
  // 1. host iterable (host Array, host Map, ...) → 直接 yield
  if (typeof v?.[Symbol.iterator] === "function") {
    for (const x of v) yield x;
    return;
  }
  // 2. jsmini の iterable (@@iterator を持つ JSObject)
  const iterFn = isJSObject(v) ? jsObjGet(v, "@@iterator") : v?.["@@iterator"];
  if (typeof iterFn !== "function") throw new TypeError("not iterable");
  const iter = iterFn.call(v);
  while (true) {
    const r = iter.next();
    if (r.done) return;
    yield r.value;
  }
}
```

### JSString キーの identity

```ts
// 例
m.set("foo", 1);
m.get("foo");  // ← これが返ってくるか？
```

`internString("foo")` が同じインスタンスを返すなら問題なし。lexer が
リテラル `"foo"` を毎回 intern しているはずなので、おそらく動く。
**ただし `"f" + "oo"` 等の concatenation 結果は別インスタンス** の
可能性があり、その場合 `m.get("f" + "oo")` は undefined を返す。

これは host Map の挙動 (Object identity for non-primitives) なので、
仕様準拠としては「JSString を string に unwrap してから host Map に
入れる」のが正解。ただしパフォーマンスとシンプルさを考えると
intern 前提で素通ししたい。テストで実測してから方針決定。

### Symbol.iterator の接続

VM の for-of は `obj["@@iterator"]()` を呼ぶ:

```ts
// src/vm/vm.ts の GetIterator ハンドラ
const iterFn = isJSObject(obj) ? jsObjGet(obj, "@@iterator") : (obj as any)?.["@@iterator"];
```

host Map は `Symbol.iterator` (host Symbol) を持っているが、これを
`"@@iterator"` 文字列キーで取れるかは別問題。host Map に
`m["@@iterator"] = m[Symbol.iterator]` を別名でぶら下げる必要がある
かもしれない。要実装時に確認。

### 範囲外 (Phase 27 ではやらない)

- Map/Set の JIT 最適化 → ホットパスで出てきたら別フェーズ
- WeakRef / FinalizationRegistry → 別フェーズ
- 完全な test262 通過 → JSString identity 周りの仕様詰めは Phase 後半で
