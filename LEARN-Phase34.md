# LEARN-Phase34.md — 差分ファジング: エンジンを 3 本持つ利点でバグを釣る

## やったこと

[Fuzzilli](https://github.com/googleprojectzero/fuzzilli) 流の**差分ファジング**を
`src/fuzz/` に導入 (`npm run fuzz`)。ランダム生成した JS を jsmini の 3 エンジン
(Tree-Walking / Bytecode VM / VM+JIT) に食わせ、**結果の食い違い (divergence)** を
バグ候補として自動検出する。回した初日に **VM の strict-mode / スコープ enforcement
バグを 3 種**釣り上げた。いずれも TW と実 Node は正しく、VM だけが誤る。

| 入力 | 正解 (Node/TW) | VM/JIT | バグ |
|---|---|---|---|
| `const c=1; c=2; c` | TypeError | `2` を返す | const 再代入を許す |
| `x=3; x` | ReferenceError | `3` を返す | 未宣言代入で暗黙グローバル |
| `if(true){}else{var v=9;} v` | `undefined` | ReferenceError | `var` 巻き上げが入れ子で漏れる |

`npm test` は全 1038 件パス (うち fuzz 33 件)。使い方・設計は `FUZZING.md`。

## なぜ「本家 Fuzzilli 直結」でなく「差分ファジング」なのか

本家 Fuzzilli は Swift 製で、対象エンジンに 2 つを要求する:

1. **REPRL** (read-eval-print-reset-loop): fd 100-103 で親子がプログラムと
   結果をやり取りする常駐プロトコル
2. **カバレッジ計装**: `__sanitizer_cov_trace_pc_guard` の SHM ビットマップを
   フィードバックにして入力を進化させる (coverage-guided)

jsmini は **Node 上の TypeScript**。macOS で本家に直結するには、Node に mmap/shm を
橋渡しするネイティブアドオンが要る (Node に mmap 組み込みが無い) — 重すぎる。

ここで jsmini 固有の強みが効く: **同じ言語仕様を実装したエンジンを 3 本持っている**。
リファレンス実装 (V8 等) が別に要らない。3 本が食い違えばどれかが必ずバグ。これは
Fuzzilli が狙う「エンジンの正しさ検証」を、カバレッジもリファレンスも無しに Node
だけで完結させる。本家の資産 (生成した `.js` コーパス) は `--corpus` で再生して取り込む。

> 教訓: ツールを「そのまま入れる」より、**手元の資産で同じ目的を達成する形に翻訳する**
> ほうが速くて本質的なことがある。差分ファジングの本体は Fuzzilli ではなく
> 「独立した複数実装の一致検証」という考え方のほう。

## 設計上の一番の勘所: 正規化 (normalize) がほぼ全て

差分ファジングは「2 つの実行結果が意味的に同じか」を判定するだけ、に見えて、
そこが一番難しい。jsmini は**同じ JS 値をエンジンごとに違う内部表現**で持つ:

| 対象 | Tree-Walking | Bytecode VM |
|---|---|---|
| 文字列 | host string | `JSString` (rope) |
| オブジェクト | native object | hidden-class `JSObject` (`__hc__`/`__slots__`) |
| 関数 | closure (`body`/`params`) | bytecode function (`bytecode`/`constants`) |
| user throw | `ThrowSignal(value)` でラップ | 生値を `{ __thrown: true, value }` でラップ |
| 参照エラー | 生 host `ReferenceError` | 生 host `ReferenceError` |

これを全部 canonical な**文字列 1 本**に畳む (`normalize.ts`)。畳み方を間違えると
「本当は一致しているのに divergence」の**偽陽性**が洪水になる。実際、最初のテストは
`throw new TypeError` で落ちた — VM の `{__thrown}` ラッパを剥がしていなかった。

正規化で効いた判断:

- **数値は特殊値を必ず区別**: `NaN` / `Infinity` / `-0` は `JSON.stringify` だと
  `null` や `0` に潰れる。文字列で明示 (`"NaN"`, `"-0"`)
- **throw は「種別」で比較、message は捨てる**: `TypeError` か `ReferenceError` かが
  信号。message の文言は host/実装依存のノイズ。ここを緩めないと偽陽性まみれ
- **関数は種別に依らず `[Function]`**: closure と bytecode function は構造が
  全く違うが「関数である」ことだけ一致すれば良い
- **`console.log` の副作用も比較キーに含める**: 完了値が同じでも評価順序や
  副作用が違えばバグ。ログも同じ normalize を通して畳む

> 教訓: 差分ファザの品質は生成器より**正規化の精度**で決まる。「何を同一とみなすか」の
> 線引き = そのまま「どんなバグを検出/見逃すか」の線引き。

## hang をどう殺すか: REPRL 風の常駐子プロセス

ファザ本体が生成プログラムの**無限ループで固まる**のが最大の運用リスク。特に
`--corpus` は任意の JS を流すので必至。3 つ重ねて防いだ:

1. **生成器を有界に作る** (`generator.ts`): ループは `for (let i=0;i<N;i++)` の
   N がリテラルの小さい値のみ。`while`/`do` 無し。関数は**非再帰** (本体生成時に
   自分自身と後続関数をスコープに入れない → 呼び出しグラフは DAG で必ず有限)
2. **VM の `maxSteps`** でバイトコード暴走を throw に変換
3. **子プロセス隔離** (`child.ts` / `pool.ts`): 子が base64 ソースを stdin で受けて
   実行し結果を返す常駐プロセス。hang したら親がタイムアウトで kill → 再起動。
   これは Fuzzilli の REPRL リセットループそのもの

worker_threads + tsx を先に試したが `.js`→`.ts` 解決が worker 内で効かず不安定。
`node --import tsx` の子プロセス + READY ハンドシェイクに切り替えて安定した。
起動コスト (tsx コンパイル ~1-2s) は 1 回だけ、以降はケースを高速に流せる
(生成モードは 2000 件/0.9s、隔離モードでも ~2500 件/s)。

> 教訓: 「hang を後から検出」より「**hang しない入力しか作らない** + それでも
> 固まったら別プロセスごと殺す」の二段構え。生成器の有界性は正しさでなく
> **運用可能性**のための不変条件。

## 釣れたバグの解剖: VM は strict-mode の enforcement が甘い

3 件とも根っこは同じ — **Bytecode compiler のスコープ解決が TW より緩い**。
祭りのたびに掘り当てる「独立バグ」の Phase 34 版。

1. **`const` 再代入を素通し**: `const c=1; c=2` が VM で `2`。TW は代入時に
   readonly チェックをするが、VM は `Sta` 命令に const フラグを見ていない。`+=` も同じ
2. **未宣言変数への代入が暗黙グローバルを作る**: `x=3` が VM で通る。strict mode
   では未宣言への代入は ReferenceError のはず。VM の `StaGlobal` 系が「無ければ作る」
   になっている (sloppy mode 相当)。※未宣言の**読み取り** `y;` は VM も正しく
   ReferenceError を投げる — 書き込み側だけの穴
3. **`var` 巻き上げが入れ子ブロックで不完全**: `if(true){}else{var v=9;} v` が VM で
   ReferenceError。`var` は**実行されない else や 0 回 for 本体でも**関数スコープの
   先頭に静的に巻き上がる (値は `undefined`)。TW は AST を静的に走査して巻き上げるが、
   VM の compiler は入れ子ブロック内の `var` 宣言を関数トップに集めきれていない

どれも「TW が正、VM が誤」。TW が仕様の基準として機能し、VM/JIT が追随できて
いない構図で、これは memory にある「TW/VM/JIT 3 モードで test262 比較」の思想と
一致する。**ファザは test262 が突かない乱数的な組み合わせでその差を炙り出した**。

なお副産物として、単項 `+` (`+x`) が jsmini parser 未対応 (有効な JS だがパース不可)
と判明。これは 3 エンジン共通に失敗するので divergence にはならず、生成器を作る
過程 (500 seed 全てが parser を通ることをテストで担保) で見つかった。

## divergence をどう「読める」形にするか: クラスタリングと最小化

3000 件回すと 531 件の divergence が出る。個別に見ても始まらないので 2 段で圧縮:

- **シグネチャでクラスタリング** (`minimize.ts` の `divSignature`): 値そのものでなく
  「どのエンジンが value / throw:種別 のどれになったか」のパターンで束ねる。
  531 件 → 14 クラスタに畳まれ、根本原因の数が見える
- **行単位の delta debugging** (`minimize`): 差分シグネチャを保ったままソース行を
  貪欲に削り、最小再現形にする。生成プログラムは有界なので in-process で安全に回せる。
  `if(true){}else{var v=9;} v` のような 3 行の芯まで落ちる

正解の確定には**実 Node を strict で回して ground truth**にした。「TW と VM が
食い違う、どっちが正しい?」を人手で考えず、`eval('"use strict";'+src)` で機械的に
決める。これで「VM が誤」と自信を持って言える。

> 教訓: ファザの出力は「生の失敗ケース」でなく「**クラスタ済み・最小化済み・
> 正解付き**」まで持っていって初めて人が動ける。検出と同じくらい**提示**が仕事。

## 構成

| ファイル | 役割 |
|---|---|
| `prng.ts` | seed 決定的な mulberry32 PRNG (再現性の土台) |
| `generator.ts` | 対応サブセットの有界・非再帰 JS 生成 |
| `normalize.ts` | エンジン横断で比較可能な canonical 正規化 (品質の芯) |
| `runner.ts` | 3 エンジン実行 + divergence 判定 |
| `child.ts` / `pool.ts` | REPRL 風 常駐子プロセス + タイムアウト再起動 |
| `minimize.ts` | シグネチャ + 行単位 delta debugging |
| `fuzz.ts` | CLI (生成 / `--corpus` 再生 / `--repro` 詳細) |

## 制約と次の宿題

- **差分ベースの盲点**: 3 エンジンが**同じ間違い**をするバグは検出できない。
  本家 Fuzzilli のカバレッジガイドや、V8 等リファレンスとの差分を足せば拾える
- **カバレッジ未計装**: 今はランダム生成。到達しにくい経路は本家 Fuzzilli 出力を
  `--corpus` で流して補う
- **生成器のサブセット**: 「両エンジンが対応する共通部分」を狙う。対応構文が
  増えたら生成器も広げる (単項 `+` の parser 対応もここに乗る)
- **釣ったバグ本体**: const 再代入 / 未宣言代入 / var 巻き上げの 3 件は本フェーズ
  では**未修正**。bytecode compiler のスコープ解決と `Sta` 系の strict チェックが対象

## 教訓 (まとめ)

- ツールは「入れる」より「**手元の資産で目的を翻訳する**」。3 エンジン内蔵という
  jsmini の形が、Fuzzilli の狙いをリファレンス無しで実現させた
- 差分ファザの品質は**正規化**が決める。同一性の線引き = 検出/見逃しの線引き
- hang は「検出」でなく「**構造で作らない + プロセスごと殺す**」
- 出力は検出で終わらせず**クラスタ + 最小化 + 正解付き**まで。提示も仕事
- test262 が突かない乱数的組み合わせで、TW と VM の enforcement 差が露出した。
  **複数実装を並べて回すこと自体が仕様準拠テスト**になる
