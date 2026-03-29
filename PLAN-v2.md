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

**動機**: HC でオフセットが決まっても毎回 `Map.get` で引くのは遅い。IC でキャッシュする。

**実測結果**: VM レベルでは逆に遅くなった。
```
Vec class (1000 iter), V8-JITless:
  TW:        10.4ms
  VM+HC+IC:  23.1ms  (0.45x — TW より遅い)
  Wasm:      0.004ms (3014x — 手書き Wasm で検証)
```

**学び**: HC + IC は **JIT でネイティブコードを生成して初めて効果を発揮する**。
V8 の Ignition は C++ レベルで IC を持っているので、jsmini が JS で IC を重ねても遅くなるだけ。

---

## Phase 8+（未実装）— オブジェクト JIT

**動機**: HC + IC の真価は JIT にある。`obj.x` を `i32.load(base + offset)` に変換すれば 3014 倍速い (手書き Wasm で検証済み)。

やること:
- IC が monomorphic な GetProperty を Wasm コンパイラで変換
- オブジェクトを Wasm linear memory に配置 (配列 JIT と同じ)
- Vec の add/dot ループ全体を Wasm 化
- 型ガード: HC が変わったら deopt

**ゴール**: Vec class ベンチが自動的に Wasm JIT で 1000 倍以上速くなる。

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

## Phase 10 — GC

**動機**: Phase 7-9 で独自オブジェクト (JSObject, JSString) を大量に生成するようになると、メモリ管理が必要になる。

### 概要

- Mark-and-Sweep (最小限の GC)
- 全オブジェクトを追跡するルートセット
- Generational GC (Young/Old) は Phase 10+ の発展として

これは V8 の GC の仕組みを理解するための実装。
実用的なメモリ管理ではなく、「なぜ GC が必要か」「Stop-the-world とは何か」の教育目的。

---

## ロードマップ

```
Phase 6: Hidden Class (Element Kind)
  → quicksort が Wasm JIT で動く
  → 「なぜ V8 は配列の型を追跡するのか」

Phase 7: Hidden Class (プロパティレイアウト)
  → obj.x がオフセットアクセスに
  → 「なぜ V8 は Hidden Class を持つのか」

Phase 8: Inline Cache
  → プロパティアクセスのキャッシュ
  → 「なぜ monomorphic が速いのか」

Phase 9: 独自文字列表現
  → ConsString / SlicedString
  → 「なぜ V8 は std::string を使わないのか」

Phase 10: GC
  → Mark-and-Sweep
  → 「なぜ GC が必要か」
```

各 Phase は独立しており、必要なものだけ実装できる。
Phase 6 だけで quicksort JIT + LEARN-HiddenClass.md が書ける。
Phase 9 は Phase 6-8 に依存しない (文字列は配列/オブジェクトとは別の話)。

---

## 書籍との対応

| 書籍の章 | jsmini の Phase | 学べること |
|---------|----------------|-----------|
| パーサー | Phase 1 | 再帰下降、ESTree、トークナイザ |
| インタプリタ | Phase 1-3 | Tree-Walking、Environment、スコープ |
| バイトコード VM | Phase 4 | スタックマシン、コンパイラ、dispatch |
| JIT コンパイラ | Phase 5-6 | 型フィードバック、Wasm、deopt |
| Hidden Class | Phase 6-8 | Element Kind、遷移チェーン、IC |
| 文字列の内部表現 | Phase 9 | ConsString、エンコーディング |
| GC | Phase 10 | Mark-and-Sweep、ルートセット |
