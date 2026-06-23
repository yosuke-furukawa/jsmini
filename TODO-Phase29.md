# TODO Phase 29 — Array hot loop JIT + 周辺バグ掃除

> 後出しで起こした TODO。実際の作業は「Array hot loop を Wasm 化する」という
> 興味から始まり、その PoC を入口にして SunSpider math 系を JIT で完走させる
> 過程で **6 個の独立したバグ** を発見・修正する流れになった。

## 動機

現状把握 (前セッション) で「JIT が刺さらない領域」のうち **Array hot loop の
Wasm 化** (ArrayGet/Set + length を Float64Array 風の WasmGC array に下ろす)
が次の伸び代と判明。実演したら **既存の配列 JIT パス自体が壊れていた**
(`invalid value type 0x1` で Wasm 生成失敗) ので、まずそこを直すところから
始めた。

そこから SunSpider math-spectral-norm / math-partial-sums を JIT で完走させる
ことを目標に、芋づる式に出てくる JIT/VM のバグを潰していった。

## ステップ

### 29-1: 配列引数の関数を JIT 化可能にする (PoC #1)

- [x] 29-1a: `dot(a, b, n)` のような配列引数関数が `invalid value type 0x1`
      で Wasm 生成失敗する件を調査
- [x] 29-1b: 原因特定 — type section の func 型で param count に
      **バイト数** (`params.length`) を渡していた。WasmGC の ref 型は
      `0x64 + typeidx` の 2 バイトなので、配列引数があると値型の個数とずれる
      (dot の params bytes = 5、値型 = 3 → 4 個目に mutability の 0x01 を
      value type として読んで落ちる @+21)
- [x] 29-1c: `paramValTypeCount` を別途数えて渡す修正 (codegen.ts)
- [x] 29-1d: `src/jit/array-jit.test.ts` 新規 (ArrayGet/Set/結果一致)
- 効果: dot product が V8-JIT 有効で TW 7804ms / VM 1285ms / **JIT 503ms**
  (VM 比 3x, TW 比 15x)、JITless で VM 比 49x

### 29-2: prefix ++/-- のオペランドスタックリーク (VM)

- [x] 29-2a: spectral-norm が VM で 49.27 (期待 5.087) になる件を調査。
      「配列 f64 storage バグ」と推測していたが二分探索の結果 **prefix
      `++i`** が真因と判明
- [x] 29-2b: 原因 — VM は stack マシンで Sta* は全部 peek (pop しない)。
      prefix `++x` の compile が `Load; Increment; Dup; Sta` で 2 値残す
      (式の結果は 1 値であるべき)。for-update で Pop 1 個では足りず毎反復
      スタックが伸び、関数 return 後の残骸が `f()+f()` の左オペランドを汚染
- [x] 29-2c: prefix の余分な `Dup` を削除 (compiler.ts)。postfix は従来通り
- [x] 29-2d: vm.test.ts に prefix リーク回帰 4 ケース追加
- 効果: spectral-norm VM が 5.0867 で正しく完走 (影響範囲は prefix++/-- を
  for-update 等で使う全関数と広い)

### 29-3: JIT 除算の i32 化 + 非可換演算のオペランド順反転

- [x] 29-3a: spectral-norm JIT が NaN になる件を調査
- [x] 29-3b: バグ1 — range analysis が `Div` を Math.floor/ceil で整数除算
      モデル化 → `1/15` を [0,0] と判定 → i32.div_s で `1/15=0`。JS の `/`
      は常に浮動小数除算。`functionNeedsF64` に「Div を含む関数は f64 化」追加
      (range.ts)
- [x] 29-3c: バグ2 — codegen の「単一使用計算値をスタックに残す」最適化で、
      計算値が args[1] 以降に来て手前に leaf があるとオペランド順が反転
      (`1/(n*2)→(n*2)/1`、`a-b*c→b*c-a`)。i32/f64 共通の汎用バグ
- [x] 29-3d: `src/jit/arith-jit.test.ts` 新規 (除算 + 非可換 + spectral 風)

### 29-4: インライン計算値が別 push に埋もれる順序バグ

- [x] 29-4a: math-partial-sums の `1/(k3*sk*sk)` が JIT で誤結果になる件
- [x] 29-4b: 29-3c の修正が不十分と判明。インライン保持は **消費 op が定義の
      直後** にある場合しか安全でない。間に別の push (Math.sin 呼び出し等) が
      挟まると計算値がスタックに埋もれ、消費側が別の値を読む
      (`k3*sk*sk` が `sk*sk*sk` になる)
- [x] 29-4c: インライン保持条件を位置認識に強化 (codegen.ts)。local 退避は
      (a) 消費 op が定義の直後でない、または (b) 非先頭オペランドで手前に
      leaf があり順序反転、のいずれか
- [x] 29-4d: arith-jit.test.ts に k3*sk*sk 回帰追加

### 29-5: LICM がループ内で書き換わるグローバルの Load を hoist

- [x] 29-5a: math-partial-sums の JIT 誤結果 (-0.0009 vs 60.09) を調査
- [x] 29-5b: 原因 — `LoadGlobal` は引数ゼロなので LICM の「全引数がループ外」
      を自明に通過し、ループ内に同名 `StoreGlobal` があっても hoist されて
      いた。`g += k` の LoadGlobal(g) が初期値 0 を読み続け、累算が消えて
      最後の 1 回分だけ残る (f(10) → VM 55 / JIT 10)
- [x] 29-5c: hoistFromLoop でループ内書き込みを収集し、衝突する Load 系を
      不変判定から除外 (licm.ts)。LoadGlobal/LoadUpvalue/LoadProperty/
      ArrayGet/ArrayLength の同じ穴をまとめて塞ぐ
- [x] 29-5d: licm.test.ts に hoist 禁止/許可の両方向テスト
- 補足: partial-sums は `var a1 = a2 = ... = 0` で a2 以降が sloppy global に
  なるため、ループ内のグローバル累算がすべてこれを踏んでいた

### 29-6: まとめ

- [x] 29-6a: SunSpider math/regexp/string 系 6 本が TW/VM/JIT 全モード完走
      確認 (cordic / spectral-norm / partial-sums / regexp-dna /
      tagcloud / validate-input)
- [x] 29-6b: 全 917 テストパス確認
- [ ] 29-6c: LEARN-Phase29.md (任意 — TODO に詳細あり)
- [ ] 29-6d: PR 作成・レビュー

## 発見したバグ一覧 (6 個)

| # | バグ | 層 | 種類 |
|---|---|---|---|
| 1 | 配列引数の JIT が `invalid value type 0x1` | JIT codegen | ref 型 param count = バイト数 |
| 2 | spectral-norm VM 49.27 | VM compiler | prefix ++/-- のスタックリーク |
| 3 | JIT 除算が整数除算 (`1/15=0`) | JIT range分析 | `/` の i32 化 |
| 4 | 非可換オペランド順反転 (`a-b*c`) | JIT codegen | インライン値の順序 |
| 5 | インライン値が別 push に埋もれる (`k3*sk*sk`) | JIT codegen | インライン値の位置 |
| 6 | グローバル累算が消える (`g+=k`) | JIT LICM | Load の不正 hoist |

**いずれも当初「配列 f64 バグ」と一括りに推測していたものが、実は 6 つの
独立した汎用バグだった**。2/3/4/5/6 は spectral-norm/partial-sums 以外の
普通の式 (`a - b*c`、グローバル累算等) でも踏むものだった。

## 効果

| ベンチ | TW | VM | JIT |
|---|---|---|---|
| math-cordic | ✅ | ✅ | ✅ |
| math-spectral-norm | ✅ | ✅ | ✅ (49.27→正常) |
| math-partial-sums | sloppy global† | ✅ | ✅ (NaN→正常) |
| regexp-dna | ✅ | ✅ | ✅ |
| string-tagcloud | ✅ | ✅ | ✅ |
| string-validate-input | ✅ | ✅ | ✅ |
| date-format-tofte / xparb | †‡ | †‡ | †‡ |

† = sloppy global (strict-only 方針の既知範囲外、バグではない)
‡ = regex リテラル / chain-assign 等

## 残課題 (Phase 29 範囲外)

### 深い再帰の Wasm スタック溢れ (診断のみ、未修正)

自己再帰関数が Wasm 内で `call self` 直接再帰にコンパイルされ、深さ
~1〜2万で Wasm 実行スタックが溢れる (`RangeError: Maximum call stack`)。
VM はヒープ上の frames 配列なので同じ深さでも溢れない。

- fib は分岐再帰で最大深さ = n なので fib(20000) 級でのみ発生
- `sum(20000)` (線形深い再帰) で再現
- 「ことがある」= 浅い再帰では起きず、JIT 発動後かつ深い入力でのみ

対策案 (未着手):
- A. Wasm 自己再帰に深さガードを持たせ、一定深さで deopt して VM に戻す (中)
- B. ループ無しの純再帰は JIT しない (小・退化)
- C. Wasm→VM 境界で深さ監視 (大)
- D. 現状維持 + ドキュメント化 (最小)

教育的には A (deopt 設計の実例) が筋がいいが、実害は限定的。

### Array hot loop の本丸 (#2: local array allocation) — IR 基盤のみ着手

29-1 は「配列を **引数で** 受け取る関数」の JIT を直しただけ。関数内で
`var a = new Array(n); a[i] = ...` と確保する local array を `array.new`
で Wasm 化するのが本丸。spectral-norm は配列を引数渡しするので 29-1 で
足りたが、より広い配列コード (画像処理・行列演算等の自己完結カーネル) を
JIT 化するには local array allocation が要る。

着手状況:
- [x] IR builder: `new Array(n)` の `Construct(Array, n)` を `AllocArray(n)`
      IR op に変換 (builder.ts)。`[]`/`[1,2,3]`/push は対象外
- [x] IR types に `AllocArray` opcode 追加
- [x] codegen に明示ガード: AllocArray を見たら VM フォールバック
      (壊れた Wasm を絶対出さない)。array-jit.test.ts で結果が正しいこと確認
- [ ] **codegen 本体 (未実装、本丸の難所)**: ref 型 local の管理。
      - AllocArray 結果は `(ref $arr)` 型の local が要る (現状 local は全て
        i32/f64 単一型)
      - **cross-loop で配列を使うと配列参照がループヘッダで Phi になる →
        その Phi local も ref 型** にする必要 (最小ケース
        `var a=new Array(n); loop{a[i]=} loop{s+=a[j]}` でも発生)
      - extraLocalGroups を [scalar 群, ref 群] の 2 群に
      - escape 解析: 配列が Return/Call で関数外に漏れるならフォールバック
      - 自己完結ケース (配列を作り使いスカラーに畳んで return) は境界変換
        不要で一番きれい。まずそこから

設計メモ (V8 との対比): WasmGC `(array (mut T))` は固定長で、V8 の
**backing store** プリミティブに相当。JS の growable な push/`[]`+grow を
真面目にやるなら `struct { length: i32, backing: (array (mut T)) }` +
grow 時 realloc が正攻法 = V8 の JSArray + backing store の構造そのもの。
elements-kind (SMI→double→tagged) の遷移も V8 と同型。今回の AllocArray は
capacity==length の固定長 (= backing store 一個、grow 無し) の最小形。

## 技術メモ

### WasmGC array は既にあるが型エンコードが脆かった

`(array (mut f64))` / `(array (mut i32))` の自動切り替え (Range Analysis の
f64 判定で要素型を決める) は実装済みだった。ref 型を params/results に置く
ときのバイト列エンコード (`refType()` が 2 バイト) と「値型の個数」の
区別が甘く、メイン関数だけ壊れていた (ヘルパ関数 __get_array 等は正しい
論理数を渡していた)。

### stack マシンの「インライン値」最適化は罠が多い

単一使用の計算値を local に入れずスタックに残す最適化は、
- 定義と使用が隣接していること (29-4)
- オペランド順序が崩れないこと (29-3c)
の両方が必要。jsmini はこれを位置認識でガードする方式に落ち着いた。
本来は「逆ポーランド順に linearize して必ず直前に置く」スケジューラを
持つのが正攻法だが、今回は最小修正で対応した。

### LICM と「引数ゼロの Load」

LICM の「全引数がループ外 → 不変」判定は、引数を持つ純粋計算には正しいが、
**メモリ/グローバルを読む Load 系 op** には不十分。Load はソース (グローバル
名 / プロパティ / 配列) がループ内で書き換えられないことも条件になる。
古典的な LICM は alias analysis でこれを判定するが、jsmini は
「ループ内に該当する Store があるか」「Call があるか (任意の副作用)」の
保守的チェックで対応した。
