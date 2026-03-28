# Hidden Class (V8 Map) の仕組みと jsmini への適用

## なぜ Hidden Class が必要か

jsmini の Wasm JIT は fibonacci や ackermann (数値のみ) を 1000 倍以上高速化できた。
しかし quicksort (配列操作あり) は JIT できない。

```
swap(arr, i, j):
  arr[i]         → GetPropertyComputed → Wasm にできない
  arr[i] = value → SetPropertyComputed → Wasm にできない
```

Wasm にできない理由: **jsmini の配列はただの `Record<string, unknown>`** で、
中身が整数だけなのか、文字列が混ざっているのか、実行時にしかわからない。

V8 が `arr[i]` を 1 命令のメモリアクセスに変換できるのは、
**Hidden Class で配列の Element Kind を追跡している** から。

---

## V8 の Hidden Class (Map) の構造

V8 内部では Hidden Class を **Map** と呼ぶ。全オブジェクトが Map を持つ。

### プロパティレイアウト

```js
var p1 = { x: 1, y: 2 };
var p2 = { x: 3, y: 4 };
```

V8 内部:
```
HiddenClass_A {
  properties: [
    { name: "x", offset: 0 },
    { name: "y", offset: 1 },
  ]
}

p1 → { __map: HiddenClass_A, __slots: [1, 2] }
p2 → { __map: HiddenClass_A, __slots: [3, 4] }
```

`p1.x` のアクセス:
```
// Hidden Class なし (jsmini の現状)
value = hashmap_lookup(obj, "x");  // 文字列キーでハッシュ検索

// Hidden Class あり (V8)
value = obj.__slots[0];  // offset 0 を直接読む (1 命令)
```

**プロパティ名の検索をオフセットのメモリアクセスに変換** するのが Hidden Class の役割。

### 遷移チェーン (Transition Chain)

プロパティが追加されると新しい Hidden Class に遷移する:

```js
var obj = {};       // HC_0: {}
obj.x = 1;          // HC_0 → HC_1: { x: offset 0 }
obj.y = 2;          // HC_1 → HC_2: { x: offset 0, y: offset 1 }
```

```
HC_0 {} --("x")--> HC_1 { x: 0 } --("y")--> HC_2 { x: 0, y: 1 }
```

同じ順番でプロパティを追加するオブジェクトは **同じ遷移チェーン** を辿る:

```js
// 全部 HC_2 を共有
var p1 = { x: 1, y: 2 };
var p2 = { x: 3, y: 4 };
var p3 = { x: 5, y: 6 };
// → Hidden Class は 1 個だけ。メモリ効率が良い
```

逆に、プロパティの追加順序が違うと別の Hidden Class になる:

```js
var a = {}; a.x = 1; a.y = 2;  // HC_2: { x: 0, y: 1 }
var b = {}; b.y = 1; b.x = 2;  // HC_X: { y: 0, x: 1 } — 別の Hidden Class!
```

これが「V8 ではオブジェクトのプロパティは常に同じ順番で追加すべき」というパフォーマンスティップスの理由。

### Element Kind (配列用)

配列の中身の型を Hidden Class に記録する:

```js
var arr = [1, 2, 3];      // PACKED_SMI_ELEMENTS — 整数のみ
arr.push(3.14);            // → PACKED_DOUBLE_ELEMENTS — 浮動小数に遷移
arr.push("hello");         // → PACKED_ELEMENTS — 汎用に遷移 (最も遅い)
```

V8 の Element Kind 一覧:
```
PACKED_SMI_ELEMENTS       — 穴なし整数配列 (最速)
PACKED_DOUBLE_ELEMENTS    — 穴なし浮動小数配列
PACKED_ELEMENTS           — 穴なし一般配列
HOLEY_SMI_ELEMENTS        — 穴あり整数配列
HOLEY_DOUBLE_ELEMENTS     — 穴あり浮動小数配列
HOLEY_ELEMENTS            — 穴あり一般配列 (最も遅い)
```

遷移は **一方通行** — 一度 GENERIC に落ちたら SMI には戻れない:
```
PACKED_SMI → PACKED_DOUBLE → PACKED_ELEMENTS
     ↓             ↓                ↓
HOLEY_SMI  → HOLEY_DOUBLE  → HOLEY_ELEMENTS
```

穴あり (Holey) は `delete arr[1]` や `arr[100] = 1` (中間をスキップ) で発生する。
穴あり配列は `arr[i]` のアクセスで穴チェック + prototype chain 探索が追加で走るので遅い。

### Inline Cache (IC)

Hidden Class と組み合わせてプロパティアクセスをキャッシュする:

```
// 初回実行: obj.x
//   1. obj の Hidden Class を取得
//   2. Hidden Class で "x" を検索 → offset 0
//   3. IC に記録: { hiddenClass: HC_A, offset: 0 }

// 2 回目以降: obj.x
//   1. IC を確認
//   2. obj の Hidden Class が HC_A か比較 (1 命令)
//   3. 一致 → offset 0 を直接読む (1 命令)
//   → 合計 2 命令でプロパティアクセス完了
```

IC の状態遷移:
```
uninitialized → monomorphic → polymorphic → megamorphic
                (1 種の HC)   (2-4 種)      (5 種以上)
```

- **monomorphic**: 1 つの Hidden Class しか見たことがない → 最速。1 回の比較で OK
- **polymorphic**: 2〜4 種の Hidden Class → 線形探索だがまだ速い
- **megamorphic**: 多すぎ → IC を諦めて毎回ハッシュ検索。TurboFan での最適化もできない

---

## jsmini に必要な最小実装

quicksort の配列 JIT に必要なのは **Element Kind だけ**。
プロパティレイアウトや Inline Cache は配列 JIT には不要。

### 最小 Hidden Class (Element Kind のみ)

```typescript
type ElementKind = "SMI" | "DOUBLE" | "GENERIC";

const ELEMENT_KIND = Symbol("__elementKind");
const ELEMENTS = Symbol("__elements");

type JSArray = unknown[] & {
  [ELEMENT_KIND]: ElementKind;
  [ELEMENTS]: number[];  // SMI/DOUBLE の場合の型付き backing store
};
```

### 配列操作での Element Kind 追跡

```typescript
// CreateArray: 初期要素から Element Kind を決定
function createTrackedArray(elements: unknown[]): JSArray {
  const arr = [...elements] as JSArray;
  arr[ELEMENT_KIND] = classifyElements(elements);
  return arr;
}

// SetPropertyComputed: 代入時に Element Kind を更新
function setElement(arr: JSArray, index: number, value: unknown): void {
  arr[index] = value;
  if (arr[ELEMENT_KIND] === "SMI" && typeof value !== "number") {
    arr[ELEMENT_KIND] = "GENERIC";  // 一方通行の遷移
  }
}

function classifyElements(elements: unknown[]): ElementKind {
  for (const el of elements) {
    if (typeof el !== "number") return "GENERIC";
    if (!Number.isInteger(el)) return "DOUBLE";
  }
  return "SMI";
}
```

### JIT での活用

```typescript
// 型フィードバック拡張
function classifyArg(value: unknown): string {
  if (Array.isArray(value) && value[ELEMENT_KIND] === "SMI") {
    return "smi_array";
  }
  // ... 既存の数値型分類
}

// Wasm コンパイル時
// arg が "smi_array" → Wasm linear memory にコピーして i32.load/store
// 型ガード: Element Kind が SMI でなければ deopt
```

### Wasm linear memory での配列アクセス

```
// jsmini bytecode           → Wasm
LdaLocal 0                   // arr (= memory base address)
LdaLocal 1                   // i
GetPropertyComputed          // arr[i]
                             ↓
local.get 1                  // i
i32.const 4
i32.mul                      // i * 4
local.get 0                  // base
i32.add                      // base + i * 4
i32.load                     // memory[base + i * 4]
```

---

## 段階的な実装計画

### Phase 1: Element Kind のみ (配列 JIT の基盤)

1. JSArray 型に Element Kind を追加
2. VM の CreateArray, SetPropertyComputed で Element Kind を追跡
3. 型フィードバックで `"smi_array"` を認識
4. Wasm linear memory + i32.load/i32.store で配列アクセス
5. quicksort が Wasm JIT で動く

### Phase 2: プロパティレイアウト (オブジェクト最適化)

1. HiddenClass 型を導入 (properties Map)
2. 遷移チェーンを実装
3. オブジェクト生成時に Hidden Class を割り当て
4. GetProperty/SetProperty でオフセットアクセス

### Phase 3: Inline Cache

1. バイトコードの GetProperty/SetProperty に IC スロットを追加
2. monomorphic → polymorphic → megamorphic の遷移
3. JIT で IC ヒット前提のネイティブコード生成 + 型ガード

---

## jsmini の現状との差

| 機能 | V8 | jsmini (現状) | jsmini (Phase 1 後) |
|------|-----|-------------|-------------------|
| プロパティアクセス | offset (1 命令) | ハッシュ検索 | ハッシュ検索 (変更なし) |
| 配列アクセス | elements[i] + bounds check | `obj[String(i)]` | Element Kind で判定 → JIT 可 |
| Element Kind | 6 種類 + 遷移追跡 | なし | SMI/DOUBLE/GENERIC |
| Inline Cache | monomorphic/polymorphic/megamorphic | なし | なし |
| JIT (配列) | 型ガード + 直接メモリアクセス | 不可 | linear memory + i32.load |
| JIT (オブジェクト) | IC ベースのオフセットアクセス | 不可 | 不可 |

Phase 1 だけで quicksort の JIT が可能になる。
Phase 2-3 はオブジェクト操作の高速化で、別の機会に。

---

## V8 の Hidden Class (Map) の全機能セット

V8 内部で Hidden Class は **Map** と呼ばれる。全オブジェクトの先頭ポインタが Map を指す。
「フルで実装する」とは以下の全機能を実装すること。

### 1. プロパティレイアウト (Property Storage)

#### Descriptor Array

Map が持つプロパティ情報のテーブル。プロパティの名前、格納位置 (offset)、属性 (writable/enumerable/configurable) を持つ。

```
HiddenClass (Map) → DescriptorArray:
  [0] { name: "x", offset: 0, attributes: writable }
  [1] { name: "y", offset: 1, attributes: writable }
```

複数の Map が **同じ DescriptorArray を共有** できる。各 Map は「自分が使うのは先頭 N 個まで」という情報を持ち、遷移チェーンの途中段階の Map が同じ配列を参照する。メモリ効率のための工夫。

#### In-object properties vs Properties backing store

```js
var obj = { x: 1, y: 2, z: 3 };
```

V8 内部:
```
obj {
  __map: HiddenClass_A,
  // in-object properties (オブジェクト内に直接格納、最速)
  i0: 1,  // x
  i1: 2,  // y
  i2: 3,  // z
}
```

オブジェクト生成時に V8 は「このオブジェクトはプロパティ N 個分のスロットを持つ」と予測してメモリを確保する。スロットが足りなくなると **Properties backing store** (外部配列) に溢れる:

```
obj {
  __map: HiddenClass_B,
  i0: 1,  // x (in-object)
  i1: 2,  // y (in-object)
  __properties: [3, 4, 5],  // z, w, v (溢れた分)
}
```

In-object は 1 回のメモリアクセス (オブジェクトポインタ + 固定 offset)。
Backing store は 2 回 (オブジェクト → properties ポインタ → 配列 + offset)。

#### Fast mode vs Dictionary mode (Slow mode)

通常はプロパティの追加順序に従った **fast mode** (DescriptorArray + 固定 offset)。
以下の条件で **dictionary mode** (ハッシュテーブル) に切り替わる:

- `delete obj.x` でプロパティを削除した
- 同一の Map から大量の遷移が発生した (遷移チェーンが爆発)
- 動的なプロパティ名を大量に追加した

Dictionary mode は追加・削除が効率的だが、アクセスが遅い (ハッシュ検索)。
**jsmini の現状は全オブジェクトが dictionary mode 相当。**

### 2. 遷移チェーン (Transition Tree)

#### 基本構造

プロパティの追加ごとに新しい Map に遷移する。同じ順序で追加すると同じ遷移パスを辿る。

```
Map_0 {} --("x")--> Map_1 { x: i0 } --("y")--> Map_2 { x: i0, y: i1 }
```

遷移は **TransitionArray** として各 Map に格納される:

```
Map_0.transitions = { "x" → Map_1 }
Map_1.transitions = { "y" → Map_2 }
```

新しいプロパティを追加するとき、まず既存の遷移を検索する。存在すればその Map を再利用。なければ新しい Map を作成して遷移に登録。

#### Back pointer

各 Map は 1 つ前の Map への参照 (back pointer) を持つ。deopt 時に「プロパティを削除した状態」の Map に戻るために使う。

#### Slack tracking

オブジェクト生成直後は「まだプロパティが追加されるかも」と多めにスロットを予約する (slack)。
一定回数の生成後、未使用スロットの数が安定したら slack を shrink してメモリ節約。

```
// 最初の数回
new Point(x, y) → スロット 4 個確保 (slack = 2)
// 安定後
new Point(x, y) → スロット 2 個確保 (slack = 0)
```

### 3. Element Kind (配列用)

V8 は 21 種類の Element Kind を区別する。主要な 6 種:

```
                   PACKED                HOLEY
SMI 整数:          PACKED_SMI_ELEMENTS   HOLEY_SMI_ELEMENTS
DOUBLE 浮動小数:   PACKED_DOUBLE_ELEMENTS HOLEY_DOUBLE_ELEMENTS
GENERIC 汎用:      PACKED_ELEMENTS       HOLEY_ELEMENTS
```

#### 遷移ルール (一方通行)

```
PACKED_SMI → PACKED_DOUBLE → PACKED_ELEMENTS
     ↓             ↓               ↓
HOLEY_SMI  → HOLEY_DOUBLE  → HOLEY_ELEMENTS
```

- **SMI → DOUBLE**: `arr.push(3.14)` で浮動小数を追加
- **DOUBLE → GENERIC**: `arr.push("hello")` で非数値を追加
- **PACKED → HOLEY**: `arr[100] = 1` で中間に穴を作る、または `delete arr[1]`
- **一方通行**: 一度 GENERIC/HOLEY になったら戻れない

#### PACKED vs HOLEY の性能差

PACKED:
```c
// arr[i] アクセス
value = elements[i];  // bounds check + 1 回のメモリアクセス
```

HOLEY:
```c
// arr[i] アクセス
value = elements[i];
if (value == THE_HOLE) {
  // 穴 → prototype chain を辿って探索
  value = lookup_prototype_chain(arr, i);  // 重い
}
```

#### V8 の配列最適化のベストプラクティス

1. **配列リテラルを使う**: `[1, 2, 3]` は `new Array(3)` より速い (Element Kind が即座に確定)
2. **型を混ぜない**: `[1, 2, "three"]` は GENERIC になる
3. **穴を作らない**: `arr[100] = 1` で HOLEY 化
4. **`-0`, `NaN`, `Infinity` に注意**: SMI → DOUBLE に遷移する

### 4. Inline Cache (IC)

プロパティアクセスのたびに Hidden Class を検索するのは遅い。IC はアクセス箇所ごとにキャッシュを持つ。

#### IC の状態

```
uninitialized → monomorphic → polymorphic → megamorphic
                 (1 種の Map)  (2-4 種)       (5 種以上)
```

**monomorphic (最速)**:
```
// obj.x のアクセス地点
IC: { map: Map_A, offset: 0 }

// 実行時
if (obj.__map === Map_A) {       // 1 回の比較
  return obj.__slots[0];          // 直接アクセス
}
// miss → polymorphic に遷移
```

**polymorphic**:
```
IC: [
  { map: Map_A, offset: 0 },
  { map: Map_B, offset: 1 },
  { map: Map_C, offset: 0 },
]
// 線形探索 (2-4 回の比較)
```

**megamorphic (最遅)**:
```
// IC を諦め、毎回グローバルハッシュテーブルで検索
// TurboFan もこのアクセスを最適化できない
```

#### IC と JIT の連携

TurboFan は IC のデータを使って型特殊化する:

```
// IC が monomorphic (Map_A, offset 0) の場合
// TurboFan が生成するネイティブコード:
function get_x_optimized(obj) {
  if (obj.__map !== Map_A) goto deopt;  // 型ガード
  return obj.__slots[0];                 // インライン化されたアクセス
}
```

IC が polymorphic/megamorphic だと TurboFan の最適化効果が下がる。これが「同じ形のオブジェクトを使え」というパフォーマンスアドバイスの理由。

### 5. Const tracking (フィールド定数追跡)

Map はプロパティが **一度も書き換えられたことがないか** を追跡する。

```js
function Point(x, y) { this.x = x; this.y = y; }
Point.prototype.toString = function() { return this.x + "," + this.y; };
```

`Point.prototype.toString` が一度も書き換えられなければ、TurboFan は:
- `p.toString()` を直接インライン化できる
- 仮想関数テーブルの検索が不要

書き換えが発生したら **field-const** の deopt reason で最適化を破棄。

### 6. Map migration

Map の構造が変更されたとき (例: プロパティの型が変わった)、
古いオブジェクトを新しい Map に移行する仕組み。

```js
var obj = { x: 1 };   // Map_A: x は Smi
obj.x = 3.14;          // Map_A → Map_A': x は Double
// 他の Map_A を持つオブジェクトも Map_A' に移行が必要
```

---

## jsmini で実装する意味があるもの

| 機能 | V8 の目的 | jsmini での必要度 | 理由 |
|------|----------|-----------------|------|
| **Element Kind** | 配列アクセスの型特殊化 | **高** | 配列 JIT に必須。quicksort を Wasm で動かすため |
| **プロパティレイアウト** | obj.x を offset アクセスに | 中 | VM の dispatch 削減になるが、配列 JIT には不要 |
| **遷移チェーン** | 同じ形のオブジェクトの Map 共有 | 中 | メモリ効率。教育的にも面白い |
| **Inline Cache** | プロパティアクセスのキャッシュ | 中 | VM 高速化。JIT の型特殊化の基盤 |
| **Const tracking** | 定数フィールドのインライン化 | 低 | TurboFan レベルの最適化。jsmini では不要 |
| **Map migration** | 型変更時の旧オブジェクト移行 | 低 | 大規模アプリ向け。教育用には不要 |
| **Slack tracking** | 未使用スロットのメモリ最適化 | 低 | メモリ最適化。教育用には不要 |

**推奨: Element Kind → プロパティレイアウト → IC の順で実装。**
Element Kind だけで quicksort の Wasm JIT が可能になり、書籍の「なぜ Hidden Class が必要か」の説明材料として十分。
