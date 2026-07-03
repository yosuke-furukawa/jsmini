# RESEARCH-Phase30 — 現在地の棚卸しと次にやるべきこと

Phase 29 完了時点 (PR #29 マージ済み) のスナップショットと、
次フェーズ候補の評価。PLAN-v6 の残り + 各 LEARN で積み残した課題を集約する。

---

## 1. 現在地スナップショット

### 実装済み機能 (Phase 1〜29)

| レイヤ | 実装済み |
|---|---|
| 言語 | 式/文/関数/クロージャ/クラス/prototype/デストラクチャ/テンプレートリテラル/generator/async-await/try-catch/for-in/for-of/スプレッド/オプショナルチェーン/指数表記/regex リテラル/文字列行継続 |
| Built-in | Object メタ (defineProperty※data のみ)/Math 全域/Date/JSON/Promise (withResolvers 含む)/Map/Set/WeakMap/WeakSet/RegExp (host 丸投げ)/String・Array prototype 一式/Symbol (自前) |
| TW | Environment ベース。host 直結 (Array=host Array 等) |
| VM | stack マシン + HiddenClass + IC + interned string (Seq/Cons/Sliced) + GC (mark-sweep) + iterator protocol |
| JIT | bytecode→直接 Wasm と IR (SSA) 経由の 2 パス。LICM/CSE/SR/Range 分析/inlining/OSR/deopt。Math native+host import。**配列 JIT (引数/new Array(n)/[]+push/a[i]= 成長)**。JSPI (await)。深再帰は RangeError catch→deopt |
| インフラ | test262 runner (prototype snapshot/restore 付き)/SunSpider 8本/playground (プリセット20種) |

### 品質・性能の現在値

- ユニットテスト: **935 pass / 0 fail**
- test262 (VM): **6,612 / 14,573 pass (53.1% excl. skip)**、TW 6,601
  - skip 2,114 = **async 1,629** / noStrict 473 / module 9
  - fail ホットスポット: built-ins/RegExp 1,237、String/prototype ~240、
    Promise ~217、Set 153、Map 77 (`buildString is not defined` だけで 445)
- SunSpider: **6/8 完走** (math-cordic/spectral-norm/partial-sums/regexp-dna/
  string-tagcloud/string-validate-input)。残り date-format 2 本は sloppy global
- JIT 効果: 数値ループ 数十〜数百x、配列カーネル VM比 44〜59x、
  Math.sqrt native 610x (JITless)
- FlatVM (Uint8Array bytecode): **28/41 タスクで中断中**

---

## 2. ギャップの棚卸し (LEARN/TODO からの積み残し)

### A. test262 系 (計測可能な伸び代)

| ギャップ | 影響 | 出所 |
|---|---|---|
| **async テストを runner が skip** | **1,629 テストが未計測**。Promise/async は実装済みなので runner の `$DONE` (doneprintHandle) 対応だけで解放できる可能性大 | runner.ts:224 |
| **harness 関数不足**: `buildString`/`compareArray` 拡充/`isConstructor`/`$262` | buildString 起因だけで fail 445 | LEARN-Phase28 |
| **verifyProperty が no-op stub** | 属性検証テスト全滅。完全化には accessor descriptor が前提 | LEARN-Phase25 |
| **accessor descriptor (get/set) 未対応** | `Object.defineProperty(o, k, {get})` が throw。オブジェクトリテラルの `get x(){}` も不可 | evaluator.ts / vm/index.ts |
| noStrict 473 skip | strict-only 方針とのトレードオフ | 方針判断 |

### B. 言語・Built-in 系

- **getter/setter** — 上記の通り言語レベルで未対応。Vue/リアクティブ系パターンの前提
- **sloppy global** (`for(i in x)`, `a1=a2=0`) — SunSpider date-format 2 本のブロッカー
- **Typed Arrays** (PLAN-v6 P2) — Octane zlib/Mandreel の前提。JIT の linear memory と相性◎
- **Reflect / Proxy** (PLAN-v6 P3) — 規模大
- Array メソッド残り (pop/splice/shift の JIT、sort 安定性は対応済)

### C. JIT / 性能系

- **文字列を Wasm で扱う** (interned id は部分対応。concat/比較のループは VM 止まり)
- **Map/Set 操作の JIT** (Phase 27 で「hot loop で出たら」と保留)
- **tagged elements** (object 入り配列は VM フォールバック。V8 の PACKED_ELEMENTS 相当は未対応)
- **自前 RegExp NFA (Stage B)** — LEARN-Phase28 に設計スケッチ済 (~500 行)。教育的本丸
- **Wasm 自前 hash table** — LEARN-Phase27 の構想 (B 案)
- FlatVM 再開 (dispatch 高速化の実験)

### D. ベンチスイート

- **Octane 未導入** — richards/deltablue (OO コード → HC/IC/object JIT が試される)、
  splay (GC ストレス)、zlib (TypedArray 前提)
- SunSpider 完全制覇には sloppy global が必要

---

## 3. 次フェーズ候補の評価

| 候補 | 効果 | 規模 | 教育的価値 | 備考 |
|---|---|---|---|---|
| **①test262 ブースト** (async runner + buildString/isConstructor/$262) | ★★★ (+500〜1000 pass 期待。async 1,629 の解放が最大) | 中 | ★★ (テストハーネスの仕組み) | 実装済み機能が「計測されていない」だけの状態を解消。ROI 最大 |
| **②accessor descriptor (get/set)** | ★★★ (verifyProperty 完全化→test262 広範囲、言語の残穴) | 中 | ★★★ (HiddenClass に accessor をどう載せるか = V8 の AccessorPair) | ①の verifyProperty と直結 |
| **③Octane 導入** (richards/deltablue/splay) | ★★ (新ベンチ軸。object JIT の弱点が見える) | 中 | ★★★ (OO ホットパス・GC ストレスの実地) | sloppy 依存の確認が必要 |
| **④自前 RegExp NFA (Stage B)** | ★ (通過率はむしろ下がるリスク) | 中〜大 | ★★★★ (エンジン教育の本丸。Thompson 構築→simulation) | 成果物の分かりやすさは最強 |
| **⑤Typed Arrays** | ★★ (Octane zlib への道) | 大 | ★★ (ArrayBuffer/view の設計) | ③の後が自然 |
| **⑥sloppy global 限定対応** | ★ (SunSpider 2 本 + noStrict の一部) | 小〜中 | ★ | strict-only 方針の再考が必要 |
| **⑦Proxy/Reflect** | ★★ (test262 + メタプロ) | 大 | ★★ | ②の後が自然 (property model 共通) |
| **⑧FlatVM 再開** | ★ (VM dispatch 高速化) | 中 | ★★ | JIT が既に速く優先度低下 |

---

## 4. 推奨ロードマップ

```
Phase 30: test262 ブースト             ← 「実装済みなのに測れていない」を解消
  30-1  async runner 対応 ($DONE / doneprintHandle、drainMicrotasks 待ち)
  30-2  harness: buildString (regExpUtils.js 相当) / isConstructor / $262 最小実装
  30-3  pre/post 計測 (目標: 53% → 60%+)

Phase 31: accessor descriptor (getter/setter)
  - オブジェクトリテラル get/set 構文 (Lexer/Parser)
  - HiddenClass に accessor slot (V8 の AccessorPair 方式) — TW/VM 両方
  - Object.defineProperty の get/set 対応 → verifyProperty 完全実装
  - test262 再計測 (属性検証テストの解放)

Phase 32: Octane 導入 → object JIT 強化
  - richards / deltablue / splay を bench/octane/ に導入
  - プロファイル → polymorphic IC / メソッド呼び出し JIT / GC の弱点特定

Phase 33+: 教育大玉・大型機能 (順不同)
  - 自前 RegExp NFA (Stage B)     — regexp-dna で host RegExp と性能比較
  - Typed Arrays → Octane zlib
  - Proxy / Reflect
  - 文字列 JIT / Wasm hash table
```

### 推奨理由

1. **Phase 30 が ROI 最大**: async/await・Promise は Phase 20-24 で実装済みなのに
   1,629 テストが「runner の都合で」未計測。buildString 445 も同様。
   コードでなく計測系の負債を返すだけで通過率が大きく動く
2. **Phase 31 は機能の残穴かつ次への布石**: getter/setter は言語として不完全な
   最後の大物。verifyProperty (30 の続き)、Proxy (33+)、リアクティブ系パターン
   すべての前提になる。HiddenClass への accessor 統合は V8 の設計を追体験できる
3. **Phase 32 で「ベンチ主導」の軸を SunSpider → Octane に更新**: 数値・配列は
   Phase 29 でやり切った。次の性能テーマ (OO ホットパス、GC) は Octane が教えてくれる
4. ④自前 NFA は教育的に最強だが、成果が通過率・ベンチに直結しないので、
   計測基盤 (30) とベンチ軸 (32) を整えてから腰を据えてやるのが得策
