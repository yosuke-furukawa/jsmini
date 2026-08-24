# PLAN v9 — jsmini の残課題と次の一手

Phase 39 完了時点 (2026-07-27) の残課題台帳。正しさの基準は **node (strict mode)**。
現状スナップショットは [[PLAN-v8.md]] (旧 PROBLEMS.md)。以後の living ledger は本ファイル。

## 現状サマリ

- test262 (Phase 47 でビルトイン歯抜け補充後): **TW 72.1% / VM 67.4% / JIT 66.7%**
  (14,053 件実行、noStrict/module 520 件スキップ)
  - Phase 46 時点は TW 71.2% / VM 66.6% / JIT 65.9% (TW +125 / VM +118 / JIT +118)
  (14,053 件実行、noStrict/module 520 件スキップ)
  - Phase 45 時点は TW 69.5% / VM 64.9% / JIT 64.2% (TW +241 / VM +234 / JIT +234)
  - Phase 44 時点は TW 67.6% / VM 64.3% / JIT 63.6% (TW +267 / VM +92 / JIT +92)
  - Phase 43 時点は TW 66.4% / VM 63.0% / JIT 62.3% (TW +171 / VM +178 / JIT +180)
  - Phase 39 時点 (async skip) は TW 63.4% / VM 60.3% / JIT 60.1%
  - Phase 40 で async 1,634 件を skip→実行に変更。約173 件が新規パスする一方、
    async generator 等の未実装が可視化されて見かけの率は下がった (項目 C 参照)
  - **TW > VM の逆転**が起きている (TW が dstr で先行)。VM 側にも同種の穴がないか要確認
- 内部テスト 1,287 全パス / 差分ファザ **0/100k 収束** (残 4 件は評価順/logs 件数差のノイズ)
- Octane JIT 回帰なし (richards ~130ms / deltablue ~195ms / navier ~145ms)

## 効果順ロードマップ (test262 の実データに基づく)

VM の失敗をエラー別に集計した上位クラスタ (2026-07-27):

| 施策 | 効く失敗 | 規模 | 難度 | 種別 |
|---|---|---|---|---|
| A. class private `#` のパース | ✅ **Phase 42 完了** (TW +442 / VM +433 / JIT +383、Unicode 識別子含む) | — | — | パーサ |
| B. for-of/for-in の分割代入 LHS | ✅ **Phase 44 完了** (TW +171 / VM +178 / JIT +180) | — | — | パーサ |
| C. async テストの `$DONE` ランナー対応 | ✅ **Phase 40 完了** (skip 2,114→520、+173 pass) | — | — | テストインフラ |
| C2. async generator (`async *m`, `for await`) | ✅ **Phase 41 完了** (TW +535 / VM +487 / JIT +487) | — | — | 言語機能 |
| D. 分割代入の TypeError (旧「プロパティ属性」) | ✅ **Phase 45 で主要部完了** (TW +267 / VM +92 / JIT +92) | 残 ~60 | — | dstr/オブジェクトモデル |
| E. ビルトインのメソッド歯抜け | ✅ **Phase 47 で主要部完了** (TW +125 / VM +118 / JIT +118) | 残 ~130 | — | ビルトイン |
| F. RegExp exec の結果プロパティ | ✅ **Phase 46 完了** (TW +241 / VM +234 / JIT +234) | — | — | RegExp |
| G. try/catch 系のパース | "Identifier but got LeftBracket" (try 55) 等 | **~95** | 中 | パーサ |
| H. `.constructor` の host 境界 | "!== gen/fn/cover/cls/arrow" 系 350 の一部 | 大 | 大 | 設計 |

---

## Part 1: 高 ROI (パーサ / テストインフラ)

### A. class private `#` のパース ✅ **Phase 42 で完了**

実装: VM のメソッド呼び出し 2 サイトの PrivateIdentifier 対応、`#x in obj`
(mangled 名の文字列リテラル + 既存 in)、パーサでの不可視プレフィックス mangle
(観測不能化)、lexer の Unicode ID_Start/Continue + \u エスケープ (public 識別子含む)。
残る近似: per-class brand ではなく共有キーなので、別クラスの同名 private を
区別しない / 誤アクセス時の TypeError は出ない。

<details><summary>旧記述</summary>

`#x = 1` の単純フィールドは動くが、`#m()` メソッド / `static #x` / `#x in obj` /
private getter/setter で lexer が "Unexpected character '#'" を投げる。
- lexer が `#name` を PrivateIdentifier トークンとして広く受理する必要がある
- private メソッド/アクセサは WeakMap 的な per-instance ストレージ、または
  jsmini の HiddenClass に `#`-prefixed キーで格納 (外から見えないだけ) で近似可
- **注意**: private は「ブランドチェック」(`#x in obj`) の意味論まで来ると重い。
  まずパース + フィールド/メソッド格納だけで大半が拾える見込み

</details>

### B. for-of / for-in の分割代入 LHS ✅ **Phase 44 で完了**

実装: parseForStatement の非宣言パスで式をパースし、`of` が続けば exprToPattern
(カバー文法変換) で ForOf に、式全体がトップレベル In 二項式で `)` が続けば分解
して ForIn に。TW は assignTarget ジェネレータ (Member/デフォルト値対応)、VM は
compileBindingTarget の assign モードで実行。CoverInitializedName (`{x = 1}`)、
文字列の配列分割、TW の `[a=1] = arr` デフォルト値無視、VM の関数内パターン代入が
新規ローカルを作る問題も同時に修正。

<details><summary>旧記述</summary>

`for ([a, b] of pairs)` / `for ({x} of objs)` が "Expected Semicolon but got Of"。
パーサが for ヘッドの LHS に分割パターンを許していない。
- parseForStatement の LHS 解析を BindingPattern 対応に
- bindPattern は既にある (dstr 修正済み) ので、パースが通れば実行は概ね動くはず

</details>

### C. async テストの `$DONE` ランナー対応 ✅ **Phase 40 で実装済み**

runner に native `$DONE` 注入 + `drainMicrotasks` 後の成否判定を実装
(ハーネスに asyncTest / assert.throwsAsync / checkSequence /
checkSettledPromises を追加)。skip 2,114 → 520、実行数 12,459 → 14,053。

結果 (TW): async 1,634 件のうち **約173 件が新規パス**。残り約1,461 件は
下記の**本物の機能ギャップ**が可視化された (以前は skip で隠れていた):

| 原因 | 件数 (async のみ) | 対応 |
|---|---|---|
| **async generator** (`async *m(){}` / `for await`) | ~877 | 未実装の大機能。**新フェーズ候補** |
| **class private `#`** のパース | ~218 | 項目 A と同一 |
| Promise.all(非イテラブル) 等が settle せず `$DONE` 未到達 | ~116 | Promise の反復エラー処理バグ (中) |
| async arrow / その他パース | ~130 | 項目 B/G と重複 |

見かけの率は「skip 除外」方式のため 63.4% → 57.2% に下がるが、これは
2,114 の隠れ skip を正直な実行に置き換えた結果 (絶対パス数は +134)。
プロジェクト方針「canRun 廃止・正直に Fail」に沿う。

### G. try/catch / その他パース (~95 件 + 関連)

"Identifier but got LeftBracket" の 55 件が try 系 = `catch ([e])` / `catch ({e})`
の分割 catch パラメータ。B と同じ「分割パターンをパーサが許す場所を増やす」系。
"RightParen but got Identifier" 112 件は Set/RegExp prototype テストで別要因
(引数リストの何か) — 要調査。

---

## Part 2: オブジェクトモデル / ビルトイン

### D. 分割代入の TypeError ✅ **Phase 45 で主要部完了**

実データ分析の結果、"Expected a TypeError" 296 件の主因は属性モデルではなく
**分割代入の TypeError 系**だった。実装:
- TW: bindPattern/assignTarget に RequireObjectCoercible (ObjectPattern×nullish)
  と GetIterator 検査 (非イテラブル) を追加
- VM: RequireCoercible opcode (空 ObjectPattern / rest のみパターン用)
- VM: generator/async generator の呼び出し時パラメータ検証 (paramShapes を
  compile 時に保存し生成前に eager 検証。getter は呼ばない近似)

**残り (別フェーズ候補)**:
- `delete Array.prototype[Symbol.iterator]` 系 ~30 件 — GetIterator が host 配列の
  @@iterator 差し替えを見ない (host 配列設計と衝突、要設計)
- 旧記述の属性モデル系 (少数): 名前推論の `name.value` 不一致、
  JIT StoreProperty の attrs 素通り、非拡張 defineProperty のエッジ

### E. ビルトインのメソッド歯抜け ✅ **Phase 47 で主要部完了**

「Not a function」376 件を再集計した結果、分散ではなく集中クラスタだった:
- **RegExp well-known symbol メソッド 136 件** — Symbol.match/matchAll/replace/
  search/split を追加し、RegExp.prototype に "@@..." 委譲メソッド (host-patches)
- Map.groupBy / Map・WeakMap getOrInsert(Computed) / RegExp.escape /
  Promise.prototype.finally / Promise.try
- 副産物の重要バグ修正 2 件:
  1. VM の Promise executor / host コールバック内 unhandled throw が外側フレームを
     全 unwind してスクリプトの残りを黙殺 (callFunction/callInternal に boundary モード)
  2. throw する getter を仕込んだ host アルゴリズム (RegExp[Symbol.match]) が
     THROWN_SENTINEL を値として続行し無限ループ → OOM で node ごとクラッシュ
     (defineProperty の getter/setter ラッパを boundary に)

**残り (~130 件)**: lang 系の雑多な iterator close エッジ (~80)、既存メソッドの
意味論差 (Promise.all の反復エラー処理等)、Set 演算の JSString 境界少数

### F. RegExp exec の結果プロパティ ✅ **Phase 46 で完了**

原因は「欠け」ではなく **host string と JSString の intern 同一性**: exec 結果の
要素/input/groups が host string のままで `===` が false になっていた。実装:
- js-string.ts の internMatchResult で in place 整形 (index 等の own プロパティ保持)
- host-patches の exec は「引数が JSString = jsmini 呼び出し」のときだけ整形。
  host 内部呼び出し (String.prototype.replace → exec) は raw のまま
- VM match/matchAll、TW の文字列メソッド委譲も同ヘルパーに統一
- おまけ: TW の replace(/re/, fn) コールバック戻り値が unwrap されず
  "[object Object]" になる既存バグも修正

### H. `.constructor` の host 境界 (設計課題・大)

`[1,2].constructor` が TW=host Array / VM=jsmini Object。両エンジンで独自
Array/Number コンストラクタ + prototype チェーンを一貫モデル化する必要があり
大規模。差分ファザ generator からは除外済み。**優先度低** (収束済みなので急がない)。

---

## Part 3: 文字列表現の根治 (中〜大・独立)

### I. JSString を UTF-16 code unit ベースに

現状 JSString は UTF-8 バイト配列 (`createSeqString` が TextEncoder) で
length/charAt/slice/index がバイト単位。非 ASCII で `.length` がずれる
(😀 → 4、正しくは 2)。
- charAt/slice/codePointAt/インデックスアクセス全面が byte 前提 → UTF-16 化は
  文字列処理の全面改修
- ASCII のみのプログラムでは顕在化しないため後回しだが、Unicode テストの
  取りこぼしの根

---

## Part 4: 小粒・意味論の隙間

- **super の残**: `super.x = v` (setter 代入) 未対応 / getter・setter 経由の
  super 解決は非対応 (メソッドと素の読みのみ)
- **`new.target`** パース不可
- **identifier としての async** (`for (async.x of ...)` 等 3 件)
- **class 内 eval の意味論** (`eval("super()")` の拒否等 66 件 — eval に
  スコープ文脈解析が必要)
- **未定義ラベルへの break/continue** が no-op (SyntaxError にすべき)
- **TCO (末尾呼び出し最適化)** なし (24 件、strict 専用。V8 も撤回した機能なので
  やらない判断も可)
- **`$262`** (createRealm 等 20 件) 未対応
- **module** 未対応 (9 件スキップ)

## Part 5: 品質保証の深化

- **`--oracle node` モード**: 差分ファザは「3 エンジン揃って間違う」バグを
  検出できない。node をリファレンスに混ぜれば共通バグも拾える。
  差分ファザが 0 収束した今、次に価値が出る方向
- **残る差分ファザ 4 件**: 評価順 (throw 直前の console.log の実行有無) と
  logs 件数差。完了値・エラー型は 3 エンジン一致で実害小だが、詰めるなら
  評価順の spec 準拠 (先に副作用、後に throw) を精査
- **VM にも dstr デフォルトの穴が別経路に無いか確認**: Phase 39 で TW の
  bindParam を直したが、VM は自前 compiler。JIT copy-in や分割代入の
  別ルートで同じ取りこぼしが無いか横展開チェック

---

## 推奨する着手順

1. ~~**C. async `$DONE` ランナー**~~ — ✅ **Phase 40 完了**。async を実行対象化し
   +173 pass。以降は下記の可視化された async ギャップを潰していく
2. ~~**A. class private `#`**~~ — ✅ **Phase 42 完了** (Unicode 識別子含む)。
   TW +442 / VM +433 / JIT +383
3. ~~**B. 分割代入 LHS のパース拡大** (for-of/for-in)~~ — ✅ **Phase 44 完了**。
   ~~**D. 分割代入の TypeError**~~ — ✅ **Phase 45 で主要部完了**。
   残: パターン内の computed/リテラルキー (`{ [k]: x }` / `{ 1: x }`, ~142 件) と
   catch 句の分割 (G の一部)
4. ~~**C2. async generator**~~ — ✅ **Phase 41 完了**。パーサ + TW + VM に実装し
   TW +535 / VM +487 / JIT +487。残る制約: VM は中断点への例外注入
   (await 拒否を body の try/catch に届ける) が未対応
5. ~~**F. RegExp exec 結果プロパティ**~~ — ✅ **Phase 46 完了** (TW +241 / VM +234 / JIT +234)
6. **D/E** — 属性精緻化・ビルトイン歯抜けは件数分散なので中長期
7. **I. JSString UTF-16 化** と **H. .constructor** は大改修、優先度低
8. 並行して **Part 5** (oracle node / dstr 横展開) で品質の底上げ

## 検証方法 (共通)

```bash
npm run fuzz -- --iterations 20000 --seed 111 --isolate   # 収束確認 (0 期待)
npm run fuzz -- --repro <gen seed>                        # 1 件の単独再現
npm run test262 [-- --vm|--jit]                           # 3 モード比較
npx tsx --test src/vm/strict-semantics.test.ts            # 回帰テスト
npx tsx src/octane-bench.ts                               # ベンチ回帰確認
```

原則: 正 = node (strict)。TW/VM/JIT の 3 エンジンを同時に直して収束させる
(片方だけ直すと divergence が増える)。1 バグ = 1 コミット。全 TODO 完了後に
draft を外してユーザー確認 → マージ。
