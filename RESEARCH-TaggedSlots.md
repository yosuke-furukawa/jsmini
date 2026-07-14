# RESEARCH-TaggedSlots — tagged pointer で object JIT を参照対応にする (Phase 33)

## 動機: 「数値コプロセッサ」の壁

Phase 30-32 で判明した jsmini JIT の構造的限界:

| ベンチ | VM | JIT | 差が小さい理由 |
|---|---|---|---|
| navier-stokes | 2089ms | 123ms (**17x**) | 数値カーネル = JIT の得意分野 |
| richards | 118ms | 112ms (+5%) | scheduler が参照 (tcb.link) を走査 → deopt |
| deltablue | 159ms | ±0〜-7% | 制約グラフ (v1/v2/determinedBy) が参照 → deopt |
| splay | 2457ms | ±0% | 木のノード (left/right) が参照 + GC バウンド |

現行の this-model は **linear memory に生の i32/f64 を置く**ため、
「42 という数値」と「アドレス 42」が区別できない。だから
「使うプロパティが全部数値のときだけコンパイル」(used-props) という
制約になっている。**参照スロットを表現できれば OO ベンチが JIT 圏内に
入る** — それが本フェーズのテーマ。

## tagged pointer とは

1 マシンワードに「数値かもしれないし参照かもしれない値」を詰める古典技法。
ヒープポインタは整列 (4/8 バイト境界) されるので**下位ビットが常に 0** で
あることを利用し、そこに型タグを埋める。

### V8 流: Smi (Small Integer) タグ

```
数値 42:         ...0101010 0   ← 最下位 0 = 整数 (値 << 1)
オブジェクト参照: ...beef...1   ← 最下位 1 = ヒープポインタ (実アドレス - 1)
```

- 判定 1 命令 (`word & 1`)、Smi 同士の加算は untag 不要
  (`(a<<1)+(b<<1) == (a+b)<<1`)
- double は入らない → HeapNumber に箱詰め。これを緩和するのが
  elements kind (PACKED_DOUBLE) や unboxed double fields

### JSC 流: NaN boxing

逆転の発想で**全値を f64 で持つ**。IEEE754 の NaN には未使用の 51bit が
あり、そこにポインタ/整数/タグを詰める。double がノータグ最速になる
代わり、ポインタ操作にマスクが要る。

## Wasm には標準の道具がある

### WasmGC の i31ref = Smi の標準化

`i31ref` は「31bit 整数を ref 型スロットに直接埋め込む」型。
OCaml/Scheme のコンパイルのために GC proposal に入った、
**まさに tagged pointer の Wasm 版**。

```
(ref eq)  ← eq 型階層: i31ref / struct ref / array ref の union
ref.i31          ; i32 → i31ref (tag)
i31.get_s        ; i31ref → i32 (untag)
ref.test (ref i31)  ; タグ判定
br_on_cast       ; 判定 + 分岐を 1 命令で
ref.eq           ; identity 比較 (eq 階層同士)
```

### NaN boxing も Wasm で安い

linear memory を続投する場合は f64 スロットに NaN box:
`i64.reinterpret_f64` + マスクで判定/取り出し。参照は
**object table (JS 側の配列) の index** を payload に入れる。

## 設計候補 3 案

### 案 A: オブジェクトを WasmGC struct に移住 (本丸・大)

jsmini のオブジェクトそのものを WasmGC の struct
(`(struct (field (mut (ref eq)))...)`) にして、ヒープごと Wasm に移す。

- ネストした参照アクセス (`tcb.link.id`) も Wasm 内で完結
- HiddenClass = struct 型 + shape check (`ref.test`) で投機
- **GC も Wasm エンジン任せになる** (splay の課題まで射程)
- 代償: VM 側 (HiddenClass/slots/IC/GC) との二重管理 or 全面移行。
  エンジンの心臓移植であり Phase 1 個には収まらない

### 案 B: this-model のスロットを (ref eq) 化 (段階案・中)

copy-in/out の単位は現行のまま、スロット表現だけ tagged にする:
executeWasm が slots を `(array (mut (ref eq)))` に変換して渡す。
整数は `ref.i31`、f64 は box struct、参照は **eq 化した host ref**。

- 参照の load / store / null・identity 比較 / 引数渡し / 返却が
  Wasm 内で可能に → `this.currentTcb = this.currentTcb.link` 級が解禁
- **ネストしたプロパティアクセスはまだ不可** (参照先の slots は
  メモリに無い) → richards の schedule 完全版には届かない
- 数値演算のたびに untag が入る → Smi 演算最適化の追体験

### 案 C: NaN boxing + object table (linear memory 続投・中)

f64 スロットに NaN box。参照は object table の index。
ネストアクセスは import 関数 `__load_slot(objIdx, slotIdx) → f64` で
VM に聞く (毎回 VM 再実行するより桁違いに安い境界)。

- 既存の linear memory 機構 (copy-in/out, propOffsets) を最大限流用
- import 経由のネストアクセスは shape check なしで VM が解決 →
  正しさは楽、速さは import 呼び出しコスト次第 (要計測)

## 課題の詳細

### 課題 1: host オブジェクトの identity 比較 (最初の分岐点)

jsmini のオブジェクトは JS オブジェクト (HiddenClass + slots 配列) で、
Wasm に渡すと **extern 階層 (externref)** に入る。問題は eq 階層との関係:

- `ref.eq` が使えるのは **eq 階層** (i31 / struct / array) だけ
- `any.convert_extern` で extern → any に内部化できるが、その結果の
  「host reference」が eq に落ちるか (= `ref.eq` 可能か) は
  **仕様の読みだけでは確信が持てず、エンジン実装依存の可能性**がある

richards の `while (this.currentTcb != null)` や deltablue の
`strength == REQUIRED` は参照の identity 比較そのものなので、
ここが成立しないと案 B の価値が半減する。

**spike の内容**: V8 (Node) で
`(ref.eq (any.convert_extern (local.get $jsObj1)) ...)` を含む
モジュールが (a) validate されるか (b) 同一 JS オブジェクトで true を
返すか を最小モジュールで確認。

**フォールバック**: 不成立なら参照を **object table の index (i31)** で
持つ (案 C とのハイブリッド)。identity 比較は i31 同士の比較になり
確実に動く。代償は copy-in 時の table 登録コストと、table の
リーク管理 (呼び出し単位で clear すれば有界)。

### 課題 2: untag コストと「表現選択」パス

tagged スロットの数値は演算のたびに往復が要る:

```wat
;; x = x + 1 (tagged のまま素朴にやると)
local.get $slot      ;; (ref eq)
ref.cast (ref i31)   ;; guard
i31.get_s            ;; untag → i32
i32.const 1
i32.add
ref.i31              ;; re-tag
```

生の i32 加算 1 命令が 5 命令になる。ホットループでこれをやると
NS の 17x を自分で殺すことになる。必要なのは V8 の
**representation selection** に相当するミニパス:

- **ループ内・関数内の値は untag した i32/f64 の local で持つ**
- tag/untag は **スロット境界 (LoadProperty/StoreProperty) だけ**
- 既存の Range Analysis (functionNeedsF64) を「この値は i31 に収まる
  整数か」の判定に拡張する

**31bit の罠**: i31 は ±2^30 まで。JS の整数 (2^53) はそれを超え得る。
超える値は f64 box 行きになるので、copy-in 時に
`Number.isInteger(v) && |v| < 2^30` のガードが要る (現行の i32 ガードの
i31 版)。richards/deltablue/splay の実データはほぼ小整数なので
実害は少ない見込みだが、ガード自体は必須。

**spike の内容**: 「untag→演算→retag をループ内でやる」vs「local で
untag して持つ」のマイクロベンチ (1000 万回ループ) で倍率を実測。

### 課題 3: f64 の box 問題とモデルの二本立て

i31 に f64 は入らないので、tagged モデルでの f64 は
`(struct (field f64))` の box になる。NS が tagged モデルに乗ると
**ArraySet のたびに box を 1 個アロケート**することになり、
GC 圧が爆発する (V8 が HeapNumber で苦しみ、elements kind と
unboxed double fields を発明した理由の追体験)。

対策は**関数ごとのモデル選択**:

```
compileViaIR:
  used-props が全部数値 (現行判定) → 現行 linear memory モデル (速い)
  参照を含む → tagged (ref eq) モデル (課題 1-2 の機構)
```

つまり tagged モデルは**置き換えではなく追加**。richards の schedule 系は
tagged、NS のカーネルは現行のまま、という住み分けになる。
feedback にプロパティごとの表現 (int / double / ref) を記録する
**field representation tracking** (V8 の Smi→Double→Tagged lattice の
簡易版) を足すと、モデル選択の精度が上がる。

### 課題 4: write-back と参照の書き込み

現行 write-back は「linear memory の i32 → slots」の単方向コピー。
tagged 版では:

- **読み戻し**: i31 → number、f64 box → number、host ref → JS
  オブジェクト。JS API 経由なら WasmGC array に入れた JS オブジェクトは
  **同一オブジェクトのまま**返ってくる (identity 保存) はずで、
  これも spike で確認する
- **参照の store**: `this.currentTcb = this.currentTcb.link` のような
  参照代入が Wasm 内で起きる。書かれる値は必ず「copy-in された
  either スロット由来 or 引数由来」の eqref なので、write-back で
  そのまま slots に戻せる。**Wasm 内で新しいオブジェクトは作れない**
  (Alloc は現行どおり bail) — この制約は維持する

### 課題 5: null / undefined / boolean の表現

eq ドメインの中で JS の特殊値をどう表すか:

| JS 値 | 候補 | 注意 |
|---|---|---|
| null | `ref.null eq` | `x != null` は `ref.is_null` — 自然 |
| undefined | 専用 singleton (i31 の予約値 or 専用 struct) | null と区別が要る (`== null` は両方 true だが `=== null` は違う) |
| true/false | i31 の 1/0 | typeof が要る関数は bail (現行方針の継続) |

「undefined を i31 の特定値 (例: -2^30) で予約する」のが最小だが、
本物の -2^30 と衝突する。専用 struct singleton の方が安全で、
`ref.test` 1 回で判定できる。

### 課題 6: deopt の位置 — 境界ガード方式を維持できるか

現行モデルの美点は「**型チェックが全部呼び出し境界にある**」こと
(copy-in で検査 → Wasm 内は無検査で全速)。tagged モデルでも
同じ形を保てるかが性能の分かれ目:

- copy-in 時に「この関数がコンパイル時に仮定した各スロットの表現
  (int / ref / null)」と実際の値を突き合わせ、外れたら従来どおり
  deopt → VM (**Wasm 内に ref.cast を置かない**)
- ただし **Wasm 内で参照を辿った先** (`a.link` の結果を `.id` する等 =
  ネストアクセス) は境界で検査できない → 案 B ではネストを
  スコープ外にしている理由がこれ。ネストに踏み込む (案 A / Phase 34+)
  なら in-Wasm shape check + 中途 deopt (途中まで実行した副作用の
  巻き戻し問題!) が必要になり、難度が一段上がる

### 課題 7: 既存機構との整合

- **クラスタコンパイル**: callee の引数/返り値にも tagged 値が流れる →
  クラスタ内の呼び出し規約を (ref eq) 対応に (モデル選択は
  クラスタ単位で統一する必要がある)
- **配列**: 現行の WasmGC 配列は `(array (mut f64))`。参照入り配列
  (V8 の PACKED_ELEMENTS 相当) を扱うなら `(array (mut (ref eq)))` の
  第二配列型が要る — ただしこれは Phase 29 で「非数値要素は VM」と
  割り切った領域なので、本フェーズではスコープ外にできる
- **文字列**: interned string id (i32) は i31 にそのまま乗るが、
  「参照としての文字列」(identity でなく値比較) は別問題 → bail 継続

## spike 結果 (33-1, 2026-07-13, Node/V8)

| 項目 | 結果 |
|---|---|
| (a1) anyref を直接 ref.eq | **validate FAIL** (予想通り: anyref ⊄ eqref) |
| (a2) `ref.cast (ref null eq)` を挟む | validate は通るが **実行時 `illegal cast` trap** — V8 では JS オブジェクト (internalized host ref) は **eq 階層に入らない** |
| (c) `(array (ref null any))` round-trip | **同一オブジェクト保存 OK** (identity は JS 境界を往復しても保たれる)。数値 42 → 42 も OK |
| (b) i31 tag/untag をループ内で毎回 vs 素の i32 | 1 億回ループで **251ms vs 237ms (+6%)** — V8 の TurboFan が tag/untag をほぼ消す。untag コストの恐怖は杞憂 |

### 結論: 設計を 案 C' (Smi 流タグを i32 に埋める) へピボット

**課題 1 の答えは「不成立」** — host オブジェクトを Wasm 内で ref.eq
できない以上、(ref eq) スロットの主目的 (参照をそのまま持つ) が
成立しない。フォールバックとして用意していた **object table (index
参照)** を主軸に格上げする。すると気づく: 参照が「整数 index」なら
**WasmGC の型は不要で、既存の linear memory の i32 スロットに
V8 の Smi と同じビットタグを埋めれば足りる**:

```
i32 スロット:
  偶数 = 数値 (value << 1)          ← V8 の Smi そのもの (30bit 範囲)
  奇数 = 参照 (tableIdx << 1) | 1   ← object table の index
  予約 = null / undefined 用の固定タグ値
```

- identity 比較 = i32 比較 (copy-in 時に同一オブジェクト → 同一 index に
  dedup するので正しい)
- null チェック = 定数比較
- object table は JS 側の配列 (呼び出しごとに length リセットで再利用、
  アロケーション無し)
- **ネストアクセス** (`a.link.id`) は import 関数
  `__load_slot(tableIdx, offset) → tagged i32` で VM に聞く
  (関数まるごと VM 落ちより桁違いに安い; 案 C の合流)
- f64 が要る関数はタグと両立しないので現行どおり bail
  (数値専用関数は現行モデル維持 — 二本立ての方針は不変)

教育的な皮肉: WasmGC の i31ref を調べに行って、**V8 が 30 年前から
やっている「i32 に 1 bit タグ」に戻ってきた**。ただし (b) の計測で
「タグ操作は最適化コンパイラがほぼ消す」ことを実証できたのは収穫
(V8 内部で Smi が速い理由の裏取り)。

## 推奨: Phase 33 スコープ

spike の結果を受けて **案 C' (i32 Smi タグ + object table)** で進める:

```
33-1  spike — 完了 (上記)
33-2  tagged this-model: copy-in で Smi タグ化 + object table 構築
      (dedup) + write-back (奇数 → table 引き、偶数 → >>1)
33-3  codegen: tagged スロットの LoadProperty/StoreProperty、
      identity / null 比較、Branch (truthiness)。数値演算に流れる
      tagged 値は copy-in ガードで Smi と検証して untag
33-4  ネストアクセス: __load_slot(tableIdx, offset) import
      (richards の schedule 系が real target)
33-5  richards / deltablue / splay で計測 → 案 A (struct 移住) の判断
33-6  LEARN-Phase33 (Smi/NaN boxing/i31ref/spike の教材化)
```

**期待値の管理**: 案 B ではネストアクセス (`tcb.link.id`) とメソッド
呼び出し (`task.run()`) は未解決なので、richards/deltablue が一気に
数倍になるとは限らない。本フェーズは「tagged 表現の基盤 + 実測」で、
その結果が Phase 34+ (案 A = struct 移住、メソッドクラスタとの合流、
世代別 GC) の投資判断になる。

## 補足

- PLAN-v7 P3 (test262 ブースト) は Phase 34 に繰り下げ
- V8 の対応物: Smi/HeapNumber/tagged fields。案 A まで行くと
  「V8 のオブジェクトモデルを WasmGC で再構築する」ことになり、
  教育リポジトリとしては最終ボス感のあるテーマ
