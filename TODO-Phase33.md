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

- [x] 33-2a: copy-in で Smi タグ化 (value<<1) + object table 構築 (dedup、
      奇数 tag = index) + write-back
- [x] 33-2b: 表現ガード (30bit 整数 / ref / null / undefined) を境界で検査 → deopt

### 33-3: codegen の tagged 対応

- [x] 33-3a: tagged スロットの LoadProperty/StoreProperty emit
- [x] 33-3b: 参照の identity / null 比較 (== / != / ===) と truthiness を Wasm 内で
- [x] 33-3c: ネストアクセス __load_slot(tableIdx, offset) import (schedule 系向け)

### 33-4: 計測と判断

- [x] 33-4a: richards / deltablue / splay で計測
- [x] 33-4b: 「参照を持ち回るだけ」の解放範囲を実測 → 案 A
      (struct 移住) への投資判断を記録

### 33-5: まとめ

- [x] 33-5a: LEARN-Phase33.md
- [x] 33-5b: PR を Ready for review に

## 33-3 完了時メモ

- ネストアクセス (__load_slot import) 実装済み: 2 段ネスト読み・ネスト値の
  identity 比較・prototype プロパティの deopt が動作 (回帰テスト 10 ケース)
- 既知制約 (v1): range 分析で f64 昇格する関数 (ループ内 n+1 等) は tagged
  無効 → 連結リスト走査形はまだ VM。対策候補: tagged 値専用の i32 local
  グループ (f64 関数内でも tagged を i32 で持つ)
- 33-4 で要調査: deltablue が 327ms (以前 ~200ms) — tagged 化で compile
  対象が増え、ネスト import が熱いパスで VM インライン実行より高くつく
  疑い。per-関数の勝ち負け判定 (import 回数 × コスト) か、ネスト頻度が
  高い関数は tagged 降格、のどちらかが必要

## 33-6 (WIP): tagged が本領を発揮できない真因と対策 (次セッション)

「tagged 有利ベンチ」(token-ring: 参照 move + identity + null チェックのみの
ホットループ) を作って計測した結果、**コンパイルされず JIT 0.8x** と判明。
掘った真因の連鎖:

1. **param 有界のループカウンタですら range 分析で i32 をわずかに超える**
   (i < n の n が range 未知 → i+1 の max が i32max+α) → ループを含む
   関数はほぼ全部 f64 昇格
2. tagged は `!useF64` ゲートで無効化 → **ループ持ち関数で tagged が
   実質使えない** (richards/deltablue の熱い関数は全部ループ持ち)
3. f64 関数で tagged を有効にする試み (i32 local グループ追加 +
   Load/Store/比較/Return の変換スキップ) は大半動いたが、
   **LoadThis の spill と null 定数の phi 入力が f64 local に落ちて型崩れ**
   が残った (要: LoadThis/null 定数も i32 リージョンへ + null-phi の扱い)

対策候補 (優先順):
- (a) LoadThis に i32 local リージョンを適用 (tagged と同じ機構) —
  これは f64+this 関数の既存の silent CompileError も直す
- (b) null/undefined 定数の needsLocal 化を tag 値 emit + i32 リージョンで
- (c) range 分析の「param 有界ループ」の widen を i32 に丸める
  (V8 の bounds check 的な仮定 + ガード)
