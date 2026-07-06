# TODO Phase 30 — Octane 互換 (PLAN-v7 P1)

## 動機

RESEARCH-Octane の smoke test で、Octane 候補 4 本のうち完走するのは
navier-stokes の TW のみと判明。原因はすべて jsmini 側のバグ/未対応機能
(B1〜B4)。これらを潰して **4 本 × TW/VM/JIT の全モード完走** を目指す。

ベンチが炙り出した穴はどれも言語コアの信頼性に直結する:
関数オブジェクトのプロパティ/プロトタイプ、クロージャの upvalue、
そして richards の無限ループ (semantics バグの疑い)。

## 完了条件

richards / deltablue / splay / navier-stokes が TW/VM/JIT すべてで
完走し、各ベンチ内蔵の結果検証 (expected checksum 等) をパスすること。

## ステップ

### 30-1: ベンチ整備

- [x] 30-1a: `bench/octane/` に 4 本を配置 (chromium/octane から取得、
      最小加工: BenchmarkSuite 登録ブロック除去 + 末尾に実行呼び出し追記)
- [x] 30-1b: deltablue の `alert(...)` → throw 化、splay の
      `performance.now` → Date.now stub を preamble 注入
- [x] 30-1c: `src/octane-bench.ts` — TW/VM/JIT の wall-time 直測
      (sunspider-bench.ts と同形式)

### 30-2: B2 — 関数オブジェクトへの static プロパティ (splay 解放)

最小再現: `function T(){} T.Node = function(k){this.k=k}; new T.Node(5)`
→ TW: undefined is not a function / VM: Not a function

- [x] 30-2a: TW/VM それぞれの原因特定 (代入が落ちるのか、読み出しが
      落ちるのか、new の callee 解決か)
- [x] 30-2b: 修正 + 最小再現の回帰テスト (TW/VM 両方)

### 30-3: B3 — 関数のプロトタイプチェーン + defineProperty (deltablue 解放)

最小再現: `Object.defineProperty(Object.prototype, "inh", {value: fn});
function C(){} C.inh()` → TW: undefined is not a function /
VM: 内部エラー (reading 'properties')

- [x] 30-3a: 関数オブジェクトのプロパティ解決が Object.prototype まで
      届くようにする (TW/VM)
- [x] 30-3b: VM ObjectWrapper.defineProperty が host plain object 以外で
      内部エラーになる件の修正
- [x] 30-3c: 回帰テスト + bench 実行間の Object.prototype 汚染ガード確認

### 30-4: B4 — VM の upvalue 解決 (navier-stokes 解放)

TW は 3.2s で完走、VM だけ `dens_prev is not defined`。単純な兄弟
クロージャ 2 つの再現は通るので、より深いパターンが条件。

- [x] 30-4a: navier-stokes を削って最小再現を特定 (二分探索)
- [x] 30-4b: 修正 + 回帰テスト
- [x] 30-4c: JIT モード (upvalue 渡し) への波及確認

### 30-5: B1 — richards 無限ループ

TW/VM 両方で 2 分+ 回り続ける。原因未特定。

- [x] 30-5a: 関数単位で切り出して VM/host の結果突き合わせ (Phase 29 の
      spectral-norm 方式)。scheduler の状態遷移・switch・ビット演算・
      連結リストが容疑者
- [x] 30-5b: 特定したバグの修正 + 回帰テスト (複数バグの可能性を前提に)

### 30-6: 計測と棚卸し

- [x] 30-6a: 4 本 × 3 モードの wall-time 計測、結果検証パス確認
- [x] 30-6b: JIT が刺さっていない箇所の棚卸し (Phase 31 = Octane 性能の
      入力データにする)

### 30-7: まとめ

- [x] 30-7a: LEARN-Phase30.md (Octane が炙り出した穴と V8 対応)
- [x] 30-7b: PR を Ready for review に

## 技術メモ

### 関数オブジェクトの二重性 (B2/B3 の背景)

jsmini の関数は TW では JSFunction (brand 付き plain object)、VM では
BytecodeFunction / closure オブジェクト。どちらも「プロパティを持つ
オブジェクト」としての振る舞い (static プロパティ、Object.prototype
継承) が未整備。V8 では関数も普通の JSObject (map を持つ) であり、
`T.Node = fn` は通常のプロパティ store。jsmini でどう表現するかが論点:
- 案 A: 関数オブジェクトに properties マップを持たせ、GetProperty/
  SetPropertyAssign の対象として扱う
- 案 B: host オブジェクトとしての性質を使う (関数は host object なので
  直接プロパティを付ける) — VM の GetProperty 経路に fallback 追加

### richards の構造 (B1 の切り分け用)

Scheduler (連結リスト + currentTcb) / TaskControlBlock (state ビット演算
+ run) / 各 Task (Idle/Worker/Device/Handler)。`while (this.currentTcb !=
null)` が終わらない = どこかで release/holdCurrent/suspendCurrent の
戻り値 or state 遷移が host と食い違っている。関数単位で host JS と
突き合わせるハーネスを書くのが早い。

### ベンチ加工の方針

- 加工は「登録ブロック除去 + 実行呼び出し + 環境 stub」のみ。
  ロジックには触れない (git diff で追跡)
- 検証はベンチ内蔵の expected 値 (richards の queueCount/holdCount、
  navier-stokes の checksum、deltablue の projection 検証) をそのまま使う

## 結果 (完了時追記)

12 セル全完走。実際に修正したのは 5 バグ (詳細 LEARN-Phase30):
1. B2 = parser (`new T.Node()` の member チェーン)
2. B1 = VM compiler の member ++/-- silent no-emit (richards 無限ループの真因)
3. deltablue 追加発見: オブジェクト同士の `==` が ToPrimitive で true
4. B4 = VM compiler の var hoisting 欠落
5. JIT: this の非数値スロット 0 化 (JIT 3 本の共通真因)

| ベンチ | TW | VM | JIT |
|---|---|---|---|
| richards | 201ms | 122ms | 128ms |
| deltablue | 192ms | 164ms | 192ms |
| splay | 2765ms | 2549ms | 2663ms |
| navier-stokes | 3313ms | 2165ms | 2308ms |

JIT ≈ VM (性能はまだ)。棚卸し結果と Phase 31 テーマは LEARN-Phase30 参照。
