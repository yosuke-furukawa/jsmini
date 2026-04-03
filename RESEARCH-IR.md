# RESEARCH-IR.md -- JavaScript エンジンの中間表現 (IR)

主要 JavaScript エンジン (V8, JavaScriptCore, SpiderMonkey) の IR 設計を調査し、
jsmini の次フェーズ (bytecode -> IR -> Wasm) の設計に必要な知見をまとめる。

---

## 1. V8: TurboFan / Turboshaft

### 1-1. 現在のパイプライン (2024-2025)

```
JavaScript
  |
  v
Ignition (bytecode interpreter, レジスタベース)
  |  型フィードバック収集
  v
Sparkplug (baseline JIT -- テンプレート方式、最適化なし)
  |  さらに hot なコード
  v
Maglev (mid-tier optimizing JIT -- CFG + SSA)
  |  最も hot なコード
  v
TurboFan + Turboshaft (top-tier optimizing JIT)
  |
  v
Machine Code
```

V8 は 4 段階のティアリングを持つ。Sparkplug は bytecode を 1:1 で native code に変換する
テンプレート JIT。Maglev は SSA ベースの CFG IR を使う中間層。TurboFan が最上位。

### 1-2. Sea of Nodes とは何だったか

TurboFan は 2014 年頃に導入され、「Sea of Nodes」IR を採用していた。

**Sea of Nodes の特徴:**
- 基本ブロック (Basic Block) という概念を持たない
- 各ノードは 1 つの命令を表す
- エッジはデータの使用 (value use) を表す
- 制御フロー (control) と副作用 (effect) は特別なチェーンで表現
- スケジューラが最終的にノードを実行順序に並べる

**理論上の利点:**
- データ依存のみで表現するため、命令の移動が自由
- 冗長な命令の統合が自然にできる
- ループ不変式の移動が暗黙的に行われる

**実際の問題点 (V8 ブログ "Land ahoy: leaving the Sea of Nodes" より):**

1. **複雑すぎた**: effect chain と control chain の管理が難しく、微妙なバグを生みやすい。
   グラフが読みにくく、新しい最適化の実装・デバッグが困難
2. **限定的だった**: JS はほぼ全ての操作が副作用を持つため、大半のノードが effect/control
   チェーンに載る。CFG に対する利点が薄い。制御フローの導入 (lowering) が困難
3. **コンパイルが遅かった**: グラフの良い訪問順序を見つけるのが難しく、キャッシュ局所性が悪い。
   reduction フェーズの fixpoint 到達が遅い

### 1-3. Turboshaft: CFG ベースの新 IR

2022 年 4 月に導入開始。Chrome 120 (2023 年末) 以降、CPU 非依存のバックエンドフェーズは
全て Turboshaft を使用。

**Turboshaft の設計:**
- 伝統的な CFG (基本ブロック + エッジ) ベース
- 各ブロックは Operation のリストを持つ
- Operation 間のデータフローは SSA 形式
- Sea of Nodes と違い、命令の順序がブロック内で明示的

**成果:**
- コンパイル時間が Sea of Nodes の約 **半分** に短縮
- コンパイラのコードが大幅に簡潔化
- バグ調査が容易に

**現状 (2025):**
- JS バックエンド: 全て Turboshaft
- Wasm: パイプライン全体が Turboshaft
- JS フロントエンド: Maglev (別の CFG ベース IR) で置き換え中
- Builtin パイプライン: 徐々に Turboshaft に移行中

### 1-4. Maglev: 中間層の CFG + SSA

Maglev は V8 の mid-tier JIT で、TurboFan より約 10 倍速くコンパイルし、
Sparkplug より約 10 倍遅いコンパイル速度。

**特徴:**
- SSA ベースの CFG IR (Sea of Nodes ではない)
- 単一 IR (lowering 段階なし) -- シンプルさ重視
- グラフ構築時に型フィードバックを参照し、特殊化されたノードを生成
- パス数を最小限に抑えた設計

### 1-5. TurboFan/Turboshaft の最適化パス

| パス | 説明 |
|------|------|
| Inlining | 関数のインライン展開。呼び出しオーバーヘッド除去 + 後続最適化を有効化 |
| Constant Folding | 定数式のコンパイル時評価 |
| Constant Propagation | 定数値の使用箇所への伝播 |
| Dead Code Elimination | 未使用コードの除去 |
| Escape Analysis | オブジェクトがスコープ外に逃げないなら、ヒープ割り当てを除去 (Scalar Replacement) |
| Redundancy Elimination | 冗長な計算の除去 (CSE 含む) |
| Loop Peeling | ループの最初の iteration を展開 |
| Load Elimination | 冗長なメモリ読み込みの除去 |
| Store Elimination | 冗長なメモリ書き込みの除去 |
| Branch Elimination | 到達不能ブランチの除去 |
| Loop Unrolling | ループの展開 |
| Register Allocation | レジスタ割り当て (Linear Scan) |

ref: https://v8.dev/docs/turbofan, https://v8.dev/blog/leaving-the-sea-of-nodes

---

## 2. JavaScriptCore (JSC / WebKit)

### 2-1. マルチティアアーキテクチャ

```
JavaScript
  |
  v
LLInt (Low Level Interpreter -- C++ ループベース)
  |  呼び出し 6回 or ループ 100回
  v
Baseline JIT (テンプレート JIT -- bytecode 1:1 変換)
  |  呼び出し 60回 or ループ 1000回
  v
DFG JIT (Data Flow Graph -- 中間層最適化)
  |  さらに hot
  v
FTL JIT (Faster Than Light -- 最上位最適化)
  |
  v
Machine Code
```

### 2-2. DFG IR (Data Flow Graph)

DFG は JSC の中間層最適化 JIT。

**IR の構造:**
- データフローグラフ: ノード = 操作、エッジ = データの流れ
- CPS (Continuation-Passing Style) 形式で構築
- 3 つの GraphForm: `LoadStore` -> `ThreadedCPS` -> `SSA`
- DFG 層の最適化は ThreadedCPS 形式で行われる
- FTL に渡す前に SSA 形式に変換

**型推論とスペキュレーション:**
- 各 value profile から SpeculatedType (SpecType) を収集
- SpecType はビットマスクで表現 (SpecInt32, SpecDouble, SpecString 等)
- フォワードデータフロー解析 (flow-insensitive fixpoint) で型を伝播
- 型に基づいて speculative check を挿入
- チェック失敗時は OSR Exit で低ティアに戻る

**DFG の主な最適化:**
| パス | 説明 |
|------|------|
| Type Check Hoisting | 型チェックをループ外に移動 |
| Constant Folding | 定数畳み込み |
| Strength Reduction | 演算の簡略化 (例: x * 2 -> x + x) |
| CFG Simplification | 不要な分岐の除去 |
| Dead Code Elimination | 未使用コードの除去 |
| CSE (Common Subexpression Elimination) | 共通部分式の除去 |

ref: https://webkit.org/blog/10308/speculation-in-javascriptcore/

### 2-3. FTL と B3 IR

FTL は DFG の SSA IR を受け取り、B3 IR に lowering する。

**IR の階層:**
```
DFG IR (ThreadedCPS)
  |  SSA 変換
  v
DFG SSA IR
  |  FTLLowerDFGToB3
  v
B3 IR (Bare Bones Backend -- C-like SSA IR)
  |  B3 最適化パス
  v
Air (Assembly Intermediate Representation)
  |  レジスタ割り当て + 命令選択
  v
Machine Code
```

**B3 IR の特徴:**
- C 言語レベルの SSA IR
- LLVM の代替として 2016 年に開発 (Filip Pizlo)
- LLVM と比較してコンパイル速度が約 **5 倍高速**、コード品質は同等
- 型: Int32, Int64, Float, Double, Void

**B3 の最適化パス:**
- Constant folding
- Strength reduction
- Dead code elimination
- CFG simplification
- Loop-invariant code motion (SSA 変換で有効化)
- Object Allocation Sinking (FTL 側で実装)

**Air (Assembly IR):**
- B3 をパターンマッチングで lowering (B3::LowerToAir)
- 後ろ向きに処理し、値とその子ノードを貪欲にマッチして 1 命令に統合
- 抽象レジスタ (Tmp) と抽象スタックスロットを持つ
- レジスタ割り当て: **Iterated Register Coalescing (IRC)**
  - LLVM より高速で、patchpoint のレジスタ制約に対応しやすい

ref: https://webkit.org/blog/5852/introducing-the-b3-jit-compiler/, https://webkit.org/docs/b3/

---

## 3. SpiderMonkey (Firefox)

### 3-1. パイプライン

```
JavaScript
  |
  v
Parser -> Bytecode
  |
  v
Baseline Interpreter (C++ ベース)
  |  IC (Inline Cache) でフィードバック収集
  v
Baseline JIT (テンプレート JIT + IC スタブ)
  |  CacheIR で型情報を構造化
  v
Warp (= WarpMonkey, IonMonkey の後継)
  |  WarpBuilder が CacheIR を直接 MIR に変換
  v
Machine Code
```

### 3-2. CacheIR と WarpBuilder

SpiderMonkey の独自アプローチ: Inline Cache を IR として構造化。

**CacheIR:**
- IC のロジックを IR (中間表現) として記述
- IC スタブのコード生成、Baseline JIT、Warp の全てで共有
- 型フィードバックを統一的に表現

**WarpBuilder:**
- Bytecode + CacheIR を直接 MIR に変換するフロントエンド
- 旧 IonBuilder (型推論ベース) を置き換え
- CacheIR を直接 lowering するため、セキュリティリスクが低減

**Trial Inlining:**
- Baseline と Warp の間に新しい warmup threshold を追加
- threshold 到達時に callee を分析し、インライン候補を決定
- 候補の callee に専用の ICScript を割り当て、文脈依存の IC 情報を収集
- Warp コンパイル時にこの情報を使ってインライン展開

### 3-3. MIR (Mid-level IR)

**構造:**
- CFG + SSA 形式
- 各ブロックは MIR 命令のリスト
- MIR 命令は JS セマンティクスを持つ (MAdd, MGetProperty 等)
- 型情報付き (MIRType: Int32, Double, Object, String 等)

**MIR 最適化パス (IonMonkey/WarpMonkey):**

| パス | 説明 |
|------|------|
| Apply Types | 型フィードバックに基づく型の特殊化 |
| Alias Analysis | メモリアクセスの依存関係を解析。GVN の前提 |
| GVN (Global Value Numbering) | 冗長な式の除去。foldsTo() メソッドで式の簡約化 |
| LICM (Loop-Invariant Code Motion) | ループ不変式をループ外に移動 |
| Range Analysis | 値の範囲を追跡。Bounds Check の除去に使用 |
| Truncation Analysis | 64bit -> 32bit への切り捨てが安全か判定 |
| Dead Code Elimination | 未使用命令の除去 |
| Scalar Replacement | 逃げないオブジェクトの分解 |
| Instruction Reordering | 命令並べ替え |

ref: https://firefox-source-docs.mozilla.org/js/MIR-optimizations/index.html,
     https://wiki.mozilla.org/IonMonkey/Overview

### 3-4. LIR (Low-level IR)

**MIR -> LIR の lowering:**
- MIR の各命令をアーキテクチャ固有の LIR 命令に変換
- 例: `MAdd(Int32)` -> `LAddI` (x86: `add eax, ebx`)
- LIR はまだ SSA 形式 (仮想レジスタ)
- レジスタ割り当て後に native code を生成

**レジスタ割り当て:**
- Backtracking allocator (LSRA ベース)

ref: https://spidermonkey.dev/blog/2024/10/16/75x-faster-optimizing-the-ion-compiler-backend.html

---

## 4. 共通の最適化パスまとめ

### 4-1. パス別の効果

| 最適化 | 効果 | 実装難度 | 備考 |
|--------|------|----------|------|
| **Constant Folding** | 中 | 低 | 定数式を事前計算。最も基本的 |
| **DCE (Dead Code Elimination)** | 中 | 低 | 使われない計算を除去 |
| **CSE / GVN** | 高 | 中 | 同じ計算の重複除去。SSA なら実装しやすい |
| **Inlining** | 非常に高 | 中-高 | 他の最適化を有効化する「門番」的最適化 |
| **LICM** | 高 | 中 | ループ内の不変式をループ外に。ループ多用コードに効く |
| **Escape Analysis** | 高 | 高 | GC 負荷を劇的に下げる。Scalar Replacement と組み合わせ |
| **Range Analysis** | 中 | 中 | Bounds Check 除去に必要 |
| **Register Allocation** | 高 | 高 | Linear Scan or IRC。native 生成時に必要 |
| **Loop Unrolling / Peeling** | 中 | 中 | 分岐オーバーヘッドの除去 |
| **Load/Store Elimination** | 中 | 中 | メモリアクセスの冗長除去 |

### 4-2. 各エンジンの比較

|  | V8 (TurboFan) | JSC (FTL) | SpiderMonkey (Warp) |
|--|---|---|---|
| IR 形式 | CFG + SSA (Turboshaft) | DFG -> SSA -> B3 -> Air | CFG + SSA (MIR -> LIR) |
| IR 段数 | 1 (Turboshaft) | 4 (DFG, DFG-SSA, B3, Air) | 2 (MIR, LIR) |
| レジスタ割り当て | Linear Scan | IRC (Iterated Register Coalescing) | Backtracking (LSRA ベース) |
| 型情報の取得 | Inline Cache feedback | Value Profile (SpecType) | CacheIR |
| フロントエンド | Maglev / TurboFan | DFG Builder | WarpBuilder (CacheIR から直接) |
| Escape Analysis | あり | Object Allocation Sinking | あり (Scalar Replacement) |

---

## 5. jsmini への応用: bytecode -> IR -> Wasm

### 5-1. jsmini の現状

```
現在のパイプライン:
  Parser -> AST -> Bytecode -> VM (スタックマシン)
                            -> JIT (bytecode を直接 Wasm に変換)
```

Phase 5-12 の JIT は bytecode を直接 Wasm 命令に変換している。
IR 層がないため、最適化の余地が限られている。

### 5-2. 最もシンプルで有用な IR: CFG + SSA

**推奨: 基本ブロック付き CFG (SSA 形式)**

理由:
1. **V8 が Sea of Nodes を捨てて CFG に戻った** -- Sea of Nodes は「JS には合わない」という結論
2. **全エンジンが最終的に CFG + SSA に収束** -- SpiderMonkey (MIR), JSC (B3), V8 (Turboshaft)
3. **SSA は最適化パスを劇的に簡単にする** -- 各変数が 1 回だけ定義されるため、
   def-use チェーンの追跡が自明
4. **Wasm 自体がブロック構造** -- CFG -> Wasm への変換は自然

**jsmini IR の最小設計案:**

```typescript
// 基本ブロック
interface Block {
  id: number;
  ops: Op[];           // 命令リスト (SSA)
  successors: Block[]; // 後続ブロック (0=無条件, 1=fall-through, 2=branch)
  predecessors: Block[];
  phis: PhiOp[];       // phi ノード (SSA の合流点)
}

// SSA 命令
interface Op {
  id: number;          // SSA 値の一意 ID
  opcode: IROpcode;    // Add, Sub, Load, Store, Call, ...
  args: Op[];          // 引数 (他の Op への参照)
  type: IRType;        // Int32, Float64, Object, ...
}

// phi ノード
interface PhiOp extends Op {
  opcode: "Phi";
  inputs: Map<Block, Op>;  // 前任ブロック -> 値
}

type IRType = "i32" | "f64" | "object" | "any";
```

### 5-3. 最もコスパの良い最適化 (優先順位)

jsmini の教育目的を考慮し、実装コスト対効果で並べる:

#### Tier 1: 必ず実装 (効果大、実装簡単)

1. **Constant Folding**
   - `Add(Const(3), Const(4))` -> `Const(7)`
   - SSA グラフを走査して定数同士の演算をコンパイル時に計算
   - 実装: 50-100 行

2. **Dead Code Elimination**
   - 使われていない Op を除去
   - SSA なら use count == 0 の Op を消すだけ
   - 実装: 30-50 行

3. **Constant Propagation**
   - 定数を使用箇所に伝播 (Constant Folding と相乗効果)
   - 実装: Constant Folding に含められる

#### Tier 2: 強く推奨 (効果大、実装中程度)

4. **CSE (Common Subexpression Elimination)**
   - `a + b` が複数回出たら 2 回目以降を最初の結果で置換
   - SSA + ハッシュテーブルで実装可能
   - GVN (Global Value Numbering) として実装すれば CSE を包含
   - 実装: 100-200 行

5. **Type Specialization** (jsmini 既存の型フィードバックを活用)
   - `Add(any, any)` -> `i32.add` (両方 Int32 の場合)
   - 既に JIT でやっていることを IR レベルで表現
   - 実装: 既存コードのリファクタリング

#### Tier 3: ループ最適化 (効果大、やや複雑)

6. **LICM (Loop-Invariant Code Motion)**
   - ループ内で値が変わらない計算をループ外に移動
   - dominator tree の計算が必要
   - 実装: 200-300 行

7. **Bounds Check Elimination (Range Analysis の簡易版)**
   - ループカウンタの範囲がわかれば配列の境界チェックを除去
   - 実装: 200-400 行

#### Tier 4: 高度な最適化 (効果大、実装難)

8. **Inlining**
   - 既に JIT で部分的にやっている (callback inline, prototype method inline)
   - IR レベルで一般化すれば、任意の関数をインライン展開可能
   - 実装: 300-500 行

9. **Escape Analysis + Scalar Replacement**
   - `new Point(x, y)` が関数外に逃げないなら、フィールドをローカル変数に分解
   - 既に bump allocator でやっていることの一般化
   - 実装: 300-500 行

### 5-4. CFG + SSA vs SSA なし

| | CFG (SSA なし) | CFG + SSA |
|--|---|---|
| 変数の扱い | 変数は複数回代入可能 | 各変数は 1 回のみ定義 |
| 合流点 | 特別な処理不要 | phi ノードが必要 |
| DCE | use-def 追跡が必要 | use count で簡単 |
| CSE | 面倒 | ハッシュテーブルで簡単 |
| LICM | 面倒 | dominator tree + 定義の一意性で簡単 |
| 実装コスト | IR 構築が簡単 | phi 挿入アルゴリズムが必要 |

**結論: SSA を採用すべき。** phi ノード挿入の実装コストは、後続の最適化パス全てが
簡単になることで十分にペイする。bytecode のスタック操作を SSA に変換するのは
やや面倒だが、一度やれば全パスが恩恵を受ける。

### 5-5. jsmini 実装の具体的フロー

```
Bytecode (スタックマシン)
  |  (1) Abstract Interpretation: スタックを SSA 値に変換
  v
IR Graph (CFG + SSA, 基本ブロック)
  |  (2) 最適化パス: ConstFold -> DCE -> CSE -> TypeSpec -> LICM
  v
Optimized IR
  |  (3) IR -> Wasm 変換: 各 Op を Wasm 命令に lowering
  v
Wasm Module
```

**ステップ (1): Bytecode -> SSA IR の構築**
- bytecode を基本ブロックに分割 (ジャンプ先 = ブロック境界)
- 抽象スタックで bytecode を模擬実行し、各スタック位置を SSA 値に変換
- ブロック合流点で phi ノードを挿入

**ステップ (2): 最適化パス**
- 各パスは IR Graph を受け取り、変換した IR Graph を返す
- パス間の依存は最小限 (DCE は他のパスの後に走らせると効果的)

**ステップ (3): IR -> Wasm**
- 各 Block を Wasm の block/loop 構造にマッピング
- 各 Op を対応する Wasm 命令に変換
- phi ノードは Wasm のローカル変数で実現

---

## 6. 参考リンク

### V8
- [Land ahoy: leaving the Sea of Nodes](https://v8.dev/blog/leaving-the-sea-of-nodes) -- Turboshaft 導入の経緯
- [TurboFan documentation](https://v8.dev/docs/turbofan) -- TurboFan 公式ドキュメント
- [Digging into the TurboFan JIT](https://v8.dev/blog/turbofan-jit) -- TurboFan の構造
- [Maglev - V8's Fastest Optimizing JIT](https://v8.dev/blog/maglev) -- Maglev の設計
- [V8 is Faster and Safer than Ever!](https://v8.dev/blog/holiday-season-2023) -- Turboshaft の成果
- [Temporarily disabling escape analysis](https://v8.dev/blog/disabling-escape-analysis) -- EA のセキュリティ問題

### JavaScriptCore (WebKit)
- [Introducing the B3 JIT Compiler](https://webkit.org/blog/5852/introducing-the-b3-jit-compiler/) -- B3 の設計思想
- [Bare Bones Backend documentation](https://webkit.org/docs/b3/) -- B3 公式ドキュメント
- [Assembly Intermediate Representation](https://webkit.org/docs/b3/assembly-intermediate-representation.html) -- Air の詳細
- [Speculation in JavaScriptCore](https://webkit.org/blog/10308/speculation-in-javascriptcore/) -- 型スペキュレーション
- [Introducing the WebKit FTL JIT](https://webkit.org/blog/3362/introducing-the-webkit-ftl-jit/) -- FTL の導入
- [JavaScriptCore documentation](https://docs.webkit.org/Deep%20Dive/JSC/JavaScriptCore.html) -- JSC 全体概要
- [JSC Type Inference](https://docs.webkit.org/Deep%20Dive/JSC/JSCTypeInference.html) -- 型推論の詳細

### SpiderMonkey (Firefox)
- [Warp: Improved JS performance in Firefox 83](https://hacks.mozilla.org/2020/11/warp-improved-js-performance-in-firefox-83/) -- Warp の導入
- [MIR optimizations from a thousand feet](https://firefox-source-docs.mozilla.org/js/MIR-optimizations/index.html) -- MIR 最適化パス
- [IonMonkey Overview](https://wiki.mozilla.org/IonMonkey/Overview) -- Ion コンパイラの概要
- [IonMonkey Optimization passes](https://wiki.mozilla.org/IonMonkey/Optimization_passes) -- 最適化パス一覧
- [CacheIR paper (MPLR 2023)](https://bernsteinbear.com/assets/img/cacheir.pdf) -- CacheIR の学術論文
- [75x faster: optimizing the Ion compiler backend](https://spidermonkey.dev/blog/2024/10/16/75x-faster-optimizing-the-ion-compiler-backend.html) -- バックエンド最適化

### 一般 (SSA / IR 設計)
- [Static single-assignment form (Wikipedia)](https://en.wikipedia.org/wiki/Static_single-assignment_form)
- [Escape Analysis across JS engines](https://kipp.ly/escape-analysis/) -- 各エンジンの EA 比較
- [A compiler IR for Scrapscript](https://bernsteinbear.com/blog/scrapscript-ir/) -- 教育的 IR 設計の参考
- [JSC Internals Part III: DFG Graph Building](https://zon8.re/posts/jsc-part3-the-dfg-jit-graph-building/)
- [JSC Internals Part IV: DFG Graph Optimisation](https://zon8.re/posts/jsc-part4-the-dfg-jit-graph-optimisation/)
