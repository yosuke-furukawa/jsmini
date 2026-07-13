# TODO Phase 33 — tagged slots: object JIT を参照対応に (RESEARCH-TaggedSlots)

## 動機

JIT が「数値コプロセッサ」である限界 (richards/deltablue/splay で
VM 差ほぼゼロ) を、tagged pointer (WasmGC i31ref + eq 階層) による
参照対応スロットで破る。設計・課題は RESEARCH-TaggedSlots.md 参照。

方針: 案 B (this-model のスロットを (ref eq) 化) を主軸、
数値専用関数は現行 linear memory モデルを維持する二本立て。

## ステップ

### 33-1: spike (設計の分岐点を先に潰す)

- [x] 33-1a: host ref の `any.convert_extern` + `ref.eq` が V8 で
      動くか (validate / 実行 / 同一オブジェクトで true か)。
      不成立なら object table (i31 index) フォールバックを採用
- [x] 33-1b: untag 往復 (ループ内 tag/untag) vs local 保持の
      マイクロベンチ — 表現選択パスの必要性を定量化
- [x] 33-1c: WasmGC array 経由の JS オブジェクト identity 保存確認
      (入れて出したら同一オブジェクトか)
- [x] 33-1d: 結果を RESEARCH-TaggedSlots.md に記録し、設計を確定

### 33-2: tagged this-model (spike の結果、案 C' = i32 Smi タグ + object table)

- [ ] 33-2a: copy-in で Smi タグ化 (value<<1) + object table 構築 (dedup、
      奇数 tag = index) + write-back
- [ ] 33-2b: 表現ガード (30bit 整数 / ref / null / undefined) を境界で検査 → deopt

### 33-3: codegen の tagged 対応

- [ ] 33-3a: tagged スロットの LoadProperty/StoreProperty emit
- [ ] 33-3b: 参照の identity / null 比較 (== / != / ===) と truthiness を Wasm 内で
- [ ] 33-3c: ネストアクセス __load_slot(tableIdx, offset) import (schedule 系向け)

### 33-4: 計測と判断

- [ ] 33-4a: richards / deltablue / splay で計測
- [ ] 33-4b: 「参照を持ち回るだけ」の解放範囲を実測 → 案 A
      (struct 移住) への投資判断を記録

### 33-5: まとめ

- [ ] 33-5a: LEARN-Phase33.md
- [ ] 33-5b: PR を Ready for review に
