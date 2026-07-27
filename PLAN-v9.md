# PLAN v9 — jsmini の残課題と次の一手

Phase 39 完了時点 (2026-07-27) の残課題台帳。正しさの基準は **node (strict mode)**。
現状スナップショットは [[PLAN-v8.md]] (旧 PROBLEMS.md)。以後の living ledger は本ファイル。

## 現状サマリ

- test262: **TW 63.4% / VM 60.3% / JIT 60.1%** (12,459 件実行、noStrict/async/module 等 2,114 件スキップ)
  - Phase 39 で開始時 54% から +6〜9pt。TW は dstr パラメータデフォルト修正で 60→63.4% に跳ねた
  - **TW > VM の逆転**が起きている (TW が dstr で先行)。VM 側にも同種の穴がないか要確認
- 内部テスト 1,287 全パス / 差分ファザ **0/100k 収束** (残 4 件は評価順/logs 件数差のノイズ)
- Octane JIT 回帰なし (richards ~130ms / deltablue ~195ms / navier ~145ms)

## 効果順ロードマップ (test262 の実データに基づく)

VM の失敗をエラー別に集計した上位クラスタ (2026-07-27):

| 施策 | 効く失敗 | 規模 | 難度 | 種別 |
|---|---|---|---|---|
| A. class private `#` のパース | "Unexpected character '#'" | **296** | 中 | パーサ |
| B. for-of/for-in の分割代入 LHS | "but got Of" (188) + 関連 | **~190** | 中 | パーサ |
| C. async テストの `$DONE` ランナー対応 | 現在スキップの 1,629 件を実行可能に | **~1,629 (skip 解放)** | 中 | テストインフラ |
| D. プロパティ属性の TypeError 精緻化 | "Expected a TypeError" | **277** | 中〜大 | オブジェクトモデル |
| E. ビルトインのメソッド歯抜け | "Not a function" | **241** | 大 (件数分散) | ビルトイン |
| F. RegExp exec の結果プロパティ | "__executed.input is expected" | **210** | 中 | RegExp |
| G. try/catch 系のパース | "Identifier but got LeftBracket" (try 55) 等 | **~95** | 中 | パーサ |
| H. `.constructor` の host 境界 | "!== gen/fn/cover/cls/arrow" 系 350 の一部 | 大 | 大 | 設計 |

---

## Part 1: 高 ROI (パーサ / テストインフラ)

### A. class private `#` のパース (296 件) — 最優先候補

`#x = 1` の単純フィールドは動くが、`#m()` メソッド / `static #x` / `#x in obj` /
private getter/setter で lexer が "Unexpected character '#'" を投げる。
- lexer が `#name` を PrivateIdentifier トークンとして広く受理する必要がある
- private メソッド/アクセサは WeakMap 的な per-instance ストレージ、または
  jsmini の HiddenClass に `#`-prefixed キーで格納 (外から見えないだけ) で近似可
- **注意**: private は「ブランドチェック」(`#x in obj`) の意味論まで来ると重い。
  まずパース + フィールド/メソッド格納だけで大半が拾える見込み

### B. for-of / for-in の分割代入 LHS (~190 件)

`for ([a, b] of pairs)` / `for ({x} of objs)` が "Expected Semicolon but got Of"。
パーサが for ヘッドの LHS に分割パターンを許していない。
- parseForStatement の LHS 解析を BindingPattern 対応に
- bindPattern は既にある (dstr 修正済み) ので、パースが通れば実行は概ね動くはず

### C. async テストの `$DONE` ランナー対応 (~1,629 件がスキップ中)

async/await + JSPI は**実装済みで動く**のに、test262 の async テストは
`$DONE` コールバック方式のため runner がスキップしている。これを実装すると
**現在カウント外の 1,629 件が実行対象になり、その多くが PASS する**見込み。
- runner に doneprintHandle.js 相当 (`$DONE` を受け取り microtask drain 後に
  成否判定) を実装
- **単一施策での見かけ上のスコア寄与が最大**の可能性。ただし分母も増えるので
  「実行数 12,459 → ~14,088」で率の出方は変わる。真の実力可視化として価値大

### G. try/catch / その他パース (~95 件 + 関連)

"Identifier but got LeftBracket" の 55 件が try 系 = `catch ([e])` / `catch ({e})`
の分割 catch パラメータ。B と同じ「分割パターンをパーサが許す場所を増やす」系。
"RightParen but got Identifier" 112 件は Set/RegExp prototype テストで別要因
(引数リストの何か) — 要調査。

---

## Part 2: オブジェクトモデル / ビルトイン

### D. プロパティ属性の TypeError 精緻化 (277 件)

Phase 39 で属性モデルは入れたが "Expected a TypeError" がまだ 277 件。
- 名前推論の細部 (`name.value` 不一致 ~28)、computed key メソッドの属性、
  Symbol キーのプロパティ属性
- **JIT の StoreProperty (wasm write-back) が attrs チェックを通らない** —
  frozen オブジェクトが hot 関数内で書かれると素通り (実害限定的だが穴)
- 非拡張オブジェクトへの `defineProperty` の一部エッジ

### E. ビルトインのメソッド歯抜け (241 件)

"Not a function" 241 件。ES2025 系 (`Map.prototype.getOrInsertComputed` 等) や
TypedArray/ArrayBuffer 系、String/Array の未実装メソッド。
- 件数は多いが 1 メソッド = 数件で分散。ROI は「よく使われる順」に実装

### F. RegExp exec の結果プロパティ (210 件)

"__executed.input is expected to equal" = exec の結果オブジェクトの
`input`/`index`/`groups` 等が host RegExp 委譲で欠けている。
- exec 結果を jsmini 側で input/index/groups 付きに整形

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

1. **C. async `$DONE` ランナー** — 1,629 件を実行対象化。実装済み機能の
   可視化で最大のインパクト。テストインフラなのでエンジン改変リスク無し
2. **B + G. 分割代入 LHS のパース拡大** (for-of/for-in/catch) — ~285 件、
   bindPattern は既存なのでパーサ改修が主
3. **A. class private `#`** — 296 件、独立性が高い
4. **F. RegExp exec 結果プロパティ** — 210 件、局所的
5. **D/E** — 属性精緻化・ビルトイン歯抜けは件数分散なので中長期
6. **I. JSString UTF-16 化** と **H. .constructor** は大改修、優先度低
7. 並行して **Part 5** (oracle node / dstr 横展開) で品質の底上げ

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
