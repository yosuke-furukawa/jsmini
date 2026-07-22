# PROBLEMS.md — 既知の未解決問題

差分ファザ (`npm run fuzz`) による収束状況と、残る既知の問題台帳。
正しさの基準は **node (strict mode)**。

## 収束の履歴

| 時点 | divergence |
|------|-----------|
| Phase 35 開始 | 903 / 5000 |
| Phase 35 完了 (PR #35) | 6 / 10000 |
| Phase 36-6 完了 | **0 / 100000** (5 seed × 20000) |

Phase 36-6 で差分ファザは完全収束した (5 seed × 20000 = 10 万プログラムで発散 0)。
主な要因は下記の **intern 汚染バグの発見** で、これが偽発散を大量生成していた。

## Phase 36 で解決済み (この台帳から除去)

- **§1-2 JIT tagged slots の boolean** → 36-5 で TAG_FALSE/TAG_TRUE を追加して解決
- **§2-1 switch case 内 function 宣言が TW で不可視** → 36-1 で解決
- **§2-2 TW の host 配列メソッドが JSString を壊す** → TW_ARRAY_OVERRIDES で解決
- **§2-3 メンバ代入 `obj.p = rhs` の評価順** → 36-1 で解決 (単純/複合とも obj 先)
- **§2-4 const 閉包の巻き上げ順** → 36-1 で解決
- **§3-1 `"5" == 5`** → 36-3 で ToNumber 段を追加して true
- **§3-2 ユーザー定義 valueOf/toString** → 36-4 で解決
- **§3-3 TW の `+=` が host string を生む** → 36-4 で解決
- **§1-1 計算で生まれる -0 が 0 になる** → Phase 37 で f64 昇格して解決 (下記詳細)
- **TDZ (Temporal Dead Zone)** → 36-6 で実行時 TDZ を実装 (下記詳細)
- **プリミティブへのプロパティ代入** → 36-6 で TypeError に統一 (intern 汚染の根治)
- **TDZ とエラー優先順位** → 36-6 で spec 準拠 (TDZ > const-immutable, RHS 評価 > 書込)
- **メソッド呼び出しの評価順** → 36-6 で obj を引数より先に

### 36-6 の目玉: intern 汚染による差分ファザの信頼性バグ

`"a".x = 5` (プリミティブ文字列へのプロパティ代入) を、TW は黙って intern 共有の
JSString オブジェクトに書き込んでいた (spec 違反)。intern は全プログラムで共有
されるため、この書き込みが**後続の差分実行に状態を漏らし**、無関係なプログラムで
大量の偽発散を生んでいた (isolate でも再現 = 子プロセスも同一プロセスで多数の
プログラムを実行するため)。strict では TypeError なので TW/VM 両方で throw に統一し
根治。これだけで残存発散 ~130/10000 → 7/10000 に激減した。

**教訓**: 共有可変状態 (intern プール等) を持つ処理系を差分ファジングするときは、
プログラム間の状態リークが偽発散に化ける。1 発散を必ず `--repro <gen>` で単独
再現して「単独では一致するのに連続実行だと発散する」パターン (= 状態リーク) を
疑うこと。

## 1. 残る既知の divergence

### 1-1. JIT: 計算で生まれた -0 が 0 になる → Phase 37 で解決

```js
function f0(a, b) { return a * b; }
// f0(0, -1) は実 JS で -0。1 / f0(0,-1) は -Infinity
// 修正前: JIT (i32.mul) は +0 → +Infinity
```

- i32 に -0 は無く、i32.mul/i32 の negate (`0 - x`) が -0 を 0 に潰していた。
- **解決 (deopt ではなく f64 昇格)**: f64.neg/f64.mul は -0 をネイティブ保持する
  ので、-0 を生みうる Negate/Mul を含む関数を f64 コンパイルに昇格させる。
  - IR パス: `functionNeedsF64` に `opProducesNegZero` を追加 (operand の range で
    -0 の可能性を判定)。
  - direct パス: `bytecodeHasRiskyMul` で spec を f64 昇格。`x * 正の整数定数`
    (0*正=+0) は安全なので i32 のまま (index 計算のホットパス維持)。Negate は
    direct パスが元々 i32 で bail して f64 化するので対象外。
  - 併せて strength-reduce の -0 非健全な恒等変換 (x*0→0, x+0→x) を f64 関数で
    抑止 (f64 昇格で -0 が IR に到達可能になり顕在化した潜在バグ)。
  - **引数/グローバルで渡された -0** も対応: i32 特殊化の copy-in で -0 が来たら
    deopt して VM 実行に落とす (`id(-0)` が -0 を保持)。既存の「非整数引数 →
    deopt」と同じ仕組み。稀なので実害小。

### 1-2. `.constructor` の host 境界差 (生成器から除外)

```js
[1, 2].constructor    // TW: function Array()   VM/JIT: function Object()
(3).constructor       // TW: function Number()  VM/JIT: 同上のズレ
```

- TW は配列/数値を host のまま公開するので `.constructor` が host の
  Array/Number を返す。VM は jsmini の Object (null prototype) を返す。
- 収束させるには両エンジンで jsmini 独自の Array/Number コンストラクタと
  prototype チェーンを一貫してモデル化する必要があり、大規模。**将来フェーズ**。
- 既知確定発散なので差分ファザの generator では `.constructor` を生成しない
  (新規バグ検出のノイズになるため。src/fuzz/generator.ts のメンバアクセス集合)。

## 2. 全エンジン共通のスペック違反 (差分ファジングには映らない)

差分ファザは「TW/VM/JIT が同じ間違いをする」バグを検出できない。node との
差分実行 (node をオラクルにする `--oracle node` 相当、あるいは本家 Fuzzilli 連携)
が将来課題。現状で判明している共通違反は特に無いが、網羅はできていない。

## 3. 実行モデルの構造差 (仕様の範囲内 / ファザは判定不能として除外)

- **ホストスタックオーバーフロー**: TW は host 再帰で評価するため深い再帰は
  RangeError (host)。VM は自前フレームでステップ上限。「判定不能」扱い。
- **ステップ上限**: VM/JIT は maxSteps で停止するが TW には無い。無限ループは
  タイムアウト検出のみ。

## 4. TDZ 実装の範囲 (36-6)

実行時 TDZ は block / switch / 関数本体直下の let/const と、それらを閉包
キャプチャする upvalue read/write をカバーする (専用オペコード LdaLocalTDZ /
StaLocalTDZ / LdaUpvalueTDZ / StaUpvalueTDZ / StaHole / CheckTDZ)。

- **for-init の let/const は TDZ 対象外**: `for (let i = f(); ...)` で f が i を
  読むケースは穴を張っていない (宣言が本体より先に走るため実害ほぼ無し)。
- **JIT は TDZ チェックを省略**: TDZ 版オペコードは JIT では通常版に map し、
  StaHole/CheckTDZ は no-op。穴を踏むコードは throw して hot にならない (tier-up
  しない) ため、cold パス = VM 解釈で正しく TDZ が効く。ホットパスの
  LdaLocal/StaLocal は無変更でベンチ回帰なし。

## 5. 検証方法

```bash
npm run fuzz -- --iterations 20000 --seed 111 --isolate   # 収束確認 (0 期待)
npm run fuzz -- --repro <gen seed>                        # 1 件の詳細 (単独再現)
npx tsx --test src/vm/strict-semantics.test.ts            # 回帰テスト
```

修正の際は「正 = node (strict)」で確認し、TW/VM/JIT の 3 エンジンを同時に
直して収束させること (片方だけ直すと divergence が増える)。
1 発散は必ず `--repro` で単独再現し、minimize 済みファイルは不忠実なことがある
ので gen seed から再現すること。
