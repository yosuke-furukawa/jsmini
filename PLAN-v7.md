# PLAN v7 — Octane 主導の実行基盤強化

## 動機

Phase 29 までで jsmini は「マイクロベンチと数値カーネル」を制覇した:
SunSpider 6/8 完走、配列 JIT (引数/固定/push/添字成長)、Math JIT、
数値ループで VM 比 44〜数百x。ユニットテスト 935、test262 53.1%。

しかし RESEARCH-Octane の smoke test で現実が見えた: **実アプリ型の
中規模ワークロード (Octane) は 4 本中 3.75 本が動かない**。

| ベンチ | 現状 | 原因 (jsmini 側) |
|---|---|---|
| richards | TW/VM とも無限ループ | 未特定 (B1) |
| deltablue | 両モード ERR | 関数のプロト解決 + defineProperty (B3) |
| splay | 両モード ERR | 関数への static プロパティ (B2) |
| navier-stokes | TW のみ OK | VM の upvalue 解決 (B4) |

SunSpider (関数単位のマイクロ) では踏まなかった「素の prototype OO
パターン」「名前空間パターン」「深いクロージャ共有」で穴が露呈した。
**v7 のテーマは、この実アプリ型パターンをベンチに教えてもらいながら
互換性と実行基盤 (object / closure / GC) を鍛えること**。

## 方向性 — 3 つの柱

### P1: Octane 互換 (まず 4 本を全モードで完走させる)

ブロッカー B1〜B4 の修正が本体。ベンチ導入は「ファイルを置く」ことでは
なく「動かない原因を潰す」こと。Phase 29 の経験則 (1 つの現象 = 複数の
独立バグ) を前提に、二分探索 + 最小再現 + TW/VM 突き合わせで進める。

修正対象はどれも言語コアの信頼性に直結する:
- B2 (関数への static プロパティ) — 名前空間パターンは実世界コードの頻出形
- B3 (関数オブジェクトのプロトタイプチェーン) — jsmini の「関数 = host
  オブジェクト」と「jsmini オブジェクト」の境界問題。Phase 27/28 の
  host 境界シリーズの続き
- B4 (VM upvalue) — クロージャ実装の残バグ。JIT の upvalue 渡しにも波及
- B1 (richards 無限ループ) — 原因未特定。semantics バグの可能性が高く
  最優先で切り分ける価値がある

### P2: Octane 性能 (object JIT / GC を数字で鍛える)

4 本が完走したら、Octane が新しい性能テーマを教えてくれる:

| ベンチ | 試されるもの | 現状の JIT の穴 |
|---|---|---|
| richards / deltablue | **OO ホットパス**: メソッド呼び出し、HC/IC、polymorphic 呼び出し | JIT は数値 leaf 関数 + 配列中心。メソッド間呼び出し・複数関数の同時 JIT は弱い |
| splay | **GC**: 大量の短命/長命オブジェクト | mark-sweep のみ。世代別なし。GC pause がスコアに直結 |
| navier-stokes | **数値配列** | Phase 29 の配列 JIT がそのまま効くはず — 検証の場 |

ここは「まず計測 → 一番大きい穴から」。事前に決め打ちしない。

### P3: 計測基盤の負債返済 (test262 ブースト)

RESEARCH-Phase30 で判明した「実装済みなのに測れていない」領域:
- **async テスト 1,629 件が runner の都合で skip** — `$DONE`
  (doneprintHandle) 対応で解放。Promise/async は実装済み
- harness 不足: `buildString` (fail 445 件に直結) / `isConstructor` / `$262`
- 目標: 53% → 60%+

P1/P2 と独立して進められるので、Octane の切り分けが詰まったときの
並行タスクとしても使える。

### P4 (v7 スコープ外、次の候補)

- accessor descriptor (getter/setter) — 言語最後の大物。Proxy/Reflect の前提
- 自前 RegExp NFA (Stage B) — 教育大玉
- Typed Arrays → Octane zlib
- crypto / raytrace の Octane 追加 (raytrace は arguments/apply の完成度が試される)

## ステップ案

### Phase 30: Octane 互換 (P1)

- bench/octane/ に 4 本 (最小加工: 登録ブロック除去 + 実行呼び出し。
  deltablue の alert → throw、splay の performance.now → Date.now stub)
- src/octane-bench.ts (TW/VM/JIT wall-time 直測。base.js スコアは不要)
- B2 → B3 → B4 → B1 の順で修正 (再現が明確な順)
- 完了条件: **4 本 × 3 モードすべて完走 + 結果検証パス**

### Phase 31: Octane 性能 (P2)

- 4 本のプロファイル → 弱点ランキング作成
- 上位から着手 (見込み: メソッド呼び出しの JIT / polymorphic IC /
  splay の GC チューニング)
- 完了条件: 各ベンチで VM 比の JIT 効果を計測・記録

### Phase 32: test262 ブースト (P3)

- async runner ($DONE) + buildString / isConstructor / $262
- pre/post 計測 (目標 60%+)

## 期待される効果

| Phase | 効果 |
|---|---|
| 30 | Octane 4 本完走。言語コア (関数オブジェクト/クロージャ/semantics) の信頼性向上。実世界パターンの互換性 |
| 31 | object JIT / GC の弱点が数字で見える。次の最適化テーマが Octane から供給される |
| 32 | test262 53% → 60%+。async 1,629 件の解放 |

## 方針 (v6 から継承 + v7 追加)

- 各 Phase は小さく保つ。TODO → ブランチ → draft PR → 全完了 → レビュー
- **1 つの現象 = 複数の独立バグ前提**で二分探索・最小再現を作る (Phase 29 の教訓)
- 修正は必ず TW/VM 両モードで確認 (片方だけ直すと差分バグになる)
- host 境界 (関数オブジェクト・Object.prototype 汚染) は snapshot/restore
  や明示ガードで安全側に倒す
- ベンチファイルの加工は最小限にして git diff で追跡可能にする
- 教育的価値: 「なぜ V8 はこうしているか」を LEARN に対応づけて記録する
