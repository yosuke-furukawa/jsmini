# TODO Phase 36 — PROBLEMS.md の解消 (差分ファザ主導の続き)

## 動機

Phase 35 で divergence を 903/5000 → 6/10000 件まで一掃し、残課題を
PROBLEMS.md に台帳化した。Phase 36 はその台帳を上から潰す。
併せてファザの生成器を拡張し、「生成器が踏まない構文だったから
見逃していた」系 (switch 内 fn 宣言、配列メソッド) を検出網に入れる。

原則: 正 = node (strict)。TW/VM/JIT を同時に直して収束させる
(片方だけ直すと divergence が増える)。各修正ごとに
`npm run fuzz -- --iterations 10000 --seed 1613533855 --isolate` と
全テストで確認。

## ステップ

### 36-1: 小粒の divergence 修正 (PROBLEMS §2)

- [ ] 36-1a: switch の case 内 function 宣言を TW で巻き上げ (§2-1)。
      TW の SwitchStatement に hoistFunctionDeclarations を追加。
      VM は動作済みなので TW のみ
- [ ] 36-1b: const を閉包する関数の巻き上げ順エッジ (§2-4)。
      compileProgram / compileFunctionBody の関数 hoisting パスの前に
      const 宣言名を先行スキャンして constLocals へ登録 →
      ReferenceError でなく TypeError に
- [ ] 36-1c: メンバー代入 `obj.p = rhs` の評価順 (§2-3)。
      VM: SetPropertyAssign (non-computed) を object 先に。
      TW: put 時の object 再評価 (2 回評価) も同時に解消

### 36-2: TW の host 配列メソッドの JSString 対応 (§2-2)

- [ ] 36-2a: 対象メソッドの洗い出し — TW で host Array のまま公開されて
      いるメソッドのうち、要素/引数/返り値に文字列が絡むもの
      (join / indexOf / includes / lastIndexOf / concat / toString 等)
- [ ] 36-2b: VM の arrayPrototype (JSString 対応の自前実装) と同じ規則で
      TW にラッパを実装。`["a","b"].join(",")` === "a,b" を両エンジンで
- [ ] 36-2c: 回帰テストを strict-semantics.test.ts (または新設
      array-compat.test.ts) に追加

### 36-3: `==` の ToNumber 段 (§3-1、影響範囲大なので独立ステップ)

- [ ] 36-3a: 現状の `==`/`!=` 依存箇所の洗い出し (compat.test.ts /
      ベンチ / test262 のスコア変動を事前に把握)
- [ ] 36-3b: JS 仕様 7.2.14 の string↔number / boolean / null↔undefined
      段を TW / VM (Equal/NotEqual) に同時実装。`"5" == 5` === true
- [ ] 36-3c: JIT の Equal 系 (数値前提) が新セマンティクスと矛盾しないか
      確認 (文字列被演算子は VM フォールバックのはず — 検証)
- [ ] 36-3d: test262 を 3 モードで回してスコア変動を記録

### 36-4: ビルトインとユーザー定義 valueOf/toString (§3-2)

- [ ] 36-4a: VM: index.ts の numArg/strConv から vm.toPrimitive を呼ぶ
      配線を作る (プレーンオブジェクト → 固定値の近似をやめる)。
      String(o) が o.toString() を呼ぶこと
- [ ] 36-4b: TW: twNumArg/twStrConv も TW の toPrimitive 経由に統一
- [ ] 36-4c: TW の `+=` の host string 混入 (§3-3) も同時に解消
      (evalBinaryExpression の Add と同じ経路に寄せる)

### 36-5: JIT — tagged slots の bool タグ (§1-2、本命)

- [ ] 36-5a: 設計 — TAG_NULL(1)/TAG_UNDEF(3) と同様の特殊 tag 値に
      TAG_FALSE/TAG_TRUE を追加する案と、bool プロパティ検出時に
      copy-in deopt する案の比較。truthiness / 比較 / write-back の
      各経路への影響を RESEARCH-TaggedSlots.md に追記
- [ ] 36-5b: 実装 — copy-in / ガード / write-back / codegen の
      truthiness・比較の対応
- [ ] 36-5c: `{k0: false}` が JIT write-back 後も false のままである
      回帰テスト + token-ring / Octane 回帰なし確認

### 36-6: ファザ生成器の拡張 (検出網を広げる)

- [ ] 36-6a: switch 文の生成 (case 内 fn 宣言 / var を含む)
- [ ] 36-6b: 配列メソッド呼び出しの生成 (join / indexOf / push / slice 等、
      文字列要素入り配列と組み合わせ)
- [ ] 36-6c: 副作用のある式をメンバー代入の object / 引数位置に置く
      パターン (評価順検出用)
- [ ] 36-6d: 拡張後 10000 件 × 複数 seed で回し、新出クラスタを
      PROBLEMS.md に追記 or その場で修正

### 36-7: まとめ

- [ ] 36-7a: PROBLEMS.md を更新 (解消済み項目の削除、新発見の追記)。
      残すもの (計算 -0 等の構造的限界) は「保留の理由」を明記
- [ ] 36-7b: LEARN-Phase36.md

## 保留 (このフェーズではやらない)

- 計算結果の -0 (§1-1): V8 同様の「-0 を生みうる演算への deopt」が必要で
  コスト大・実害小。台帳に残す
- node をリファレンスにした差分実行 (§3 の共通違反の網羅検出):
  ファザに `--oracle node` モードを足す構想。生成器拡張 (36-6) の
  効果を見てから判断
