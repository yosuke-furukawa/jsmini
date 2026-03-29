# PLAN v2 — jsmini の次のステップ

Phase 1-5 (Lexer → Parser → TW → VM → Wasm JIT) を完了し、
TW vs VM vs JIT の性能差と「なぜそうなるか」を実体験で理解した。

ここから先は **V8 が持つ内部最適化** を jsmini に導入していく。
各ステップは「なぜ本物のエンジンにこの機能があるのか」の解像度を上げることが目的。

---

## Phase 6 — Hidden Class (Element Kind)

**動機**: quicksort の配列操作が Wasm JIT できない。`arr[i]` が「整数配列」だとわかれば Wasm linear memory で高速化できる。

### 6-1. Element Kind の追跡

配列に「中身が何型か」のメタデータを付ける。

```typescript
type ElementKind = "SMI" | "DOUBLE" | "GENERIC";
```

- `[1, 2, 3]` → SMI
- `[1.5, 2.5]` → DOUBLE
- `[1, "hello"]` → GENERIC
- 遷移は一方通行: SMI → DOUBLE → GENERIC

VM の `CreateArray`, `SetPropertyComputed`, `ArrayPush` で Element Kind を追跡。

### 6-2. Wasm linear memory で配列アクセス

Element Kind が SMI の配列を Wasm memory にコピーして `i32.load` / `i32.store` でアクセス。

```
arr[i]         → i32.load  (base + i * 4)
arr[i] = value → i32.store (base + i * 4)
```

バイトコードの `GetPropertyComputed` / `SetPropertyComputed` を Wasm に変換するルールを追加。

### 6-3. quicksort を Wasm JIT で実行

swap, partition, qsort を 1 つの Wasm モジュールにコンパイル。
同じ linear memory を共有し、配列コピーは最初と最後だけ。

**ゴール**: quicksort(200) が TW の 100 倍以上速くなる。

### 6-4. 型ガード + deopt

Element Kind が変わったら (例: 整数配列に文字列を代入) Wasm を無効化して VM にフォールバック。

---

## Phase 7 — Hidden Class (プロパティレイアウト)

**動機**: `obj.x` が毎回ハッシュ検索。同じ形のオブジェクトを大量に作るパターン (Point, Vec 等) でボトルネックになる。

### 7-1. HiddenClass 型の導入

```typescript
type HiddenClass = {
  properties: Map<string, number>;  // name → offset
  transitions: Map<string, HiddenClass>;  // 遷移チェーン
};

type JSObject = {
  __hidden_class: HiddenClass;
  __slots: unknown[];  // プロパティ値 (offset でアクセス)
};
```

### 7-2. 遷移チェーン

プロパティの追加順序で Hidden Class を共有。
`{ x: 1, y: 2 }` を 1000 個作っても Hidden Class は 1 つ。

```
HC_0 {} --("x")--> HC_1 { x: 0 } --("y")--> HC_2 { x: 0, y: 1 }
```

### 7-3. VM でのオフセットアクセス

```
// Before: ハッシュ検索
case "GetProperty":
  value = obj[name];

// After: Hidden Class でオフセット確定
case "GetProperty":
  value = obj.__slots[obj.__hidden_class.properties.get(name)];
```

### 7-4. Fast mode / Dictionary mode

- 通常: fast mode (Hidden Class + 固定オフセット)
- `delete obj.x` や大量の動的プロパティ追加: dictionary mode (ハッシュテーブル) に切り替え

**実測結果**: VM レベルでは効果なし (V8 の C++ IC が `obj[name]` を既に最適化しているため)。
JIT の基盤として意味がある。

---

## Phase 8 — Inline Cache (IC) ✅

**実測結果**: VM レベルでは逆に遅くなった。
```
Vec class (1000 iter), V8-JITless:
  TW:        10.4ms
  VM+HC+IC:  23.1ms  (0.45x — TW より遅い)
  Wasm:      0.004ms (3014x — 手書き Wasm で検証)
```

**学び**: HC + IC は **JIT でネイティブコードを生成して初めて効果を発揮する**。

---

## Phase 8+ — オブジェクト JIT

**動機**: HC + IC の真価は JIT にある。`obj.x` を `i32.load(base + offset)` に変換すれば 3014 倍速い。

やること:
- GetProperty / SetPropertyAssign / LoadThis → i32.load / i32.store
- Construct (new) → Wasm 内 bump allocator
- Vec の dot / add / constructor を Wasm 化

**ゴール**: Vec class の dot/add が自動的に Wasm JIT で動き TW の 100 倍以上速くなる。

---

## Phase 9 — 独自文字列表現

**動機**: jsmini は V8 の `string` 型をそのまま使っている (タダ乗り)。独自に実装すると「V8 がなぜ ConsString/SlicedString を持つのか」を体験できる。

### 9-1. JSString データ構造

```typescript
type SeqString = { kind: "seq"; data: Uint8Array; length: number };
type ConsString = { kind: "cons"; left: JSString; right: JSString; length: number };
type SlicedString = { kind: "sliced"; parent: JSString; offset: number; length: number };
type JSString = SeqString | ConsString | SlicedString;
```

- **SeqString**: 連続バイト列。基本形
- **ConsString**: 連結時にコピーせずポインタ 2 つ。O(1) の連結
- **SlicedString**: slice 時にコピーせず元への参照 + offset。O(1) の slice
- **Flatten**: ConsString を SeqString に変換 (読み取り時に遅延実行)

### 9-2. 全レイヤーの文字列操作を差し替え

- VM: `Add` (文字列連結)、比較、テンプレートリテラル
- TW: evaluator の文字列操作
- 型変換: `Number → String`、`String → Number`
- `console.log` の文字列表示

### 9-3. エンコーディング

V8 は ONE_BYTE (Latin1) と TWO_BYTE (UTF-16) を使い分ける。
jsmini は最小限として UTF-8 の ONE_BYTE だけで十分。

### 9-4. Intern 化

プロパティ名やリテラル文字列を intern 化して、`===` をポインタ比較に。
Hidden Class のプロパティ名も intern 化された文字列を使う。

**ゴール**: `"a" + "b"` が ConsString で O(1)。文字列連結の多いベンチで TW より速くなる。

### 見積もり

| 作業 | 行数 |
|------|------|
| JSString 型定義 + Flatten | ~110行 |
| 文字列操作関数群 | ~200行 |
| VM / TW の全文字列箇所の差し替え | ~250行 |
| 型変換 | ~80行 |
| テスト修正 | ~200行 |
| **合計** | **~840行** |

---

## Phase 10 — GC (自前の Mark-and-Sweep)

**動機**: Phase 7-9 で独自オブジェクト (JSObject, JSString) を大量に生成するようになると、メモリ管理が必要になる。今は生成したオブジェクトを解放しておらず、メモリリーク状態。

### 概要

- **Mark-and-Sweep** — 最小限の GC アルゴリズム
  1. ルートセット (グローバル変数、スタック、CallFrame の locals) からオブジェクトを辿る
  2. 到達可能なオブジェクトに mark をつける
  3. mark されていないオブジェクトを sweep (解放)
- 全ヒープオブジェクト (JSObject, JSString, JSArray) を追跡するアロケータ
- Stop-the-world: GC 中は JS の実行を停止

### 学べること

- なぜ GC が必要か — `new` するたびにメモリが増え、解放しないと溢れる
- Stop-the-world とは何か — GC 中に JS を実行するとオブジェクトが変わって追跡できない
- ルートセットとは何か — 「生きている」オブジェクトの起点
- Mark-and-Sweep の計算量 — 生きているオブジェクトに比例 (O(live objects))
- なぜ Generational GC が必要か — Mark-and-Sweep は全オブジェクトを毎回走査するので遅い

### Generational GC (発展)

- Young generation (Nursery): 新しいオブジェクト。大半はすぐ死ぬ
- Old generation (Tenured): 何回かの GC を生き延びたオブジェクト
- Minor GC: Young だけ走査 (高速)
- Major GC: 全世代を走査 (低頻度)

V8 の Orinoco GC は Generational + Concurrent + Incremental。jsmini では Stop-the-world の Mark-and-Sweep だけ実装し、Generational は説明のみ。

---

## Phase 10+ — Wasm GC 連携

**動機**: Phase 10 で自前 GC を理解した上で、Wasm GC を使えば **GC をホスト (V8) に任せられる**。Node.js v24 では Wasm GC がデフォルトで有効。

### Wasm GC とは

今の Wasm (MVP) は linear memory (バイト列) しか扱えない。オブジェクトや文字列は i32 のオフセットで管理し、GC がない。

Wasm GC proposal で追加されるもの:
- **`struct` 型** — フィールドを持つ GC 管理のオブジェクト
- **`array` 型** — GC 管理の配列
- **`ref` 型** — GC が追跡する参照 (i32 オフセットではない)
- **`struct.new`, `struct.get`, `struct.set`** — ヒープ上にオブジェクトを生成・アクセス

### 今の jsmini との比較

| 問題 | Phase 8E (linear memory) | Wasm GC |
|------|------------------------|---------|
| オブジェクト生成 | bump allocator (解放不可) | struct.new (GC が自動回収) |
| 参照の追跡 | i32 オフセット (GC が認識不可) | ref 型 (GC が追跡) |
| 文字列 | linear memory 不可 or バイトコピー | struct + array で ConsString 表現可能 |
| メモリ解放 | 不可 (メモリリーク) | GC が自動回収 |
| クロージャ | 不可 | ref で環境を参照可能 |

### jsmini での活用

Phase 9 の独自文字列 + Phase 10 の自前 GC を理解した上で:

```
Phase 10+: Wasm GC で JIT の対象を拡大
  - JSObject → Wasm GC struct にコンパイル
  - JSString (ConsString) → Wasm GC struct にコンパイル
  - 配列 → Wasm GC array にコンパイル
  - GC は V8 の Wasm GC ランタイムに任せる
  - 文字列操作を含むプログラムも JIT 対象に
```

**Phase 8E では数値とオブジェクトのプロパティアクセスだけ JIT できた。Wasm GC があれば文字列・クロージャ・動的オブジェクト生成も JIT 対象にできる。** これが「本物のエンジンが目指す姿」であり、Kotlin/Wasm や Dart/Wasm が Wasm GC を使う理由。

### 確認済み

Node.js v24 で Wasm GC (struct 型) がフラグなしで利用可能。

---

## ロードマップ

```
Phase 6: Hidden Class (Element Kind) ✅
  → quicksort が Wasm JIT で動く (6.1x)
  → 「なぜ V8 は配列の型を追跡するのか」

Phase 7: Hidden Class (プロパティレイアウト) ✅
  → obj.x がオフセットアクセスに
  → 「なぜ V8 は Hidden Class を持つのか」

Phase 8: Inline Cache ✅
  → HC + IC は VM では効果なし、JIT の基盤 (3014x in Wasm)
  → 「なぜ monomorphic が速いのか」

Phase 8E: オブジェクト JIT + コールバックインライン化 ✅
  → Vec dot/add が Wasm で 222x
  → reduce(add) がインライン展開で 364x

Phase 9: 独自文字列表現
  → ConsString / SlicedString / Intern 化
  → 「なぜ V8 は std::string を使わないのか」
  → 性能は劣化する (V8 の string をタダ乗りしなくなるため)

Phase 10: GC (自前の Mark-and-Sweep)
  → ルートセット、Mark-and-Sweep、Stop-the-world
  → 「なぜ GC が必要か」「なぜ Generational GC か」

Phase 10+: Wasm GC 連携
  → 自前 GC を理解した上で V8 の Wasm GC に委譲
  → 文字列・クロージャ・動的オブジェクト生成も JIT 対象に
  → 「JS エンジンの全レイヤーが繋がる」
```

---

## 書籍との対応

| 書籍の章 | jsmini の Phase | 学べること |
|---------|----------------|-----------|
| パーサー | Phase 1 | 再帰下降、ESTree、トークナイザ |
| インタプリタ | Phase 1-3 | Tree-Walking、Environment、スコープ |
| バイトコード VM | Phase 4 | スタックマシン、コンパイラ、dispatch |
| JIT コンパイラ | Phase 5-6, 8E | 型フィードバック、Wasm、deopt、インライン化 |
| Hidden Class | Phase 6-8 | Element Kind、遷移チェーン、IC |
| 文字列の内部表現 | Phase 9 | ConsString、エンコーディング、Intern 化 |
| GC | Phase 10 | Mark-and-Sweep、ルートセット、Generational |
| Wasm GC | Phase 10+ | struct/ref 型、GC ヒープ管理の委譲 |
