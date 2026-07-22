# LEARN-Phase36.md — 差分ファザで詰める: 実行時 TDZ と「状態リークが偽発散を生む」罠

## やったこと

Phase 35 で PROBLEMS.md に台帳化した残課題を上から潰し、差分ファザの生成器を
拡張しながら発散を **6/10000 → 0/100000** (5 seed × 20000) まで詰めきった。
全テスト 1166 パス、richards/deltablue/navier-stokes の JIT ベンチ回帰なし。

主要トピックは 2 つ:

1. **実行時 TDZ (Temporal Dead Zone) の実装**
2. **intern 汚染 — 共有可変状態が差分ファザの偽発散を大量生成していた発見**

## 1. 実行時 TDZ を「専用オペコード」で入れる

### 問題

差分ファザ最大のクラスタ (残存の ~83%) は switch の case をまたぐ宣言前アクセス:

```js
switch (undefined) {
  case 1: const v0 = true; break;   // このケースは実行されない
  default: [(v0)];                  // v0 は TDZ → 実 JS は ReferenceError
}
```

従来の「擬似 TDZ」は**コンパイル時の直列順序判定**だけ (`q; let q=1` のように
ソース上で宣言より前に読むと resolveLocal が null → global 経由で ReferenceError)。
switch のように**制御が宣言をスキップして別 case の共有 lexical を読む**ケースは
実行時の概念なので捕捉できず、VM/JIT は「宣言スロットを undefined として読む」→
TypeError/NaN になっていた。

### 設計判断: 専用オペコードでホットパスを守る

素直に「全 LdaLocal に穴チェック」を入れると、ローカル読みは処理系で最もホットな
命令なのでベンチが確実に落ちる。そこで **lexical (let/const) 専用のオペコード**を
分けた:

- `StaHole <slot>`: lexical スコープ入口でスロットを TDZ の穴 (`TDZ_HOLE` sentinel)
  に初期化
- `LdaLocalTDZ` / `StaLocalTDZ`: 穴なら ReferenceError、それ以外は通常ロード/ストア
- `LdaUpvalueTDZ` / `StaUpvalueTDZ`: クロージャの宣言前キャプチャも捕捉
- `CheckTDZ <slot>`: const 再代入時の TDZ 優先判定 (下記)

var/param の `LdaLocal`/`StaLocal` は**一切触らない**。コンパイラは lexical スロット
集合 (`lexicalSlots`) を持ち、読み書きの emit 時にどちらの命令を出すか振り分ける。
upvalue は親スコープの lexicalSlots を見て tdz フラグを伝播させる。

### JIT では TDZ を省略してよい理由

TDZ 版オペコードは IR/wasm で通常版に map、`StaHole`/`CheckTDZ` は no-op にした。
**穴を踏むコードは必ず throw するので hot にならない (tier-up しない)**。よって
実際に穴を踏む実行は常に cold パス = VM 解釈で処理され、そこで TDZ が正しく効く。
JIT に穴チェックを入れなくても収束し、かつ StaHole を no-op 化することで JIT の
型分析がスロット型を汚さない (実 StaLocal が型を決める) のでベンチ回帰もない。

### エラー優先順位 (spec 7.x SetMutableBinding)

TDZ を入れると「TDZ と別のエラーのどちらが先か」が問題になる。node で確認:

```js
// const-in-TDZ への代入: TDZ (ReferenceError) が const-immutable (TypeError) より優先
switch (0) { case 1: const v0 = 1; break; default: v0 = 2; }   // ReferenceError

// 複合代入 (prim).x += RHS: RHS 評価が先。RHS 内の TDZ が prim 書込 TypeError より優先
const b = true; switch (0) { case 1: const v = 1; break; default: b.x += (true ? v : 0); }
// → ReferenceError (v の TDZ)、TypeError (b への書込) ではない
```

前者は `CheckTDZ` を `ThrowConstAssign` の前に挟んで解決。後者は「プリミティブへの
プロパティ**読み**は undefined を返す (throw しない)。TypeError は**書き込み時**
(RHS 評価後) に出る」という順序を TW に守らせて解決。

## 2. 差分ファザの罠: 共有可変状態が偽発散を生む

### 症状

生成器を拡張して回すと発散が 100〜380 件出る。ところが上位クラスタを
`--repro <gen seed>` で**単独再現すると 3 エンジンが一致する**。minimize 済み
ファイルの不忠実さかと思いきや、**gen seed から忠実に再現しても単独では一致**。

### 犯人

決定的に再現させると分かった: 対象プログラムを**単独で実行すると一致、直前の
1939 プログラムを同一プロセスで流した後に実行すると発散** (TW が undefined→NaN)。
純粋な tree-walker が同じソースで違う結果を出す = **モジュールレベルの共有可変
状態が漏れている**。

犯人を二分探索で 1 本前のプログラムまで絞ると:

```js
let v1 = "a"; (v1).x += ...;   // プリミティブ文字列へのプロパティ代入
```

jsmini は文字列を **intern (共有) して JSString オブジェクトで表現**する。TW は
`"a".x = 5` を strict の TypeError にせず、**黙って intern 共有オブジェクトに書き
込んで**いた。intern は全プログラムで共有されるので、この 1 行が**以後すべての
`"a"` の `.x` を汚染**し、無関係なプログラムで偽発散を生んでいた (`--isolate` でも
子プロセスが多数のプログラムを 1 プロセスで実行するため再現する)。

strict では TypeError なので TW/VM 両方で throw に統一 (VM は文字列を黙って無視、
number/boolean は host 経由で TypeError と挙動が不統一だった)。これだけで
残存 ~130 → 7 件に激減した。

### 教訓

- **共有可変状態 (intern プール, シンボルレジストリ等) を持つ処理系を差分ファジング
  するときは、プログラム間の状態リークが偽発散に化ける。**
- 1 発散は必ず `--repro` で単独再現し、「単独では一致するのに連続実行だと発散」なら
  状態リークを疑う。二分探索で「発散を引き起こす直前のプログラム」を特定すると
  犯人の行が浮かぶ。
- 既知確定の host 境界差 (`.constructor` の Array vs Object 等) は生成器から
  除外してノイズを減らすと、新規バグの信号が見えやすくなる。

## 残る発散 0 の内訳 (収束の最後の 7 → 0)

| クラスタ | 正 | 修正 |
|---|---|---|
| プリミティブへのプロパティ代入 (intern 汚染) | TypeError | TW/VM 両方で throw |
| null/undefined へのプロパティ代入 | TypeError | TW が RefError だったのを修正 |
| const-in-TDZ への代入 | ReferenceError | VM に CheckTDZ を追加 |
| 複合代入 (prim).x += RHS(TDZ) | ReferenceError | TW の書込 throw を RHS 評価後に |
| メソッド呼び出しの評価順 | obj が先 | VM が引数を先に評価していたのを修正 |

いずれも「TW/VM/JIT のどれか 1 つだけが誤る」バグで、node を正として 3 エンジンを
同時に収束させた。

## 保留

- **計算で生まれる -0** (`-x` で x=0): JIT の i32 表現の構造的限界。V8 同様の deopt が
  必要でコスト大・実害小。台帳に残す。
- **`.constructor` の host 境界差**: 両エンジンで独自 Array/Number を一貫モデル化する
  大規模作業。将来フェーズ。
- **node をオラクルにした差分実行** (`--oracle node`): TW/VM/JIT が「揃って間違える」
  共通違反は差分ファザでは映らない。差分ファザが収束した今、次に価値が出る方向。
