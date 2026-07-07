# LEARN-Phase32.md — クラスタコンパイル: 呼び出し境界を消して NS 7.6x

## やったこと

Phase 31 の宿題「navier-stokes のカーネルが 1 本も JIT されない」を解消。
**兄弟クロージャを同一 Wasm モジュールにまとめる「クラスタコンパイル」**
を実装し、NS が **JIT 283ms vs VM 2161ms (7.6x)** になった。
spectral-norm も「ループ持ちは初回コンパイル」の副作用で 119ms → 13ms。

| ベンチ | VM | JIT | Phase 31 時点の JIT |
|---|---|---|---|
| navier-stokes | 2161ms | **283ms** | 2133ms (VM 同等) |
| spectral-norm | 163ms | **13ms** | 119ms |
| richards | 118ms | 113ms | 113ms |
| splay | 2543ms | 2430ms | 2441ms |
| deltablue | 158ms | 169ms | 173ms |

## なぜカーネルは JIT に乗らなかったか (2 つの構造問題)

1. **呼び出し回数が閾値に届かない**: lin_solve は 1 実行あたり 2-3 回しか
   呼ばれない。時間は呼び出し回数でなく**ループの中**にある。
   → 「ループを含む関数は初回呼び出しでコンパイル」(V8 の loopy eager
   optimization 相当)。OSR は配列 locals 非対応で全滅していたが、
   初回コンパイルなら呼び出し前に丸ごと Wasm に乗る
2. **末尾で兄弟クロージャ (set_bnd) を呼ぶ** → unknown call reject。
   set_bnd は 349 bytecode + ループでインライナ (単一ブロック 30 命令
   上限) の射程外 → **同一モジュール複数関数 + 直接 call** が正解

## クラスタコンパイルの設計

「クラスタコンパイル」は本リポジトリの造語で、**呼び出し合う関数の一群
(main + それが呼ぶ兄弟クロージャ) を 1 つの Wasm モジュールにまとめて
コンパイルし、間の呼び出しを Wasm の直接 `call` にする**方式のこと。
ぴったり一致する既存名は無いが、分解すると 3 つの古典技法の合成になる:

| 部品 | 古典技法 | 出典 |
|---|---|---|
| upvalue をパラメータ化して独立関数に | **Lambda Lifting** | Johnsson 1985 (関数型言語コンパイラの標準変換) |
| callee を実行時の値で決め打ち + guard | **Speculative Devirtualization** (guarded direct call) | HotSpot / V8 の call site 最適化。クラスチェックの代わりにクロージャ identity を guard に使う変種 |
| コンパイル単位を関数境界から切り離す | **Region-Based Compilation** | Hank, Hwu & Rau 1995 (HP Dynamo 等) |

主流 JIT (V8/JVM) は境界消滅の手段にインライン展開を選ぶため、
「展開せず同一単位内の別関数として置き直接 call」という形は珍しい。
jsmini がこの形なのは Wasm という出力先の事情 — モジュールが複数関数の
自然な入れ物で、モジュール内 call が最初から速い — による。いわば
**Wasm ネイティブな region-based compilation**。

- **コンパイル時特殊化**: tryCall が持つ upvalue box の「今の値」で
  callee (クロージャ) を解決し、call-free な callee を main と同じ
  モジュールの関数としてコンパイル。IR の Call は `call $idx` になる
- **upvalue の受け渡し**: callee の box を caller の box と identity で
  マッチ → 一致すれば caller の upvalue param を転送、無ければ
  extraBox param を main に追加して JS 側から毎呼び出し値を渡す
- **正しさ**: 実行時に callee identity guard (`upvalueValues[k] ===
  コンパイル時の closure`)。差し替わったら deopt → VM
- **配列**: WasmGC ref としてモジュール内を素通し (escape 解析に
  クラスタ call 引数の許可を追加)。host 配列との copy-in/out は
  main の入口/出口 (executeWithArrayArgs) で 1 回だけ

V8 対応: これは V8 のインラインと同じ目的 (呼び出し境界の消滅) を、
インライン展開でなく **モジュール内直接 call** で達成する形。コード
複製が無いぶんキャッシュに優しく、教育的には「クロージャの静的解決 +
guard による投機」という V8 の speculative optimization の骨格が見える。

## 過程で掘り当てた独立バグ 5 件 (毎フェーズの伝統)

1. **IR builder の SetPropertyComputed desync**: VM は value を push、
   builder は arr を peek で残す — 「残る値の同一性」が違い、連鎖代入
   `lastX = x[i] = v` で後続の Sta が**配列を拾う** (Phase 29 以来の
   潜在バグ。NS の lin_solve が初の実害)
2. **local index の LEB128 未対応**: 生バイト push で locals 127 個超が
   `invalid local index: 4109`。大きいカーネルが初めて踏んだ
3. **完全ダイヤモンドの join 検出が単一ブロック then 限定**: 腕にループが
   あると block が閉じず `must end with end`。topo 範囲探索に一般化
4. **forceF64 で bool が f64 local/Phi を通ると型崩れ**: 比較結果 (i32) を
   f64 0/1 に正規化、Branch/Not も f64 対応
5. **配列 ref 引数が sawLeafBefore を立てない**: `ArrayGet(x, i-1)` で
   計算済み index の上に x が積まれ arr/index 逆転 (Phase 29 fix#4 の
   配列版)

安全弁も追加: スタック深さ不一致の合流を builder で検出 → compile 拒否。

## 教訓

1. **プロファイルの盲点は「呼ばれない関数」**: tier trace は呼ばれた関数
   しか出ない。「時間はどこにあるか」(ループ) と「JIT の入口はどこか」
   (呼び出し回数) のミスマッチは、trace を眺めても見えない
2. **連鎖代入バグの教訓 = 抽象解釈は VM と 1:1 で**: builder の抽象
   スタックが VM と「深さは同じだが残る値が違う」状態は、単純なテスト
   (statement 文脈) では絶対に見えない。opcode の仕様は「スタック効果」
   まで含めて写す
3. **サイズ限界系のバグ (LEB128) はベンチが踏む**: ユニットテストの
   関数は小さい。349 bytecode の set_bnd が初めて 127 locals を超えた
4. **「削る」二分探索が今回も最速**: lin_solve 縮小形 (A〜G の 7 変種) で
   f64 × 配列 × call の組み合わせから 3 バグを 1 つずつ剥がした

## 残課題 (次フェーズ候補)

- **深さ 2 クラスタ**: project → lin_solve → set_bnd (callee が callee を
  呼ぶ)。upvalue の転送を再帰化すれば NS はもう一段速くなる余地
- reset (配列 StoreUpvalue) / queryUI は VM のまま (実害小)
- deltablue の残 -7% はメソッドクラスタ (this 持ち同士) への拡張で
  同じ機構が使える見込み
