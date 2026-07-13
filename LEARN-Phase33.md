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
| **token-ring (tagged 有利ベンチ)** | 2474ms | **4.2ms (594x)** | 新設 |
| richards | 121ms | 120ms | 維持 (勝ち) |
| deltablue | 163ms | 171ms | 軽退行のまま |
| splay | 2570ms | 2551ms | 同等 |
| navier-stokes | 2128ms | 297ms → 204ms 単発 | 維持 |

token-ring は「参照の move + identity + null チェックだけのホット
ループ」= tagged の得意技そのもの。**594x は jsmini 史上最大の倍率**で、
参照の付け替えが「VM の dispatch + HiddenClass lookup」から
「linear memory の i32 load/store」になった効果の直接測定になっている。

Octane が動かない理由は変わらない (メソッド呼び出し・オブジェクト引数・
ネスト書き込みが未対応)。「機構の実力」と「実ベンチの構造」は別物 —
これも Octane retire の教訓 (ベンチは測りたいものを測る) の実地。

## 33-6: tagged×f64 の共倒れ解消で掘り出した潜在バグ 3 件

当初 token-ring は**コンパイルすらされなかった** (JIT 0.8x)。真因は
「param 有界のループカウンタですら range 分析で i32 をわずかに超え、
ループ持ち関数がほぼ全部 f64 昇格 → `!useF64` ゲートが tagged を無効化」
という共倒れ。f64 関数内で tagged 値を生 i32 で持つ対応 (len(i32)
グループへの相乗り + Load/Store/比較/Not/Return の変換スキップ +
null 入力 stack Phi の tagged ドメイン化) を入れる過程で、
**「local 添字ズレ」同族の潜在バグを 3 件**掘り出した:

1. **extraLocals が `irFunc.paramCount` 基準** (totalParamCount でなく):
   this/upvalue/globals パラメータを数えず scalar グループが過大宣言。
   全 local が同一型の時代は「余分な宣言」で無害に潜伏し、
   i32/f64 混在で初めて型ズレとして顕在化
2. compileIRToWasm (params 組立) と codegenIR (添字割当) で
   **upvalue 数の数え方が不一致** (clusterSrcs 転送分の有無)
3. cluster callee の totalParamCount に **main 専用の extraBoxCount が
   誤伝播**

教訓: 「宣言は過大でも動く」系の緩みは、型が単一なうちは絶対に
見つからない。mixed 型の導入は機能追加であると同時に、
**局所配置の整合性テスト**として働いた。

## 教訓## 教訓

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
- deltablue 退行の解消: per-関数の勝敗判定 or ネスト頻度による降格
- 案 A (WasmGC struct へのヒープ移住) は「ネスト読みが import で足りるか」
  の実測が出た今も保留が妥当 (import 1 回 ≈ 数十 ns、struct 移住は
  エンジン心臓移植)
