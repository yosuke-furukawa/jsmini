# LEARN-Phase29.md — Array hot loop JIT + 周辺バグ掃除

## やったこと

「JIT が刺さらない領域」の伸び代として **配列を含むホットループの Wasm 化**
に着手。実演したら既存の配列 JIT パスが壊れていたので、そこを直すのを
入口に、SunSpider math 系を JIT で完走させる過程で **芋づる式に出てきた
バグを潰し**、最終的に配列 JIT をほぼフルカバーした。

配列 JIT の対応範囲 (Phase 29 完了時点):

| パターン | 例 | 状態 |
|---|---|---|
| 配列引数 | `function dot(a, b, n)` | ✅ |
| 固定 local 配列 | `var a = new Array(n)` | ✅ |
| 動的成長 (push) | `var a = []; a.push(x)` | ✅ |
| 動的成長 (添字) | `var a = []; a[i] = x` | ✅ |
| 非数値要素 | `a.push({})`, string, undefined | VM フォールバック (正しく) |

数値配列カーネルの効果 (V8-JIT 有効): **VM の 44〜59x / TW の 176〜296x**。

## 発見・修正したバグ 11 件

当初 SunSpider spectral-norm の VM 49.27 / JIT NaN を「配列 f64 storage
バグ」と一括りに推測していたが、二分探索で切り分けると **11 個の独立した
バグ** だった。多くは配列と無関係の汎用バグで、`a - b*c` やグローバル
累算のような普通の式でも踏むものだった。

| # | バグ | 層 | 汎用性 |
|---|---|---|---|
| 1 | 配列引数の JIT が `invalid value type 0x1` | JIT codegen | 配列引数全般 |
| 2 | prefix `++`/`--` のオペランドスタックリーク | VM compiler | prefix++ を for-update で使う全関数 |
| 3 | JIT 除算が整数除算 (`1/15=0`) | JIT range分析 | `/` を含む全関数 |
| 4 | 非可換オペランド順反転 (`a-b*c`) | JIT codegen | Sub/Div/Mod 全般 |
| 5 | インライン値が別 push に埋もれる (`k3*sk*sk`) | JIT codegen | 計算値を跨いで使う式 |
| 6 | グローバル累算が消える (`g+=k`) | JIT LICM | ループ内グローバル書き込み全般 |
| 7 | SSA Phi collapse のタイミング (2ループの param が phantom) | IR builder | 2 ループ以上の関数全般 |
| 8 | maybeStoreLocal の tee で stray | JIT codegen | ループ内で local を持つ値全般 |
| 9 | CSE が AllocArray をマージ (配列 aliasing) | JIT CSE | 複数 local 配列 |
| 10 | 非数値要素の配列を数値配列と誤コンパイル | JIT codegen | object/string を配列に入れる |
| 11 | ブラウザで `process is not defined` | JIT (env) | playground 全般 |

## 教訓

### 1. WasmGC の ref 型は「バイト数」と「値型の個数」がずれる (バグ1)

Wasm の型セクションは func 型の param count に **値型の個数** を書く。
だが jsmini はエンコード済みバイト列 `params.length` を渡していた。
数値型 (i32/f64) は 1 バイトなので今まで一致していたが、**WasmGC の
ref 型は `0x64 + typeidx` の 2 バイト**。配列引数があるとずれる:

```
dot(a, b, n) → params bytes = [0x64,0x00, 0x64,0x00, 0x7c] (5 bytes)
             → 値型は 3 個 (ref, ref, f64)
型セクションが "5 params" と書く → 4 個目に mutability の 0x01 を
value type として読んで CompileError @+21
```

修正: `paramValTypeCount` を別途カウント。ref も scalar も Wasm local
1 本なので body の local index は論理 index のままで正しい。

### 2. stack マシンの「インライン値」最適化は罠が多い (バグ4, 5, 8)

単一使用の計算値を local に入れずスタックに残す最適化は、**放置した値が
無事に・正しい順で取り出せる時**しか使えない。Phase 29 で 3 つの壊れ方:

- **順序反転 (バグ4)**: `1/(n*2)` で `n*2` がインラインで先にスタックに
  乗り、定数 `1` を後から積むと `(n*2)/1` に。非可換演算 (Sub/Div/Mod) で
  致命的
- **埋もれ (バグ5)**: `k3=k*k*k; sk=Math.sin(k); k3*sk*sk` で、k3 と使用の
  間に Math.sin の push が挟まり k3 がスタック底に埋もれ `sk*sk*sk` に
- **tee の stray (バグ8)**: local を持つ値を `local.tee` で「格納しつつ
  スタックにも残す」と、消費側は必ず `local.get` するので tee の残骸が
  stray に。return 前なら frame 巻き取りで無害だが**ループ back-edge で
  スタック不一致**

正攻法は「逆ポーランド順に linearize して各値を使う直前に置くスケジューラ」
だが、jsmini は **位置認識ガード** (IR 上で op の隣接・オペランド位置を
見て危ない計算値だけ local 退避) + **tee → set 統一** で最小修正した。

### 3. JS の `/` は常に浮動小数除算 (バグ3)

range analysis が `Div` を `Math.floor`/`ceil` で整数除算モデル化して
いたため `1/15` を範囲 [0,0] と判定 → `i32.div_s` で `1/15=0`。JS の `/`
は常に float (`7/2===3.5`)。`functionNeedsF64` に「Div を含む関数は f64
化」を追加。整数除算が欲しいときは `(a/b)|0` と書くのが JS の慣習。

### 4. LICM の「全引数がループ外 → 不変」は Load 系に不十分 (バグ6)

`LoadGlobal` は引数ゼロなので「全引数がループ外」を自明に満たし、
ループ内に同名 `StoreGlobal` があっても hoist されていた。`g += k` の
LoadGlobal(g) が初期値を読み続け、累算が消えて最後の 1 回分に
(`f(10)` → VM 55 / JIT 10)。古典的 LICM は alias analysis でこれを防ぐが、
jsmini は「ループ内に該当 Store があるか / Call があるか」の保守的チェック
で対応。LoadUpvalue / LoadProperty / ArrayGet も同じ穴を塞いだ。

### 5. SSA Phi collapse は「全充填 → collapse」の順で (バグ7)

builder が「phi の inputs 充填 → 即 collapse」を phi 毎にやるため、先に
collapse した phi の置換が **未充填の後続 phi に届かず**、stale な値を拾って
dangling 参照に。2 ループ目の param 参照が消えた phi (v1) を指し `f64.lt`
のオペランドが欠けてコンパイル失敗していた。**パス3a (全 inputs 充填) と
3b (fixpoint collapse) に分離** して修正。これで 2 ループ以上の関数全般が
JIT 化されるようになり、副次効果で LICM の不変式が 1 パスで entry まで
巻き上がるようになった。

### 6. Wasm 自己再帰は深さ ~2万で溢れる (深い再帰)

自己再帰は Wasm 内 `call self` にコンパイルされ、Wasm 実行スタック
(V8 のネイティブスタック上) が深さ ~2万で溢れる。VM はヒープ上の frames
配列なので同じ深さでも溢れない。`fn(...)` を try/catch し **RangeError を
catch して deopt + VM 再実行**。スタック溢れ時点で副作用 (配列書き戻し)
は未適用なので再実行は安全。一度溢れた関数は deopt されるので以降は VM。

### 7. 動的配列は V8 の JSArray + backing store と同型 (push / a[i]=)

`[]` + `push` / `a[i]=` の動的成長は、V8 の **length + backing store**
モデルで実装:

- 表現は **length (i32 local) + backing (ref local)** の 2 本。struct を
  避けて Wasm local 2 本で持つ (struct の ref フィールドは型セクション
  前方参照で rec group が要るため)
- 成長: `__grow(old, mincap)` で容量を `max(mincap, oldcap*2)` に拡張し
  `array.copy` で旧要素コピー。まさに `std::vector` / V8 backing store の
  amortized O(1) grow
- `a[i]=x`: `i >= cap` なら grow、`backing[i]=x`、`len = max(len, i+1)`

DCE が副作用ある ArrayPush を消していた (controlOps に追加)、growable op
の value/index がスタック底に埋もれる (local 退避) の 2 つを途中で修正。

### 8. 配列に object を入れると V8 は elements kind を降格する (バグ10)

WasmGC array は i32/f64 のみ。object `{}` は内部で Alloc (i32 base address)
や `LoadGlobal("undefined")` として **数値に見える**ため、`a.push({});
a.push({}); a[0]+a[1]` を数値配列と誤コンパイルして i32 加算していた
(VM は `"[object Object][object Object]"` の文字列連結)。

修正: 配列に格納する値が **「数値を生む opcode」のホワイトリスト** に
含まれなければ VM フォールバック。

これは V8 の **elements kind** の思想そのもの: V8 は数値専用の詰めた配列
(PACKED_SMI / PACKED_DOUBLE) と tagged 汎用配列 (PACKED_ELEMENTS, object
可) を型で分離し、object が入ると tagged に **降格** して backing を作り
直す。TurboFan は kind ごとに特殊化し外れたら deopt。jsmini は
「数値配列のときだけ WasmGC で JIT、それ以外は VM」で対応した。

### 9. ブラウザには process が無い、`?.` では守れない (バグ11)

reject ログの `process.env?.DEBUG_WASM` は、`process` 自体が未宣言だと
**`process.env` を参照した時点で ReferenceError**。optional chaining は
`process.env` が null/undefined の時しか守らない。playground で
fibonacci など JIT 経由のコードが全部落ちていた。`typeof process !==
"undefined"` ガード付き定数に置換。

## パフォーマンス

数値配列カーネル (fill → reduce)、V8-JIT 有効:

| ベンチ | TW | VM | JIT |
|---|---|---|---|
| dot product (a[i]*b[i]) | 7804ms | 1285ms | 503ms |
| new Array(n) fill+sum | 2251ms | 448ms | 7.6ms |
| [] + push fill+sum | 1039ms | 260ms | 5.9ms |

配列アクセスがホットループを支配するカーネルで、bytecode dispatch が
消えて配列も WasmGC array で完結するため 2 桁の高速化。

## SunSpider 結果

| ベンチ | TW | VM | JIT |
|---|---|---|---|
| math-spectral-norm | ✅ | ✅ (49.27→正常) | ✅ (NaN→正常) |
| math-partial-sums | sloppy global | ✅ | ✅ (誤結果→正常) |
| math-cordic / regexp-dna / string-tagcloud / string-validate-input | ✅ | ✅ | ✅ |

## 範囲外 (Phase 29 ではやらない)

- growable 配列の再代入 (`a = a2`)、関数間受け渡し
- pop / splice / shift 等の他の Array メソッド
- 配列に object を入れたまま JIT する (V8 の tagged elements 相当。今回は
  VM フォールバック)

## 教訓の総括

「配列 f64 バグ」という一つの現象に見えたものが、**11 個の独立した汎用
バグ** だった。スタックマシン (VM / Wasm) の一時値管理、SSA の phi 解決、
LICM の副作用判定、型の昇格/降格判定 — どれも「値がどこに・いつ・
どの順で存在するか」を取り違えると壊れる。二分探索で最小再現を作り、
IR/WAT をダンプしてスタック深さを追う、という地道な切り分けが効いた。

配列 JIT を通じて、V8 の設計 (JSArray + backing store、elements kind、
deopt) を **なぜそうなっているか** を実装で追体験できたのが一番の収穫。
