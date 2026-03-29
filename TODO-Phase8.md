# TODO — Phase 8: Inline Cache (IC)

Hidden Class (Phase 7) でプロパティ名→オフセットのマッピングはできた。
IC でアクセス地点ごとにオフセットをキャッシュする。

**ゴール**: Vec class ベンチが IC なしより速くなる → **V8-JITless では効果なしと判明。**

---

## 8-0. IC スロットの設計

- [x] `src/vm/inline-cache.ts` — ICSlot 型 (uninitialized / monomorphic / polymorphic)
- [x] `createICSlot()`, `icLookup()`, `icUpdate()`
- [x] monomorphic: HC 1 つ + offset 1 つをキャッシュ

---

## 8-1. BytecodeFunction に IC スロット配列を追加

- [x] `BytecodeFunction.icSlotCount` — IC スロットの数
- [x] `Instruction.icSlot` — 命令が使う IC スロットのインデックス
- [x] コンパイラ: `emitWithIC` で GetProperty/SetProperty/SetPropertyAssign に IC 割り当て

---

## 8-2. VM の GetProperty / SetProperty に IC を組み込む

- [x] GetProperty: IC ヒット (`cachedHC === hc && cachedOffset >= 0`) → `slots[offset]` 直接アクセス
- [x] GetProperty: IC ミス / prototype 参照 → `jsObjGet` + IC 更新
- [x] SetProperty / SetPropertyAssign: Set 後に IC 更新
- [x] CallFrame に icSlots 配列を追加
- [x] テスト: 454 テスト全パス

---

## 8-3. ベンチマーク

- [x] Vec class: TW 10.2ms / VM+IC 22.9ms (0.45x)
  - Phase 7 (HC only, no IC): TW 10.8ms / VM 21.2ms (0.51x)
  - Phase 5 (before HC): TW 11ms / VM 19ms (0.58x)
  - **IC を入れてもむしろ遅くなった**

---

## 学んだこと

V8-JITless では IC の効果が出ない理由:

1. **IC ヒット判定 (`ic.cachedHC === hc`) 自体がコスト** — V8-JITless では参照比較 + 条件分岐が重い
2. **`getSlots(obj)[offset]` も関数呼び出し** — `obj[name]` のハッシュ検索と大差ない
3. **IC ミス時のオーバーヘッド** — `icUpdate` の呼び出しが追加コスト

V8 で IC が効く理由:
- TurboFan が IC ヒットを前提にネイティブコードを生成 (`mov eax, [obj+offset]`)
- IC ヒットのコード = **分岐なし、関数呼び出しなし、メモリアクセス 1 回**
- TypeScript では「IC ヒットのコード」自体が V8 のインタプリタ経由で実行されるので恩恵が消える

**結論**: Hidden Class + IC は **JIT でネイティブコードを生成して初めて効果を発揮する**。
TypeScript のインタプリタレベルでは、シンプルな `obj[name]` が最速。

---

## JIT でオブジェクトアクセスを Wasm 化した場合の検証

HC + IC の真価は JIT にある。手書き Wasm で Vec の add + dot ループを実装して検証:

```
Vec class (1000 iter), V8-JITless:
  TW:        10.4ms
  VM+HC+IC:  23.1ms  (0.45x — TW より遅い)
  Wasm:      0.004ms (3014x — TW の 3014 倍速い)
```

HC が `x = offset 0, y = offset 1` を知っているので、
JIT は `obj.x` → `i32.load(base + 0)` に変換できる。
オブジェクト全体を Wasm linear memory の連続バイトとして配置すれば、
プロパティアクセスが CPU のメモリアクセス 1 命令になる。

**HC + IC は VM の高速化ではなく JIT の基盤。**
- VM レベル: `obj[name]` (V8 の C++ IC) のほうが jsmini の JS IC より速い
- JIT レベル: HC のオフセット情報で `i32.load` に変換 → 3000 倍速い
