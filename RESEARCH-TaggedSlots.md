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

## 未検証の論点 (spike が必要)

1. **host オブジェクトの eq 化**: JS オブジェクトを Wasm に渡すと
   extern 階層 (externref) になる。`any.convert_extern` で any 階層に
   変換したものが `ref.eq` で identity 比較できるか (host ref の扱いは
   エンジン依存の可能性) — V8 での実挙動を確認する
2. **i31 untag のコスト**: ループ内で数値演算するとき
   `i31.get_s` → 演算 → `ref.i31` の往復がどれだけ効くか。
   「ホットループ内はローカルに untag した i32/f64 で持ち、
   スロット境界だけ tagged」にする最適化が必要か
3. **f64 box のアロケーション**: NS のような f64 密度の高いコードが
   案 B に乗ると box だらけになる → 「数値のみ関数は現行モデル、
   参照が要る関数だけ tagged モデル」の二本立てが現実的か
4. **write-back**: tagged スロットの store を VM の HiddenClass slots に
   反映する経路 (現行 write-back の拡張で足りるはず)

## 推奨: Phase 33 スコープ

**案 B を主軸**に、二本立て (数値専用関数は現行モデル維持) で進める:

```
33-1  spike: eq 化 host ref の ref.eq / i31 往復コスト / f64 box の
      マイクロベンチ (設計の分岐点を先に潰す)
33-2  (ref eq) スロットの this-model v2: tagged copy-in/out + write-back
33-3  emitOp: LoadProperty/StoreProperty の tagged 対応
      (i31 投機 + ref.test guard + deopt)
33-4  参照の identity 比較 (== / != / null 比較) を Wasm 内で
33-5  richards / deltablue / splay で計測 — 「参照を持ち回るだけ」で
      どこまで解放されるかの実測が案 A へ進む判断材料
33-6  LEARN-Phase33 (Smi/NaN boxing/i31ref の教材化)
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
