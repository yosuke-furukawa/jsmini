# LEARN-Phase33.md — tagged slots: Smi を再発明して V8 に還る

## やったこと

JIT の「数値専用」制約を破るため、this プロパティに **V8 Smi 流の
1bit タグ** (偶数=数値<<1 / 奇数=object table index、null=1、undefined=3)
を導入。参照の move / identity / null・undefined 比較 / truthiness /
return、そして **__load_slot import によるネスト読み** (this.cur.link)
が Wasm 圏内に入った。全 1006 テストパス。

## spike が設計を変えた (最重要の学び)

- **JS オブジェクトは Wasm の eq 階層に入らない**: `ref.cast eq` は
  validate を通るが実行時 illegal cast。「validate が通る ≠ 動く」を
  30 分の spike で確認できたのが最大の節約 (本実装後に発覚したら大惨事)
- **i31 の tag/untag は +6%** (1 億回ループ実測) — TurboFan がタグ操作を
  ほぼ消す。「Smi が速いのは最適化コンパイラがタグを消すから」の裏取り
- 結果、WasmGC (i31ref) を調べに行って **V8 が 30 年前からやっている
  「i32 に 1bit タグ」に戻ってきた** (案 C')。標準機能より自前タグが
  正解になることもある

## 設計の骨子

- **分類 (classifyTaggedProps)**: プロパティを numeric / tagged に自動
  分類。tagged に許すのは identity・truthiness・move・return・ネスト読み
  のみ。算術に流れるものは fixpoint で numeric に降格 = 「タグ付き値が
  生の数値と混ざる」事故をコンパイル時に排除 (V8 の field representation
  tracking の超簡易版)
- **identity は table の dedup で成立**: 同一オブジェクト → 同一 index
  なので生 i32 比較で正しい。`== null` は `(v|2)==3` で null/undefined を
  まとめ、`===` は 1/3 を区別
- **ネスト読みは import で VM に聞く**: own プロパティ以外・数値 deref は
  DEOPT_SENTINEL throw → 捕捉 → deopt → VM 再実行 (ネスト読みは純粋 +
  write-back 前なので再実行安全 = 中途 deopt の巻き戻し問題を回避)

## 計測 (正直な結果)

| ベンチ | VM | JIT | 前フェーズ比 |
|---|---|---|---|
| richards | 126ms | 119ms | 維持 (勝ち) |
| deltablue | 170ms | 194ms | **-14% (軽い退行)** |
| splay | 2622ms | 2668ms | ほぼ同等 |
| navier-stokes | 2132ms | **127ms** | 17x 維持 |

deltablue の退行は「tagged で compile 対象が増えたが、小関数のネスト
import コストが VM インライン実行に勝てない」構造。「ループ無し ×
ネスト持ちを弾く」ヒューリスティックも試したが**差はノイズの範囲**で、
単発計測の外れ値 (563ms) に騙されかけた — 中央値で測る教訓の再演。

## 教訓

1. **spike の価値は「早く間違える」こと**: ref.eq の 1 点で案 B が崩れ、
   より単純な案 C' に着地。設計書の「要検証」を放置しないこと
2. **機能が動く ≠ ベンチが動く**: 参照の持ち回り + 1 段ネストまで
   実装しても OO ベンチは動かない。richards の本丸 (schedule) には
   `task.run()` = **メソッド呼び出しの投機的直接化** が要る (次の山)
3. **correctness-first の deopt 網は強い**: proto プロパティ・数値
   deref・30bit 超・型外れ、全部「VM に落ちて正しい」に倒してあるので
   1006 テストと Octane 4 本が一度も壊れずに進んだ

## 残課題 (Phase 34+ 候補)

- **メソッド呼び出しの投機的直接化** (`this.cur.task.run()`): HC guard +
  クラスタ機構の合流。richards/deltablue の本丸
- f64 昇格関数での tagged 有効化 (tagged 値専用の i32 local グループ)
- deltablue 退行の解消: per-関数の勝敗判定 or ネスト頻度による降格
- 案 A (WasmGC struct へのヒープ移住) は「ネスト読みが import で足りるか」
  の実測が出た今も保留が妥当 (import 1 回 ≈ 数十 ns、struct 移住は
  エンジン心臓移植)
