# LEARN-Phase27.md — Map / Set / WeakMap / WeakSet

## やったこと

PLAN-v6 P1 (モダン JS の基本) の最後。host JS の Map / Set / WeakMap /
WeakSet を **薄いラッパー** で TW/VM に公開した (Phase 26 の Math/Date と
同路線)。並行して、host built-in を扱う上で必要だった infra も整備:

- VM `GetIterator` opcode の `Symbol.iterator` フォールバック
- VM `run()` の host throw → `unwindToHandler` 変換
- TW `getProperty` の host getter `this` バインド修正

837/837 テスト全パス、回帰なし。

## 教訓

### 1. host wrapper は Phase 26 と同じレシピで通用する

```ts
const MapCtor: any = function(this: unknown, iterable?: unknown) {
  if (!new.target) throw new TypeError("Map must be called with new");
  const m = new Map();
  if (iterable !== undefined && iterable !== null) {
    for (const entry of toHostIterable(iterable)) {
      const [k, v] = unwrapEntry(entry);
      m.set(k, v);
    }
  }
  return m;
};
MapCtor.prototype = Map.prototype;
vm.setGlobal("Map", MapCtor);
```

Date/Math と同じく `prototype = HostMap.prototype` で `instanceof Map` も
そのまま動くし、prototype メソッド (`get`, `set`, `has` 等) も透過的に呼べる。
**新規実装は constructor wrapper だけ**。

### 2. iterator は 2 系統のフォールバックが必要

VM の for-of は文字列キー `"@@iterator"` で iterator を取りに行くが、
host の Map/Set は `Symbol.iterator` (host Symbol) を持っている。
`m["@@iterator"]` は undefined。なので VM 側で fallback を入れた:

```ts
// src/vm/vm.ts: GetIterator
let iterFn = isJSObject(obj) ? jsObjGet(obj, "@@iterator")
                             : (obj as any)?.["@@iterator"];
if (!iterFn && typeof (obj as any)?.[Symbol.iterator] === "function") {
  iterFn = (obj as any)[Symbol.iterator].bind(obj);
}
```

これで `for (const [k, v] of m)` も `for (const x of m.entries())` も動く。
TW は元から fallback してあった。

`iterator.next()` が返す `{value, done}` は host のまま使う (jsmini の
JSObject ではないが、`(result as any).value` の fallback で取れる)。

### 3. host getter は `this` を保たないと "incompatible receiver" になる

TW の `getProperty` は plain prototype walk:

```ts
let current = obj;
while (current) {
  if (Object.prototype.hasOwnProperty.call(current, key)) return current[key];
  current = current.__proto__;
}
```

これだと `s.size` (Set instance) で:
1. `hasOwnProperty(s, "size")` → false (size は Set.prototype の getter)
2. `current = Set.prototype`
3. `hasOwnProperty(Set.prototype, "size")` → true
4. `return Set.prototype["size"]` → **getter が `this = Set.prototype` で呼ばれ
   "Method get Set.prototype.size called on incompatible receiver" 死亡**

修正:

```ts
const desc = Object.getOwnPropertyDescriptor(current, key);
if (desc && typeof desc.get === "function") return desc.get.call(obj);  // 元の receiver
return current[key];
```

教訓: **host built-in の prototype を走査するなら、getter 検出は必須**。
Map.prototype.size, Set.prototype.size, Date.prototype.getTime のような
host accessor を直接読む code path で必ず引っかかる。

### 4. host throw を VM の try/catch に変換するには run() ループのラッパが要る

`new WeakMap().set(1, "x")` は host が `TypeError("Invalid value used as
weak map key")` を投げる。これを jsmini の try/catch で受けたい。

VM の Throw opcode 経路 (`{ __thrown: true, value }`) は最初から
`unwindToHandler` に流す配線があるが、CallMethod 経路で host が直接 throw
した場合、何も挟まらないと runLoop を突き抜けて execute() 〜 vmEvaluate()
まで上がってしまう。修正:

```ts
private run(baseFrameCount = 0): unknown {
  ...
  while (true) {
    try { return this._runLoop(baseFrameCount); }
    catch (e: any) {
      if (e instanceof YieldSignal) throw e;     // 制御フローはそのまま
      if (e?.__thrown) throw e;                  // Throw opcode 経路は既に処理済み
      if (this.unwindToHandler(e, baseFrameCount)) continue;  // ハンドラに変換
      throw e;
    }
  }
}
```

落とし穴: 最初これを書いたら **YieldSignal も catch して unwind に流して
しまった** ため generator/async が全部死んだ (13 失敗)。`YieldSignal` の
明示スルーは必須。

### 5. forEach コールバックは BytecodeFunction の場合があるので wrap が要る

```ts
m.forEach(callback)
```

の `callback` は jsmini ユーザコードのアロー関数 → BytecodeFunction or
クロージャ。host `Map.prototype.forEach` は普通の function しか呼べないので、
そのまま渡すと壊れる。

解決策として `Map.prototype.forEach` 自体をパッチして、callback を
`vm.callFunction` でラップする:

```ts
const origMapForEach = Map.prototype.forEach;
if (!(Map.prototype as any).__jsminiPatched) {
  (Map.prototype as any).__jsminiPatched = true;
  Map.prototype.forEach = function(this: Map<unknown,unknown>, cb: unknown, thisArg?: unknown) {
    const wrapped = wrapVMCallback(cb);
    origMapForEach.call(this, function(v, k, m) { wrapped.call(thisArg, v, k, m); }, thisArg);
  } as any;
}
```

host の Map prototype にパッチする副作用はあるが、jsmini ランタイム自身は
"@@iterator" のような独自プロパティに頼らないので、host JS code に害は無い。
冪等性のため `__jsminiPatched` フラグでガードする。

### 6. WeakMap/WeakSet のセマンティクスはほぼ host にお任せ

primitive 拒否 (`m.set(1, x) → TypeError`) は host が勝手にやってくれる。
VM 側は host throw 変換 (上記 4) さえ動けば仕様通りに振る舞う。

逆に jsmini の HiddenClass 付き JSObject も host から見ると単なる object
なので、key として何の問題もなく入る。**jsmini ↔ host の境界を意識する
ところがほぼ無い** のが Map/Set/WeakMap/WeakSet の良いところ。

## Wasm で Map/Set をどう実装するか

ユーザーが興味あった話。今回 jsmini は **host import** で済ませているが、
本格的な処理系では Wasm 側で実装する選択肢もある。整理:

### A. host import (今回採用)

```ts
// JIT が出す Wasm
import "Map.set" "set" (func (param externref externref externref) (result externref))
```

- 実装コスト: 0 (host の Map.prototype.set を渡すだけ)
- ランタイムコスト: JS↔Wasm 境界 (数 ns/call)、ただし `externref` を扱える
  Wasm engine 前提
- 正当性: host とビット perfect (キー比較、iteration order 全部 host 任せ)

教育的価値が低い代わりに **実装労力ゼロ**。今回はここまで。

### B. linear memory にオープンアドレス法のハッシュテーブル

C/Rust の `HashMap` を移植する古典的アプローチ:

```
Memory layout:
  +------------+
  | size_log2  |   = log2(capacity)
  | count      |   = number of entries
  | tombstones |
  | entries[]  |   = array of {hash, key, value}, length = 2^size_log2
  +------------+

Operations:
  set(k, v):
    h = hash(k)
    idx = h & (capacity - 1)
    while entries[idx].state != EMPTY && entries[idx].key != k:
      idx = (idx + 1) & (capacity - 1)   // linear probing
    entries[idx] = {hash: h, key: k, value: v, state: USED}
    if count > capacity * 0.75: rehash to 2*capacity
```

ポイント:
- `key` をどう Wasm に持つか? **i32/f64 (number)** ならそのまま比較できる。
  string や object キーは「ヒープ上のポインタ (i32)」を入れる
- `hash(k)` は何で計算? string なら **FNV-1a** や **xxHash** が小さい
- **rehash** が要る = grow 時のメモリコピー
- iteration order は ECMAScript で **insertion order** が定められている →
  単純なオープンアドレスだとこれが守れない。**doubly-linked entries** 方式
  (Python 3.7+ dict、V8 OrderedHashMap) が必要

参考実装の規模: ~2-3 KB Wasm (例: WasmEdge の libm + simple alloc)。
Rust なら `BTreeMap` を `wasm32-unknown-unknown` でビルドして flat embed
するのが手っ取り早いが、`alloc` が要る = bump allocator + free list が要る。

教育的には濃い。**Phase X+1: 自前 hash table を Wasm で書く** という派生
タスクとして良さそう。

### C. Wasm GC proposal (`anyref`/`structref`/`arrayref`) を使う

新しい Wasm GC は型付きオブジェクト (struct、array) と GC を Wasm エンジンに
持たせる。Map のキー/値を `anyref` で持てば、host の GC が回収する:

```wat
(type $entry (struct (field $hash i32) (field $key anyref) (field $value anyref) (field $state i8)))
(type $entries (array (mut (ref null $entry))))
```

メリット:
- linear memory での自前 GC 実装が **不要**
- key/value が host objects (JS の Map のキー/値そのもの) を直接持てる
- WeakMap/WeakSet は **`weakref` 型** が GC proposal に入れば自然に表現できる
  (現状はまだ tier 2 で実装少ない)

デメリット:
- Wasm GC をサポートする engine が要る (V8 は tier 1 で OK、JSC/SpiderMonkey
  も入れている、しかし Safari のリリース機にはまだ)
- 学習コスト高い (Wasm GC 仕様を読む必要)

### D. JIT が host import を inline 化する

Phase 26 で Math.sin を host import にしたとき、`f64.sqrt` など Wasm core で
表現できるものは inline 化した。同様に **Map/Set の hot path を inline 化**
することは可能だが、ハッシュテーブル全体を Wasm に持ち込むのは B と同じ
作業量になる。**ROI が悪い** ので普通はやらない (V8 も Map.prototype.set は
C++ ランタイム呼び出しに留めている)。

### 結論

| 戦略 | 実装コスト | ランタイム | iteration order | 教育的価値 |
|---|---|---|---|---|
| A. host import | 最小 | 境界 call | host 任せで OK | 低 |
| B. linear memory hash | 大 | 純 Wasm | 自前で linked list 必要 | 高 |
| C. Wasm GC | 中 | GC が見える | struct array + ref で簡潔 | 中 |
| D. JIT inline | 大 | 純 Wasm | B と同じ | 中 |

jsmini は教育プロジェクトなので、いつか **B (linear memory + linked
entries)** を 1 〜 2 KB の Wasm で書くフェーズを設けると面白い。
そのときの主な見せ場は:

- ハッシュ関数 (FNV-1a) の選択と衝突解決 (linear probing vs Robin Hood)
- bump allocator の実装
- insertion-order の linked list 維持
- rehash on grow

WeakMap/WeakSet は **GC との連携** が前提。linear memory 版の WeakMap は、
host GC と連携する仕組みが無い限り「弱参照」にならない (純 Wasm で実装
しても、外部から「key が GC された」イベントを受け取る術が無い)。これは
**Wasm GC + WeakRef proposal** が要るか、**host import に丸投げ** か。
今回は後者。

## 範囲外 (Phase 27 ではやらない)

- Map/Set の JIT 化 (上記 D)
- 自前 Wasm hash table (上記 B、別フェーズ候補)
- WeakRef / FinalizationRegistry
- test262 の `built-ins/Map` `built-ins/Set` 取り込み (sparse-checkout 拡張)

## 次フェーズ (Phase 28) 予告

PLAN-v6 によると:

- RegExp リテラル (`/pattern/flags`) の Lexer/Parser
- NFA ベース正規表現エンジン (基本: `.`, `*`, `+`, `?`, `[]`, `^`, `$`, `|`, `()`)
- String.prototype の RegExp 版 (match, replace, search, matchAll)
- test262 RegExp テスト + SunSpider regexp ベンチ

Phase 27 と違って「**host JS の RegExp で代用**」だと面白くないので、
小さいでも自前 NFA を書くのが教育的価値高い。Lexer の `/.../` 対応は
ASI と曖昧になるので、その辺の処理も必要。
