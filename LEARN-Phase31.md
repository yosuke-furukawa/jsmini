# LEARN-Phase31.md — object JIT: OO メソッドを Wasm に乗せて学んだこと

## やったこと

Phase 30 の棚卸し「OO メソッドが非数値 this スロットで全 deopt、JIT ≈ VM」
を受けて this-model を刷新。richards で **JIT が初めて VM に勝った**
(112ms vs 116ms)。その過程で、`||` の JIT が右辺を丸ごと落とすという
**Phase 12 以来の潜在 correctness バグ**を 3 層まとめて掘り当てた。

| ベンチ | VM | JIT | 判定 |
|---|---|---|---|
| richards | 116ms | **112ms** | JIT 勝ち (初) |
| deltablue | 161ms | 176ms | JIT 負け (境界コスト) |
| splay | 2423ms | 2435ms | 同等 |
| navier-stokes | 2074ms | 2182ms | ほぼ同等 (カーネル未 JIT) |

## 一番大きな発見: `||` / `&&` / 三項の JIT は最初から壊れていた

richards の `isHeldOrSuspended` (`(state & HELD) != 0 || state == SUSPENDED`)
が JIT で常に左辺を返す。掘ると **3 層のバグ**が絡んでいた:

### 層 1: IR builder — スタック値の合流に Phi が無い

`a || b` の bytecode は「a を積んだまま分岐し、合流点で a か b が
スタックに乗っている」形。builder の propagate は**最初の predecessor の
スタックしか記録せず**、|| の右辺ブロックが dangling になり DCE で消える。
IR を見ると `Branch → 空ブロック → Return(左辺)` — **右辺が存在しない**。

修正: 合流点 (preds >= 2) にスタック slot ごとの Phi を作り、エッジ通過時
のスタックを contributions として記録、パス 3a' で inputs 充填。
locals の Phi (Phase 29 で直したやつ) と完全に対になる構造。

### 層 2: codegen — Branch エッジに phi write が無い

phi write が `Jump` 終端でしか emit されず、`br_if` (Branch) 経由の
エッジでは phi local が未初期化。同じ phi に両 successor から違う値が
来ることは無い (phi は 1 ブロック所属) ので、br_if の前に無条件で書けば
よい。

### 層 3: codegen — ダイヤモンドの構造化が 1 形状しか扱えない

CFG→Wasm 構造化が「then が Return で終わる if」(fib 形) しか想定して
おらず:
- **逆向きダイヤモンド** (||/&&: false 辺が fall-through) → 条件を反転
  せず br_if
- **完全ダイヤモンド** (三項/if-else 合流) → join で閉じる外側 block を
  もう 1 枚開き、then の Jump を `br` で join へ。従来は forward jump が
  無条件 fall-through で**両辺を実行**していた

**三項演算子の JIT は以前から壊れていた**が、層 1 が右辺を消していた
ため「間違った答え同士が打ち消して」露呈しなかった。バグがバグを隠す
典型例。テストは `x>5 ? x*2 : x+100` の 1 行で捕まえられた — マイクロ
テストの網羅が薄い領域 (論理演算子 × JIT) がそのまま穴だった。

## used-props this-model (richards を勝たせたもの)

旧: this の**全プロパティ**を HC 挿入順で linear memory にコピー
(offset は IR 出現順なので**そもそも不整合**)、非数値が 1 つでもあれば
deopt、write-back 無し。

新: 関数が**使うプロパティだけ**を IR 出現順 (= codegen の offset) で
copy-in。使わないプロパティは参照でも無視。StoreProperty する関数は
実行後に write-back。Int32Array view と HC→slot 列はキャッシュ。

これは V8 の言葉で言えば **per-function の型特殊化 + unboxing**:
「このメソッドは state:i32 だけ触る」という契約でコンパイルし、
契約が破れたら deopt。V8 が tagged pointer で参照も数値も同じスロット
モデルに乗せているのは、この「使うプロパティの型で分岐する」複雑さを
モデル側で消すためだと実感できる。

## グローバルは「読み取り専用パラメータ」として渡す

JIT 内の LoadGlobal が **zero-init の Wasm local を読んでいた**
(richards の STATE_HELD が 0 になる)。これも used-props 化で初めて
露呈した correctness バグ。

修正: tryCall 経路ではグローバルを追加パラメータとして毎呼び出し
VM の現在値を渡す (グローバルが変わっても最新値が見える)。
StoreGlobal を含む関数は write-back の術が無いので reject。
OSR 経路は「スクリプト全体が Wasm 内で完結する」ので従来の
自己完結 local のまま。

V8 対応: global は **script context slot + cell invalidation** で、
定数と分かれば埋め込み + 変更時 deopt。jsmini は「毎回渡す」ことで
invalidation 機構なしに正しさを担保する設計にした (呼び出しコストは
増えるが、richards の定数グローバル程度なら誤差)。

## 簿記 (プロファイリング) は「決まったら止める」

deltablue の JIT 負け分を切り分けたら **-26ms 中ほぼ全部が
feedback.recordCall + tryCall の Map 引き**だった (毎呼び出しの
classify + join + Map lookup ×3)。コンパイル済みコードの損は僅か。

修正: JIT の運命 (compiled / rejected / deopt) が決まった関数に
`__jitCached` を直付けし、以後は 1 プロパティ読みで分岐。
V8 も profiling は下位ティア限定で、optimized code への呼び出しは
インタープリタを経由しない — 同じ構造。

## deltablue の「境界コスト」を解体したら 4 つの隠れコストだった

当初「小メソッドの Wasm 境界コスト」と一括りにしていた deltablue の
-10% を、プロファイル (フック計測 + ワークロード 5 倍スケーリング法) で
分解したら、境界そのものはほぼ無実だった:

| 隠れコスト | 正体 | 修正 |
|---|---|---|
| 33k 回/走の無駄往復 | **見せかけ JIT**: hasThis の判定源が codegen (IR) と executeWasm (bytecode) で二重化。IR で LoadThis が消えた関数を this 付きで呼ぼうとして !memory → 毎回 null → VM 再実行 | CachedWasm.hasThis を単一真実源に |
| 呼び出しごとの再コンパイル | **OSR の __osrDone がフレーム単位**。ループ 100 回超の関数を呼ぶたびに IR 構築 + Wasm コンパイル再試行 | 関数単位の __osrFn キャッシュ |
| 毎 Return の classify | recordReturn に decided ガードが無い | __jitCached 決定済みでスキップ |
| host V8 の IC 汚染 | __jitCached を実行途中に追加 → 関数オブジェクトの shape 遷移 → fn.prototype 読みが polymorphic 化 | 生成時にフィールドを持たせ shape 固定 |

さらに「見せかけ JIT」を剥がしたら、**IR パスの StoreProperty が
forceF64 時に trunc せず CompileError**、**direct パスが this 関数を
実行不能な形でコンパイル**という correctness バグ 2 つが下から出てきた。
偶然のガードがバグを隠す構図 (Phase 30 の「バグがバグを隠す」の再演)。

結果: deltablue の JIT-VM 差は初回コンパイル ~10ms が支配になり、
**定常状態 (ワークロード 5 倍) では +2.9%** まで縮小。navier-stokes も
VM 同等に。

**V8 が OO コードで速い本質はメソッド JIT ではなくインライン**
(呼び出し境界の消滅)。jsmini で勝ちに行くには「メソッドクラスタを
1 つの Wasm モジュールに」— Phase 32 の本丸候補。

### 計測手法の学び

- **フック計測 (monkey-patch) + スケーリング法の併用が効く**: フックで
  測れたのは 17ms、実際の差は 55ms — 「フックの外に犯人がいる」ことが
  分かるのがスケーリング法 (x1 vs x5 で差が定数か比例か) の価値
- 「◯◯が遅い」という仮説は 4 連続で外れた (executeWasm → tryCall 往復 →
  recordReturn → shape) 。**毎回計測してから直す**を徹底しないと
  無関係な最適化を積むところだった

## navier-stokes の reject 理由 (31-4a、実装は次フェーズ)

| 理由 | 件数 | 意味 |
|---|---|---|
| unknown call | 10 | カーネルが兄弟クロージャ (lin_solve 等) を upvalue 経由で呼ぶ |
| array ref escapes via StoreUpvalue | 3 | `dens = new Array(size)` を upvalue に格納 |

必要なのは「クロージャクラスタの同時コンパイル + 配列 upvalue の
受け渡し」。deltablue のインラインと同じ「複数関数を 1 モジュールに」
系の仕事なので、Phase 32 でまとめて扱うのが良い。

## 教訓

1. **「動いている」は「正しい」ではない**: ||/三項の JIT は数フェーズ
   の間壊れたまま 900+ テストを通過していた。JIT 化される関数の形が
   偏っていた (論理演算子入りは this/global で deopt) ため
2. **バグがバグを隠す**: 層 1 (右辺消失) が層 3 (両辺実行) を隠す。
   1 つ直すたびに再テストして「新しい壊れ方」を見るしかない
3. **プロファイルは数字で**: 「JIT が遅い = コンパイルの質」と思い込み
   がちだが、実測したら簿記コストだった。threshold=∞ の
   「絶対コンパイルしない JIT モード」との比較が切り分けの決め手
4. **富豪的モデル (全コピー) から契約的モデル (used-props) へ**は
   correctness の穴 (offset 不整合、write-back 欠落) を同時に炙り出した
