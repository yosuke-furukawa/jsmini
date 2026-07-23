# PROBLEMS.md — 既知の未解決問題

jsmini の「できていないこと」の台帳。正しさの基準は **node (strict mode)**。
前半は現状の欠落の全体地図 (2026-07-23 調査)、後半は差分ファザの収束履歴と教訓。

## 現状サマリ (2026-07-23, Phase 38 時点)

- test262: **TW 53.8% / VM 54.5% / JIT 54.3%** (12,459 件実行、noStrict 等 2,114 件スキップ)
- 内部テスト 1,176 全パス / 差分ファザ **0 / 100,000** で収束維持
- ただし TW↔VM には test262 で **TW だけ失敗 755 件 / VM だけ失敗 672 件**の非対称が残る
  (ファザの generator が class/label 等を生成しないため未検出だった領域)

---

# Part 1: できていないことの全体地図

## 1. VM が TW に追いついていない機能 (エンジン間非対称) — 最優先級

直接プローブで確認した現状 (✅=動く / ❌=壊れている):

| 機能 | TW | VM |
|---|---|---|
| `class B extends A {}` | ✅ | ❌ "Not a function" |
| `super()` | ✅ | ❌ "__super__ is not defined" |
| `super.m()` (メソッド) | ❌ | ❌ (両方壊れているが別の壊れ方) |
| `f(...args)` spread 呼び出し | ✅ | ❌ ExecStmt fallback 未実装 |
| `{...obj}` object spread | ✅ | ❌ **黙って null を返す** (エラーですらない) |
| class computed key `[String(fn)]` | ❌ キー正規化ブレ | ✅ |

- **class 継承一式が VM で全滅** — test262 statements/class 系 1,611 件失敗の主因
- object spread の「黙って null」は静かに間違う系で特に危険
- TW の class computed key は「メソッド定義時」と「アクセス時」のキー文字列化が
  不一致 (`c[String(() => {})]()` が TW だけ失敗)。host 値と JSString/JSObject が
  混在する TW アーキテクチャの境界変換ブレが原因

## 2. 両エンジン共通の欠落: オブジェクトモデル

- **プロパティ属性 (writable/enumerable/configurable) が飾り**:
  `Object.freeze` / `Object.defineProperty` は関数として存在するが実効性がなく、
  `writable: false` でも普通に書けてしまう (strict なら TypeError のはず)。
  test262 "Expected a TypeError" **220 件**の根
- **accessor descriptor 未対応**: `defineProperty(o, "x", { get })` が
  "accessor descriptors not yet supported" → **268 件**
  (オブジェクトリテラルの `get x(){}` は動く)
- **`.constructor` の host 境界差**: `[1,2].constructor` が TW=host Array /
  VM=jsmini Object (null prototype)。収束には両エンジンで独自 Array/Number
  コンストラクタ + prototype チェーンの一貫モデル化が必要 (大規模)。
  既知確定発散なので差分ファザの generator からは `.constructor` を除外済み

## 3. パーサ未対応構文

- `new.target` (パース不可)
- class private の一部ポジション: 単純な `#x = 1` フィールドは動くが、
  `#m()` メソッド / `static #x` / `#x in obj` で "Unexpected character '#'"
- `for ([a, b] of ...)` — 分割代入 LHS の for-of ("Expected Semicolon but got Of")
- **strict early error 不在**: `var eval` / 仮引数 `arguments` / `catch (eval)` 等が
  SyntaxError にならない (onlyStrict 失敗 14 件 + "Expected a SyntaxError" 55 件)。
  未定義ラベルへの break/continue も未検出 (現在は no-op)

## 4. ビルトイン不在・部分実装

- **完全不在**: `Proxy` / `Reflect` / `BigInt`
- `class E extends Error` が両エンジンとも不正 (TW は例外、VM は message 消失)
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
- **test262 ハーネス未注入**: `buildString` / `testExtendedCharacterClass` /
  `isConstructor` / `$MAX_ITERATIONS` が無く、`verifyProperty` は空実装
  → **~600 件は機能が実装済みでも落ちる** (最もコスパの良い改善)

## 6. 品質保証の穴 (差分ファザの検出網)

- generator が **class / label / getter-setter / spread を生成しない**
  → §1 の TW↔VM 差分 (755+672 件分の挙動差) が全部すり抜けた実績。
  Phase 38 のラベルバグ (VM だけ無限ループ 3 種) も test262 で初検出だった
- `--oracle node` 未実装 → 「3 エンジン揃って間違う」系は検出不能のまま

## 効果順の推奨ロードマップ

| # | 施策 | 期待効果 |
|---|---|---|
| 1 | VM に class 継承 (extends/super) を実装 | class 1,611 件の大半 + VM-only 失敗 326 件 |
| 2 | プロパティ属性モデル + accessor descriptor | 220+268 件 + onlyStrict TypeError 系。verifyProperty 本実装とセットで |
| 3 | spread call / object spread の VM 実装 | 「黙って null」の根絶 |
| 4 | test262 ハーネス注入の充実 | ~600 件を実装済み機能のまま回収、最小工数 |
| 5 | パーサ strict early error (eval/arguments) | onlyStrict 14 件 + SyntaxError 系 55 件 |
| 6 | fuzzer generator に class/label/spread 追加 | 1〜3 の修正を差分ファザで守れる検出網 |

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
