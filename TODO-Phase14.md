# TODO Phase 14 — WasmGC Array + ビルトイン自前実装

## 動機

### 14-1: WasmGC Array

現在の Wasm JIT は数値演算のみ Wasm 内で完結する。配列操作 (`arr[i]`) は
Wasm → ホスト境界を超えるため逆に遅くなる。

```
quicksort: TW 486ms / VM 448ms / JIT 499ms ← JIT が負けてる
fibonacci: TW 1630ms / VM 1063ms / JIT 0.42ms (3912x) ← 数値のみ → 圧勝
```

WasmGC の `array.new` / `array.get` / `array.set` を使えば配列を
Wasm GC ヒープ上に直接操作できる。既存の `wasm-gc-compiler.ts` は struct のみ対応。

### 14-2: ビルトイン自前実装

VM が V8 のネイティブ `Array`, `String` 等をそのまま使っている（ズル）。
test262 で VM が TW より 284件多く通るのはこれが原因。
教育用エンジンとしてはビルトインを自前で実装すべき。

## 現状

```
test262 VM:  3,964 / 8,947 (44.3%)
test262 TW:  3,680 / 8,947 (41.1%)
差: 284件 (ネイティブ委譲による)
ユニットテスト: 584
```

## ステップ

### 14-1: WasmGC Array

- [x] 14-1a: WasmGC array 型定義の追加
  - `wasm-builder.ts`: array_new, array_get, array_set, array_len opcodes
  - addArray() メソッド、LocalGroup 対応、funcTypeOffset

- [x] 14-1b: 配列パラメータの WasmGC array 変換
  - 配列パラメータ: i32 → (ref $i32_array) に変更
  - ヘルパー関数: __create_array, __get_array, __set_array
  - JS ↔ WasmGC Array 変換: ヘルパー経由で opaque ref を受け渡し

- [x] 14-1c: `GetPropertyComputed` / `SetPropertyComputed` の JIT 対応
  - `arr[i]` → `0xfb, array_get, typeIdx`
  - `arr[i] = v` → `0xfb, array_set, typeIdx`
  - linear memory の i32.load/i32.store アドレス計算を完全に置換

- [x] 14-1d: `arr.length` の JIT 対応
  - `0xfb, array_len` で取得

- [x] 14-1e: quicksort ベンチマーク検証
  - quicksort JIT: 61ms (8.1x vs TW) ← linear memory 不要
  - swap + partition が Wasm コンパイルされ配列操作が Wasm 内で完結
  - ※ LdaUpvalue → LdaGlobal 修正も必要だった（JIT の関連関数検出）

- [x] 14-1f: LdaUpvalue → LdaGlobal 修正
  - トップレベル関数への参照が upvalue 経由だと JIT が検出できない問題
  - 親がトップレベルの場合は LdaGlobal を優先するように修正

### 14-2: ビルトイン自前実装

- [ ] 14-2a: Array コンストラクタ自前実装
  - `Array()`, `Array(n)`, `Array.isArray()`
  - `new Array()` 対応

- [ ] 14-2b: Array.prototype メソッド自前実装
  - `push`, `pop`, `shift`, `unshift`
  - `map`, `filter`, `reduce`, `forEach`
  - `find`, `some`, `every`, `indexOf`, `includes`
  - `slice`, `splice`, `concat`, `join`
  - `sort` (比較関数対応)

- [ ] 14-2c: String.prototype メソッド自前実装
  - 現在 VM の stringPrototype に登録済みのものを確認
  - 不足分を追加

- [ ] 14-2d: ネイティブ委譲の除去
  - `vm.setGlobal("Array", Array)` → 自前 Array に
  - `vm.setGlobal("Boolean/Number/String", ...)` → 自前に
  - TW 側も同様に統一

- [ ] 14-2e: test262 差分検証
  - VM と TW の test262 pass 数が同等になること
  - 目標: 差 50件以内

## 技術メモ

### WasmGC Array の命令

```wasm
;; 型定義
(type $i32_array (array (mut i32)))

;; 配列作成 (要素数 n)
array.new $i32_array  ;; (init_value, length) → (ref $i32_array)

;; 要素アクセス
array.get $i32_array  ;; (ref, index) → i32
array.set $i32_array  ;; (ref, index, value) → void

;; 長さ
array.len             ;; (ref) → i32
```

### JS Array → WasmGC Array の変換

```
Call 時: arr の各要素を array.set で WasmGC array にコピー
Return 時: WasmGC array の各要素を array.get で JS Array にコピーバック
→ linear memory 方式と同じだが、GC 管理なのでメモリリークしない
```

### 既存の wasm-gc-compiler.ts との関係

現在は struct (Vec 等のオブジェクト) のみ対応。
配列は別のコードパスで処理する必要がある（struct と array は WasmGC の別の型）。
`wasm-compiler.ts` (通常の JIT) に array 対応を追加するのが素直。
