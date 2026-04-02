# Phase 14: WasmGC Array + ビルトイン自前実装

## 概要

Phase 14 では2つのことをやった:
1. Wasm JIT の配列操作を linear memory から **WasmGC Array** に置き換え
2. V8 ネイティブに委譲していたビルトイン関数を**自前実装**に置き換え

どちらも「ホスト環境に頼らず、自前でやる」という方向の変更。

---

## 1. WasmGC Array — なぜ GC 管理の型が Wasm に必要か

### 問題: linear memory で配列を扱う辛さ

Phase 6 で実装した配列の JIT は linear memory 方式:

```
JS Array [3, 1, 2]
    ↓ コピー
linear memory: [length=3][3][1][2]   (Int32Array ビュー)
    ↓ Wasm 内でアクセス
arr[i] → i32.load(base + 4 + i * 4)   (アドレス計算)
    ↓ 実行後コピーバック
JS Array [1, 2, 3]
```

これには3つの問題がある:

1. **手動メモリ管理**: 配列をどこに配置するか、複数の配列が重ならないか、解放はいつか
2. **アドレス計算**: `base + 4 + idx * 4` を毎回計算。ヘッダ分の +4 を忘れるとバグ
3. **コピーコスト**: 実行前にJS → memory、実行後に memory → JS のコピーが必要

### 解決: WasmGC Array

WasmGC (Garbage Collection proposal) は Wasm に GC 管理の型を追加する:

```wasm
;; 型定義
(type $i32_array (array (mut i32)))

;; 配列作成
array.new $i32_array   ;; (init_value, length) → (ref $i32_array)

;; 要素アクセス
array.get $i32_array   ;; (arr_ref, index) → i32
array.set $i32_array   ;; (arr_ref, index, value) → void

;; 長さ
array.len              ;; (arr_ref) → i32
```

jsmini の JIT をこれに置き換えると:

```
JS Array [3, 1, 2]
    ↓ __create_array(3) + __set_array でコピー
WasmGC Array (ref $i32_array)   ← GC が管理
    ↓ Wasm 内で直接アクセス
arr[i] → array.get $i32_array arr i   (アドレス計算不要)
    ↓ __get_array でコピーバック
JS Array [1, 2, 3]
```

### Before vs After

| | linear memory | WasmGC Array |
|---|---|---|
| メモリ管理 | 手動 (base offset 計算) | GC が自動管理 |
| bounds check | なし (バグれば segfault) | 自動 (out of bounds → trap) |
| アクセス | `i32.load(base + 4 + idx * 4)` | `array.get type arr idx` |
| 関数パラメータ | `i32` (メモリポインタ) | `(ref $i32_array)` |
| 複数配列 | offset が重ならないよう管理 | 各 ref が独立 |

### quicksort ベンチマーク

```
quicksort (200 elements x10):
  Tree-Walking: 498ms
  Bytecode VM:  449ms
  Wasm JIT:     61ms (8.1x faster)
```

`swap` と `partition` が Wasm にコンパイルされ、配列操作が `array.get` / `array.set` で
Wasm 内で完結する。`qsort` の再帰呼び出し自体は VM で実行されるが、ホットな内側ループ
(`partition`) が Wasm で走るので全体が高速化。

### 実装で学んだこと

**ヘルパー関数パターン**: JS から WasmGC の参照型オブジェクトを直接作れないため、
Wasm モジュール内にヘルパー関数を用意する:

```
__create_array(len: i32) → (ref $i32_array)   // array.new で作成
__get_array(arr, idx) → i32                     // array.get で読む
__set_array(arr, idx, val) → void               // array.set で書く
```

JS 側はこれらを export から取得して呼ぶ。返される ref は JS にとって opaque
(中身が見えない) だが、そのまま別の Wasm 関数に渡せる。

**V8 との対比**: V8 の TurboFan も同じ課題を持っている。JS の配列は GC ヒープ上の
オブジェクトなので、最適化コードから直接アクセスするには GC と協調する必要がある。
V8 は自前のコンパイラでネイティブコードを生成するから内部構造に直接アクセスできるが、
Wasm JIT ではそれができない。WasmGC はこのギャップを埋める。

### LdaUpvalue → LdaGlobal の修正

実装過程で、quicksort の `partition` が JIT されない問題に遭遇した。

原因: `partition` 内の `swap` 呼び出しが `LdaUpvalue`（クロージャ変数参照）で
コンパイルされていた。JIT は `LdaGlobal + Call` パターンで関連関数を検出するため、
upvalue 経由だと検出できない。

修正: トップレベル関数への参照は `LdaGlobal` を優先するように変更。
これは V8 でも同様で、グローバル関数呼び出しは IC (Inline Cache) で最適化されるが、
クロージャ経由だと最適化が効きにくい。

---

## 2. ビルトイン自前実装 — エンジンの「境界」はどこか

### 問題: ネイティブ委譲は「ズル」

以前の VM は V8 のネイティブ Array をそのまま使っていた:

```ts
vm.setGlobal("Array", Array);  // V8 の Array をそのまま渡す
```

これだと `[1,2,3].map(...)` は V8 の `Array.prototype.map` が実行される。
jsmini のエンジンは何もしていない。test262 が通るのは V8 のおかげ。

### 自前実装

Array コンストラクタとプロトタイプメソッドを全て自前で実装:

```ts
// Array コンストラクタ
const ArrayCtor = function(...args) {
  if (args.length === 1 && typeof args[0] === "number") return new Array(args[0]);
  return [...args];
};
ArrayCtor.isArray = (v) => Array.isArray(v);
ArrayCtor.from = (iterable) => { /* 自前実装 */ };

// Array.prototype
vm.arrayPrototype = {
  push(this, ...items) { /* 自前 */ },
  pop(this) { /* 自前 */ },
  slice(this, start, end) { /* 自前 */ },
  sort(this, fn) { /* insertion sort */ },
  map(this, fn) { /* vm.callFunction で jsmini の関数を呼ぶ */ },
  // ... 20+ メソッド
};
```

### Boolean / Number / String のラッパー

`new Boolean(true)` は「Boolean ラッパーオブジェクト」を返す必要がある:

```ts
function BooleanCtor(v) {
  if (new.target) {
    // new Boolean(true) → ラッパーオブジェクト
    this.valueOf = () => !!v;
    return;
  }
  // Boolean(v) → プリミティブ変換
  return !!v;
}
```

`new.target` で `new` 呼び出しかどうかを判定。V8 の組み込みコンストラクタも
同じ分岐を持っている（仕様 §20.3.1 Boolean Constructor）。

### 結果

| | Before (ネイティブ委譲) | After (自前) |
|---|---|---|
| VM test262 | 3,964 (44.3%) | 3,945 (44.1%) |
| TW test262 | 3,680 (41.1%) | 3,680 (41.1%) |
| VM/TW 差 | 284件 | 265件 |

ネイティブ委譲を外しても **19件しか減らなかった** (3,964 → 3,945)。
つまり自前の Array.prototype.map/filter/sort 等がほぼ正しく動いている。

### V8 のビルトインとの対比

V8 のビルトイン関数は:
- 昔: C++ で手書き (V8 内部 API を直接使う)
- 今: **Torque** (V8 独自の DSL) で記述 → CSA (CodeStubAssembler) にコンパイル

なぜ JS ではなく専用言語で書くのか:
1. **GC との協調**: ビルトイン関数の実行中に GC が走る可能性がある。Torque は GC セーフポイントを自動挿入
2. **型の直接操作**: JS の `Array` は内部的には複数の表現 (SMI array, packed doubles, holey array 等) を持つ。Torque はこれを直接判定・操作できる
3. **パフォーマンス**: `Array.prototype.sort` は毎フレーム何千回も呼ばれうる。ネイティブコードで書くことで JIT 不要で高速

jsmini では JS (TypeScript) でビルトインを書いたが、これは V8 が Torque で書く理由を
逆説的に示している。教育用エンジンなら JS で十分だが、プロダクションエンジンでは
GC 協調 + 型最適化のために専用言語が必要になる。

---

## まとめ

Phase 14 の2つの変更は「ホスト環境への依存を減らす」という共通のテーマ:

| | Before | After | 学び |
|---|---|---|---|
| 配列 JIT | linear memory (手動管理) | WasmGC Array (GC 管理) | GC 言語の JIT には GC 対応の IR が必要 |
| ビルトイン | V8 ネイティブ委譲 | 自前実装 | エンジンの「境界」を意識する |

quicksort: 498ms → 61ms (WasmGC Array)
fibonacci: 1630ms → 0.42ms (既存 JIT)
test262 VM: 44.1% (ズルなし)
