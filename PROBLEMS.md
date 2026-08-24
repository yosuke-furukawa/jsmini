# PROBLEMS.md — 既知の未解決問題

jsmini の「できていないこと」の台帳。正しさの基準は **node (strict mode)**。
前半は現状の欠落の全体地図 (2026-07-23 調査)、後半は差分ファザの収束履歴と教訓。

## 現状サマリ (2026-07-28, Phase 43 時点)

- test262: **TW 71.2% / VM 66.6% / JIT 65.9%** (14,053 件実行、noStrict/module 520 件スキップ)
  — Phase 43 で yield* 委譲 (sync/async、GetMethod 意味論) + Symbol.asyncIterator +
  TW の Symbol キー defineProperty 修正。TW +320 / VM +282 / JIT +278
  — Phase 42 で class private # の全ポジション (メソッド/static/getter/setter/
  generator/async/brand check/Unicode 名) + Unicode 識別子。TW +442 / VM +433 / JIT +383
  — Phase 41 で async generator (`async function*` / `async *m()` / `for await`) を
  3 モードに実装。TW +535 / VM +487 / JIT +487 パス
  — Phase 40 で async 1,634 件を skip→実行に変更 (skip 2,114 → 520)。
  Phase 39 参考値 (async skip 時、分母 12,459): TW 63.4% / VM 60.3% / JIT 60.1% —
  分母が 1,594 件増えた上で Phase 39 の率を超えた
- private # の意味論: パーサで名前を不可視プレフィックス (U+2063) 付きに mangle する
  近似 (per-class brand ではない)。hasOwnProperty("#x") / "#x" in obj から観測不能
- 残る失敗の主クラスタ: Promise 反復エラーで $DONE 未到達 (~116)、
  iterator close (~100)、fn name 推論 (~80)。yield* 委譲は Phase 43 で解決
  (残る簡易化: sent 値の内側転送 / throw・return の内側イテレータ転送)
- 内部テスト 1,343 全パス / 差分ファザ **0 / 100,000** で収束維持
  (残 1 件は Phase 39 以前からの logs 差ノイズ)
- ただし TW↔VM には test262 で **TW だけ失敗 / VM だけ失敗**の非対称が残る
  (ファザの generator が class/label 等を生成しないため未検出だった領域)

---

# Part 1: できていないことの全体地図

## 1. VM が TW に追いついていない機能 (エンジン間非対称)

直接プローブで確認した現状 (✅=動く / ❌=壊れている):

| 機能 | TW | VM |
|---|---|---|
| `class B extends A {}` | ✅ | ✅ **Phase 39 で解決** (ClassLink/CallSuper/GetSuperProp) |
| `super()` / `super.m()` | ✅ 39 で修正 | ✅ **Phase 39 で解決** (TW の super.m は静的側参照の誤実装だった) |
| Error 継承 (message 付与) | ✅ 39 で解決 | ✅ 39 で解決 |
| `f(...args)` spread 呼び出し | ✅ | ✅ **Phase 39 で解決** (CallSpread/CallMethodSpread/ConstructSpread) |
| `{...obj}` object spread | ✅ ({..."ab"} は 39 で修正) | ✅ **Phase 39 で解決** (CopyDataProps) |
| class computed key `[String(fn)]` | ✅ **Phase 39 で解決** | ✅ |

- **class 継承 (extends/super/static 継承/フィールド順/Error 継承) と
  spread (呼び出し/object)、async メソッドは Phase 39 で 3 エンジン一致に**。
  class 系 test262 の主残件は private `#` の一部ポジション (296 件) と
  属性モデル (§2)。async 系で直したもの: class/object リテラルの async
  メソッド + async *g のパース、`async` をキー/メソッド名/フィールド名として
  使用可、VM の runAsyncFunction が this を落とすバグ、async arrow の
  式本体 (expression フラグ欠落)。残り: `for (async.x of ...)` 等の
  「識別子としての async」(contextual keyword 化が必要、3 件)
- TW の class computed key は Phase 39 で解決: native 呼び出し時の JSFunction
  ラッパーに元関数をタグ付けし、String(fn) をキー正規化と同じ "[object Object]"
  に統一 (jsmini は関数ソーステキストを保持しないため、仕様のソーステキスト
  ではなく「定義時とアクセス時の一致」を保証する近似)。**これで §1 の
  エンジン間非対称は全解消**
- super の残課題: `super.x = v` (代入) 未対応 / getter・setter 経由の super 解決は
  非対応 (メソッドと素の読みのみ)
- spread の残課題: spread 呼び出しは callFunction 同期実行のため JIT profiling の
  対象外 (頻度が低いので許容)。generator/async callee への spread は未検証

## 2. 両エンジン共通の欠落: オブジェクトモデル

- ~~プロパティ属性が飾り~~ / ~~accessor descriptor 未対応~~ → **Phase 39 で解決**。
  VM は JSObject に sparse な __attrs__ (デフォルト外のみ記録、ホットパスは
  1 チェック素通り) + OrdinarySet 近似の checked store。TW は host object なので
  host defineProperty/freeze に委譲 (JSFunction get/set はラップ + identity 復元)。
  freeze/seal/defineProperty(get/set)/gOPD/再定義制限/enumerable フィルタ/
  class メソッド non-enumerable/fn.name・length 記述子まで実装。
  verifyProperty ハーネスも本実装化 (空実装の見かけパスが剥がれ、基準が正直化)
- 残り: 属性系の細部 — 名前推論の一部 (`name.value` 不一致 ~28 件)、
  computed key メソッドの属性、Symbol キーのプロパティ属性、
  BytecodeFunction 内部フィールド (paramCount 等) が列挙に漏れる問題。
  JIT の StoreProperty (wasm write-back) は attrs チェックを通らない
  (frozen オブジェクトが hot 関数内で書かれるケース — 実害は限定的)
- **`.constructor` の host 境界差**: `[1,2].constructor` が TW=host Array /
  VM=jsmini Object (null prototype)。収束には両エンジンで独自 Array/Number
  コンストラクタ + prototype チェーンの一貫モデル化が必要 (大規模)。
  既知確定発散なので差分ファザの generator からは `.constructor` を除外済み

## 3. パーサ未対応構文

- `new.target` (パース不可)
- class private の一部ポジション: 単純な `#x = 1` フィールドは動くが、
  `#m()` メソッド / `static #x` / `#x in obj` で "Unexpected character '#'"
- ~~`for ([a, b] of ...)` — 分割代入 LHS の for-of~~ → **Phase 44 で解決**:
  宣言なし LHS (分割パターン/メンバ/識別子) と CoverInitializedName を実装
- ~~strict early error 不在~~ → **Phase 39 で解決**: eval/arguments の束縛
  (var/let/const/仮引数/rest/分割/catch/関数名/class 名) と代入・++/-- を
  パース時に SyntaxError に。strict の重複パラメータも検査。
  残り: class 内 eval の意味論 (`eval("super()")` の拒否等、66 件 — eval に
  スコープ解析が必要)、未定義ラベルへの break/continue (no-op のまま)

## 4. ビルトイン不在・部分実装

- **完全不在**: `Proxy` / `Reflect` / `BigInt`
- ~~`class E extends Error` が両エンジンとも不正~~ → Phase 39 で解決 (message 付与)
- メソッド歯抜け ("Not a function" 384 件): ES2025 系
  (`Map.prototype.getOrInsertComputed` 等) を含む
- RegExp: `\p{...}` unicode property escapes (514 件)、v-flag (80 件)。
  named groups / lookbehind は動く

## 5. 実行モデル / テストインフラ

- **TCO (末尾呼び出し最適化) なし** — strict 専用機能、test262 24 件。
  V8 も実装を撤回した機能なので「やらない」判断もあり (方針未決)
- **Wasm 内は maxSteps が効かない** — OSR で無限ループが Wasm コンパイルされた
  場合のハングリスクは理論上残存 (Phase 38 のハングケースは compile 失敗で回避)
- ホストスタックオーバーフロー: TW は host 再帰なので深い再帰は RangeError (host)。
  VM は自前フレーム + ステップ上限。ファザでは「判定不能」扱い
- async テストの実行方式 (`$DONE`) 未対応 → **1,629 件スキップ**
  (async/await 自体は JSPI 含め動くのにカウント外)
- module 未対応 (9 件スキップ)
- **test262 ハーネス**: Phase 39 でほぼ解消 (Test262Error 本物化 / SameValue /
  regExpUtils + native buildString / isConstructor 近似 / $MAX_ITERATIONS)。
  `verifyProperty` も属性モデル実装に伴い本実装化 (Phase 39 後半)。
  残り: `$262` (createRealm 等 20 件) は未対応。isConstructor は
  Reflect.construct 不在のため new 近似で本家と結果が異なるケースあり

## 5b. §5b の課題 — Phase 39 (roadmap #7) で解決

- ~~`e.constructor === Ctor` が false~~ → 解決。fn/class の prototype.constructor に
  自身を non-enumerable で紐付け (identity 込み、継承先も自身を指す)
- ~~TW: 文字列の for-of が不可~~ → 解決 (サロゲート対応の code point 反復を追加)
- ~~String.fromCodePoint が無い~~ → 両エンジンに追加。fromCharCode も 16bit マスク
- **残る既知: JSString の length/charAt がバイト単位** — createSeqString が
  TextEncoder (UTF-8) で length を数えるため、非 ASCII で `.length` が
  UTF-16 code unit とずれる (😀 → 4、正しくは 2)。charAt/slice/index が
  すべて byte 前提の設計上の割り切りで、UTF-16 化は文字列処理の全面改修。
  ASCII のみのプログラムでは顕在化しないため後回し

## 6. 品質保証の穴 (差分ファザの検出網)

- ~~generator が class/label/getter-setter/spread を生成しない~~ → **Phase 39 で解決**。
  拡張で VM バグ 8 種を発見・修正 (getter throw の catch 不達 / 非リテラル field /
  closure 化 class の prototype・super / インスタンス比較の toPrimitive など)。
  527→4 件に収束 (残りは評価順/logs 件数差のノイズ)。
  **スコープ規律の教訓**: 生成器で class/fn/let を「実行が保証されない文脈」
  (switch case / ループ本体 / labeled block) から後続参照可能にすると、
  未定義参照プログラムを量産してノイズになる。guaranteed フラグで抑止
- `--oracle node` 未実装 → 「3 エンジン揃って間違う」系は検出不能のまま
- 残る差分ファザの 4 件: 評価順 (throw 直前の console.log が実行されるか) と
  logs 件数差。完了値・エラー型は 3 エンジン一致で実害は小さい

## 効果順の推奨ロードマップ

| # | 施策 | 期待効果 |
|---|---|---|
| 1 | ~~VM に class 継承 (extends/super) を実装~~ | **Phase 39 で完了** (3 エンジン一致)。class 系の残件は private #/async メソッドパース/属性モデル |
| 2 | ~~プロパティ属性モデル + accessor descriptor~~ | **Phase 39 で完了** (accessor 271 件解消、verifyProperty 本実装で基準正直化) |
| 3 | ~~spread call / object spread の VM 実装~~ | **Phase 39 で完了** (「黙って null」根絶) |
| 4 | ~~test262 ハーネス注入の充実~~ | **Phase 39 で完了** (3 モード +5pt) |
| 5 | ~~パーサ strict early error (eval/arguments)~~ | **Phase 39 で完了** (SyntaxError 系 83→70、残は class 内 eval 意味論) |
| 6 | ~~fuzzer generator に class/label/spread 追加~~ | **Phase 39 で完了** (拡張で VM バグ 8 種発見・修正、527→4 件収束) |
| 7 | ~~constructor 追跡 + TW 文字列 for-of / fromCharCode~~ | **Phase 39 で完了**。残: JSString の非 ASCII length (UTF-8 byte 単位) |

---

# Part 2: 差分ファザの収束履歴と教訓

## 収束の履歴

| 時点 | divergence |
|------|-----------|
| Phase 35 開始 | 903 / 5000 |
| Phase 35 完了 (PR #35) | 6 / 10000 |
| Phase 36-6 完了 | **0 / 100000** (5 seed × 20000) |

## Phase 36〜38 で解決済み

- **JIT tagged slots の boolean** → 36-5 で TAG_FALSE/TAG_TRUE を追加
- **switch case 内 function 宣言が TW で不可視** → 36-1
- **TW の host 配列メソッドが JSString を壊す** → TW_ARRAY_OVERRIDES
- **メンバ代入 `obj.p = rhs` の評価順** → 36-1 (単純/複合とも obj 先)
- **const 閉包の巻き上げ順** → 36-1
- **`"5" == 5`** → 36-3 で ToNumber 段を追加
- **ユーザー定義 valueOf/toString** → 36-4
- **TW の `+=` が host string を生む** → 36-4
- **TDZ (Temporal Dead Zone)** → 36-6 で実行時 TDZ (専用オペコード、ホットパス無変更)
- **プリミティブへのプロパティ代入** → 36-6 で TypeError に統一 (intern 汚染の根治)
- **TDZ とエラー優先順位** → 36-6 (TDZ > const-immutable、RHS 評価 > 書込)
- **メソッド呼び出しの評価順** → 36-6 (obj を引数より先)
- **計算で生まれる -0 / 渡された -0** → Phase 37 (f64 昇格 + copy-in deopt)。
  strength-reduce の -0 非健全変換 (x*0→0, x+0→x) も f64 関数で抑止
- **ラベル付き break/continue** → Phase 38。ラベル付き非ループ文への break が
  未パッチ Jump 0 でプログラム先頭に飛び無限ループ / switch 内 continue も同様 /
  for-in は loopStack エントリ自体が無かった。test262 JIT ランのハング原因

## 教訓 (詳細は各 LEARN-Phase*.md)

- **intern 汚染** (36-6 の目玉): `"a".x = 5` を TW が黙って intern 共有 JSString に
  書き込み、後続の差分実行に状態が漏れて偽発散を大量生成していた。
  共有可変状態を持つ処理系の差分ファジングでは、1 発散を必ず `--repro <gen>` で
  単独再現し「単独では一致・連続実行で発散」なら状態リークを疑うこと
- **検出網は generator の語彙まで**: ファザが 0 収束でも、generator が生成しない
  構文 (class/label) には 1,400 件分の TW↔VM 差分が眠っていた
- **未パッチ Jump 0 は「先頭へ飛ぶ」**: ジャンプ先未解決の break/continue は
  no-op ではなく最悪の無限ループになる。ターゲット解決を emit より先に
- **minimize は不忠実なことがある**: cluster ファイルでなく gen seed から再現する

## TDZ 実装の範囲 (36-6)

実行時 TDZ は block / switch / 関数本体直下の let/const と、それらを閉包
キャプチャする upvalue read/write をカバー (LdaLocalTDZ / StaLocalTDZ /
LdaUpvalueTDZ / StaUpvalueTDZ / StaHole / CheckTDZ)。

- **for-init の let/const は TDZ 対象外** (宣言が本体より先に走るため実害ほぼ無し)
- **JIT は TDZ チェックを省略**: 穴を踏むコードは throw して tier-up しないため
  cold パス = VM 解釈で正しく効く。ホットパスの LdaLocal/StaLocal は無変更

## 検証方法

```bash
npm run fuzz -- --iterations 20000 --seed 111 --isolate   # 収束確認 (0 期待)
npm run fuzz -- --repro <gen seed>                        # 1 件の詳細 (単独再現)
npm run test262 [-- --vm|--jit]                           # 3 モード比較
npx tsx --test src/vm/strict-semantics.test.ts            # 回帰テスト
```

修正の際は「正 = node (strict)」で確認し、TW/VM/JIT の 3 エンジンを同時に
直して収束させること (片方だけ直すと divergence が増える)。
