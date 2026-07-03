# RESEARCH-Octane — Octane 導入の事前調査

Phase 30 (Octane 導入) の事前 RESEARCH。実ソースを取得して静的分析 +
jsmini での smoke test を実施した。結論: **候補 4 本のうち現状動くのは
navier-stokes の TW のみ。4 種の新しいバグ/未対応機能が判明**しており、
これらを潰すこと自体が Phase 30 の本体になる (= まさにベンチ主導開発)。

## 1. Octane とは

- Google の JS ベンチスイート (2012-2017、17 本)。SunSpider (マイクロ) と
  違い**実アプリ由来の中規模ワークロード**が中心
- ソース: github.com/chromium/octane (1 ファイル 1 ベンチ + base.js)
- ハーネス: `base.js` の `BenchmarkSuite`。スコア = 基準時間との比の
  geometric mean。**jsmini 用途 (TW/VM/JIT の相対比較) にはハーネス不要**で、
  SunSpider と同じく登録ブロックを剥がして workload を直接呼べばよい

## 2. 候補ベンチの静的分析

初期導入候補 (OO / GC / 数値の 3 軸 + サイズが手頃):

| ベンチ | 行数 | 内容 | 使う機能 (グレップ結果) |
|---|---|---|---|
| richards | 539 | OS タスクスケジューラ (OO 古典) | prototype メソッドのみ。環境依存ゼロ |
| deltablue | 883 | 制約ソルバ (OO 古典) | `Object.defineProperty(Object.prototype, "inheritsFrom", {value})` + 関数からの参照。alert (失敗時のみ) |
| splay | 423 | スプレー木 (**GC ストレス**) | `SplayTree.Node = function` (関数への static プロパティ)、Math.random、performance.now (stub 可) |
| navier-stokes | 415 | 流体シミュレーション (数値・配列) | `new Array(size)` 数値配列 + 兄弟クロージャの upvalue 共有。環境依存ゼロ |

次点: crypto (1698 行、BigInteger 演算)、raytrace (904 行、`Class.create` +
`initialize.apply(this, arguments)` — arguments/apply が試される)。
regexp/code-load/typescript/zlib (TypedArray 前提) は後回し。

## 3. smoke test 結果 (2026-07-03、登録ブロックのみ剥がした standalone)

| ベンチ | TW | VM | JIT |
|---|---|---|---|
| richards | ❌ **無限ループ** (2分+ タイムアウト) | ❌ 無限ループ | — |
| deltablue | ❌ undefined is not a function | ❌ 内部エラー (reading 'properties') | — |
| splay | ❌ undefined is not a function | ❌ Not a function | — |
| navier-stokes | ✅ **OK 3.2s** | ❌ dens_prev is not defined | ❌ 同左 |

**V8 なら全部数十 ms で終わる**。つまり 4 本中 3.75 本がブロックされており、
その原因はベンチ側でなく jsmini のバグ/未対応機能。

## 4. 判明したブロッカー 4 種 (最小再現つき)

### B1. richards: 無限ループ (原因未特定)

TW/VM 両方で 2 分以上回り続ける (100% CPU)。richards は
`while (this.currentTcb != null)` + switch + ビット演算 (`state & MASK`) +
連結リストの組み合わせ。状態遷移のどこかが jsmini の semantics バグで
進まなくなっている。**Phase 30 で二分探索が必要** (Phase 29 の spectral-norm
49.27 と同じ進め方: 関数単位で切り出して VM/host の結果を突き合わせる)。

### B2. 関数オブジェクトへの static プロパティ (splay ブロッカー)

```js
function T() {}
T.Node = function(k) { this.k = k; };
new T.Node(5);            // TW: undefined is not a function / VM: Not a function
```

`SplayTree.Node = function` の名前空間パターン。関数オブジェクトへの
プロパティ代入 or その読み出し (`new` の callee としての MemberExpression
解決) が TW/VM 両方で壊れている。

### B3. defineProperty(Object.prototype) + 関数からの参照 (deltablue ブロッカー)

```js
Object.defineProperty(Object.prototype, "inh", { value: function(){ return 42; } });
function C() {}
C.inh();                  // TW: undefined is not a function / VM: 内部エラー
```

deltablue の `Constraint.inheritsFrom(...)` パターン。2 つの問題が絡む:
(a) jsmini の関数オブジェクトのプロパティ解決が Object.prototype (host)
まで届かない、(b) VM の ObjectWrapper.defineProperty が host plain object
以外を渡されると内部エラー (`reading 'properties'`)。

### B4. VM の upvalue 解決 (navier-stokes ブロッカー、TW は通る)

FluidField 内の `var dens_prev` を多数の兄弟クロージャ (`this.reset` /
`this.update` / 内部関数群) が共有するパターンで、VM だけ
`dens_prev is not defined`。単純な 2 兄弟クロージャの最小再現
(`this.reset`/`this.update`) は**通る**ので、より深い形
(クロージャから呼ばれる内部関数経由の参照など) が条件。要二分探索。

## 5. 導入方式の提案

- `bench/octane/` に richards / deltablue / splay / navier-stokes を配置
  (SunSpider と同じ方式: 登録ブロック削除 + 実行呼び出し追記の最小加工、
  差分は git で追跡可能)
- `src/octane-bench.ts` で TW/VM/JIT の wall-time を直測 (base.js の
  スコア換算は不要。エンジン内比較が目的)
- deltablue の `alert` → throw に置換、splay の `performance.now` →
  `Date.now` stub を preamble で注入

## 6. Phase 30 スコープ案

```
30-1  bench/octane/ + octane-bench.ts 整備 (4 本、最小加工)
30-2  B2: 関数オブジェクトの static プロパティ (splay 解放)     — TW/VM
30-3  B3: defineProperty(Object.prototype) + 関数のプロト解決     — TW/VM
30-4  B4: VM upvalue 解決バグ (navier-stokes 解放)               — VM
30-5  B1: richards 無限ループの二分探索・修正                     — TW/VM
30-6  4 本の TW/VM/JIT 計測 → JIT が刺さらない箇所の棚卸し
      (OO ホットパス / GC ストレス / 数値配列それぞれで)
30-7  LEARN-Phase30 (Octane が炙り出した jsmini の穴)
```

期待効果: Phase 29 の配列 JIT が navier-stokes で試せる。richards/deltablue
で object JIT (HC/IC/メソッド呼び出し) の弱点が数字で見える。splay で GC の
挙動 (若い世代なし mark-sweep) が問われる。

## 7. リスク・メモ

- richards の無限ループは原因不明なので工数が読めない (最悪 switch や
  ビット演算の深いバグ)。ただし Phase 29 の経験則では「1 つの現象 = 複数の
  独立バグ」なので、切り分け自体に価値がある
- deltablue の `defineProperty(Object.prototype, ...)` は host Object.prototype
  汚染の懸念 (Phase 27 の snapshot/restore と同じ系統)。bench 実行間の分離を
  意識する
- crypto / raytrace は 4 本が動いてから追加検討 (raytrace は
  `initialize.apply(this, arguments)` で arguments オブジェクトの完成度が試される)
