# TODO Phase 36 — PROBLEMS.md の解消 (差分ファザ主導の続き)

## 動機

Phase 35 で divergence を 903/5000 → 6/10000 件まで一掃し、残課題を
PROBLEMS.md に台帳化した。Phase 36 はその台帳を上から潰す。
併せてファザの生成器を拡張し、「生成器が踏まない構文だったから
見逃していた」系 (switch 内 fn 宣言、配列メソッド) を検出網に入れる。

原則: 正 = node (strict)。TW/VM/JIT を同時に直して収束させる
(片方だけ直すと divergence が増える)。各修正ごとに
`npm run fuzz -- --iterations 10000 --seed <s> --isolate` と全テストで確認。

## 結果 (完了時サマリ)

差分ファザ **0 / 100000** (5 seed × 20000) で完全収束。全テスト 1166 パス。
richards/deltablue/navier-stokes JIT ベンチ回帰なし。詳細は LEARN-Phase36.md。

## ステップ

### 36-1: 小粒の divergence 修正 (PROBLEMS §2)

- [x] 36-1a: switch の case 内 function 宣言を block-scoped に (§2-1)。
      VM も外に漏れる + 前方 case から不可視だったので同時修正
- [x] 36-1b: const を閉包する関数の巻き上げ順 (§2-4)。VM はトップレベル関数から
      トップレベル let/const が一切見えなかった。preScanLexicals 等で解決
- [x] 36-1c: メンバー代入 `obj.p = rhs` の評価順 (§2-3)。VM が `o.p += 2` を
      `o.p = 2` として実行する実バグも同時修正

### 36-2: TW の host 配列メソッドの JSString 対応 (§2-2)

- [x] 36-2a/b/c: TW_ARRAY_OVERRIDES で join/toString/indexOf/lastIndexOf/
      includes/sort をラップし JSString 要素を正しく扱う。回帰テスト追加

### 36-3: `==` の ToNumber 段 (§3-1)

- [x] 36-3a/b/c/d: 仕様 7.2.14 の ToNumber 段を TW/VM に実装。`"5" == 5` === true。
      test262 TW 53.8% / VM 54.3% (向上)。JIT は文字列被演算子で VM フォールバック

### 36-4: ビルトインとユーザー定義 valueOf/toString (§3-2)

- [x] 36-4a/b/c: tryUserToPrimitive で VM の numArg/strConv からユーザー定義
      valueOf/toString を呼ぶ配線。TW の `+=` host string 混入 (§3-3) も解消

### 36-5: JIT — tagged slots の bool タグ (§1-2)

- [x] 36-5a/b/c: TAG_FALSE(5)/TAG_TRUE(7) を追加。copy-in / ガード / write-back /
      codegen truthiness・比較、bool return デコードを対応。回帰テスト + ベンチ確認

### 36-6: ファザ生成器の拡張 + 新出バグの修正

- [x] 36-6a/b/c: switch 文 / 配列メソッド呼び出し / メンバ代入・副作用式の生成。
      withBlockScope でブロックスコープ規律 (宣言リーク防止)
- [x] 36-6d: 拡張後 10000 件 × 複数 seed で triage。以下を発見・修正:
  - [x] VM: switch case 内 let/const が switch の外へ漏れる
  - [x] **実行時 TDZ を実装** (block/switch/本体/upvalue の宣言前 read/write →
        ReferenceError)。専用オペコード方式でホットパス無変更・ベンチ回帰なし
  - [x] TW: null/undefined へのプロパティ代入が ReferenceError → TypeError に
  - [x] **プリミティブ (文字列等) へのプロパティ代入を TypeError に統一**。
        TW が intern 共有 JSString を書き換えて後続実行に状態リーク → 偽発散を
        大量生成していた根本原因を根治 (~130 → 7 件)
  - [x] TDZ とエラー優先順位 (const-TDZ は TDZ 優先 / 複合代入は RHS 評価が先)
        を spec 準拠に
  - [x] メソッド呼び出しの評価順 (obj を引数より先に)
  - [x] `.constructor` (既知 host 境界差) を生成器から除外

### 36-7: まとめ

- [x] 36-7a: PROBLEMS.md を更新 (解消済み削除、残: 計算 -0 / .constructor 境界)
- [x] 36-7b: LEARN-Phase36.md

## 保留 (このフェーズではやらない)

- 計算結果の -0 (§1-1): V8 同様の deopt が必要でコスト大・実害小。台帳に残す
- `.constructor` の host 境界差: 両エンジンで独自 Array/Number を一貫モデル化
  する大規模作業。将来フェーズ
- node をリファレンスにした差分実行 (`--oracle node`): 共通違反の網羅検出用。
  差分ファザが収束した今、次に価値が出る方向
