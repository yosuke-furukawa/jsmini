# PLAN v5 — IR (中間表現) の導入

Phase 1-15 完了。test262: TW 52.1%, VM 51.2%。

---

## これまでの全体像

```
Phase 1-3:   言語の基礎 (Lexer, Parser, TW)
Phase 4:     Bytecode VM (スタックマシン)
Phase 5:     Wasm JIT (型フィードバック + コンパイル)
Phase 6:     Element Kind (配列の型追跡)
Phase 7:     Hidden Class (プロパティレイアウト)
Phase 8:     Inline Cache + Object JIT
Phase 9:     独自文字列表現 (ConsString/SlicedString/Intern)
Phase 10:    Mark-and-Sweep GC + Wasm GC (struct)
Phase 11:    Closure (Upvalue) + OSR
Phase 12:    プロトタイプチェーン + Object.prototype
Phase 13:    構文拡大 + Generator + Symbol + Iterator Protocol
Phase 14:    WasmGC Array + ビルトイン自前実装
Phase 15:    構文対応拡大 (test262: 41% → 52%)
```

---

## なぜ IR が必要か

現在の JIT は bytecode を **直接** Wasm に変換している:

```
今:    bytecode → 1命令ずつ → Wasm命令
       Add → i32.add、LdaLocal → local.get ...
```

最適化の余地がない。以下が IR で可能になること:

```js
function f(x) {
  var a = 2 + 3;        // → IR: Const(5) に畳み込み
  for (var i = 0; i < 1000; i++) {
    var b = x * 2;      // → IR: ループ外に移動
    console.log(a + b); // → IR: Const(5) + b に簡約
  }
}
```

V8, JSC, SpiderMonkey の全エンジンが **CFG + SSA** に収束した。
jsmini もこれに倣う。

---

## Phase 16: CFG + SSA IR の導入

### 16-1: IR のデータ構造

```typescript
interface IRFunction {
  blocks: Block[];
  entryBlock: Block;
}

interface Block {
  id: number;
  ops: Op[];
  phis: PhiOp[];
  successors: number[];   // block id
  predecessors: number[];
}

interface Op {
  id: number;             // SSA value ID (一意)
  opcode: IROpcode;
  args: number[];         // 他の Op の id
  type: IRType;
}

interface PhiOp extends Op {
  opcode: "Phi";
  inputs: [number, number][];  // [predecessorBlockId, valueId]
}

type IRType = "i32" | "f64" | "any";

type IROpcode =
  | "Const"       // 定数
  | "Param"       // 関数パラメータ
  | "Add" | "Sub" | "Mul" | "Div" | "Mod"
  | "LessThan" | "GreaterThan" | "Equal" | "StrictEqual"
  | "Branch"      // 条件分岐
  | "Jump"        // 無条件ジャンプ
  | "Return"
  | "Call"        // 関数呼び出し
  | "Phi"         // SSA 合流
  // ... 拡張可能
```

ステップ:
- [ ] 16-1a: IR のデータ構造定義 (`src/ir/types.ts`)
- [ ] 16-1b: IR の文字列ダンプ (`--print-ir`)
- [ ] 16-1c: ユニットテスト

### 16-2: Bytecode → IR 変換 (SSA Builder)

スタックマシンの bytecode を SSA 形式の CFG に変換する。
V8 の Maglev や SpiderMonkey の WarpBuilder と同じ役割。

**アルゴリズム:**
1. bytecode のジャンプ先を分析 → 基本ブロックの境界を特定
2. 各ブロックを抽象解釈: スタックを SSA 値として模擬実行
3. ブロック合流点で Phi ノードを挿入

```
bytecode:                    IR:
  LdaConst 3         →      Block 0:
  LdaConst 4                   v0 = Const(3)
  Add                           v1 = Const(4)
  StaLocal 0                    v2 = Add(v0, v1)
  LdaLocal 0                   Return(v2)
  Return
```

ループの場合:
```
bytecode:                    IR:
  LdaConst 0          →     Block 0 (entry):
  StaLocal 0                   v0 = Const(0)
  LdaLocal 0                   v1 = Const(10)
  LdaConst 10                  Jump → Block 1
  LessThan
  JumpIfFalse exit         Block 1 (loop header):
  ...                          v2 = Phi(v0 from Block0, v5 from Block2)
  Jump loop                    v3 = LessThan(v2, v1)
                               Branch(v3) → Block2, Block3

                           Block 2 (loop body):
                               v4 = Const(1)
                               v5 = Add(v2, v4)
                               Jump → Block 1

                           Block 3 (exit):
                               Return(v2)
```

ステップ:
- [ ] 16-2a: ブロック境界の特定 (ジャンプ先の分析)
- [ ] 16-2b: 抽象スタック模擬実行 → SSA 値の生成
- [ ] 16-2c: Phi ノードの挿入
- [ ] 16-2d: fibonacci, for-loop の IR ダンプ確認
- [ ] 16-2e: ユニットテスト

### 16-3: Constant Folding + DCE

最初の最適化パス。最もシンプルで効果がわかりやすい。

**Constant Folding:**
```
v0 = Const(3)
v1 = Const(4)
v2 = Add(v0, v1)    →    v2 = Const(7)
```

**Dead Code Elimination:**
```
v0 = Const(3)        (use count = 0 → 削除)
v1 = Const(4)        (use count = 0 → 削除)
v2 = Const(7)
Return(v2)
```

ステップ:
- [ ] 16-3a: Constant Folding パス (定数同士の演算を事前計算)
- [ ] 16-3b: DCE パス (use count = 0 の Op を除去)
- [ ] 16-3c: `--print-ir-optimized` で最適化前後を表示
- [ ] 16-3d: ユニットテスト + ベンチマーク

### 16-4: IR → Wasm 変換

最適化された IR を Wasm 命令に変換する。
現在の bytecode → Wasm 変換を IR → Wasm に置き換え。

**基本方針:**
- 各 Block を Wasm の block/loop 構造にマッピング
- 各 Op を対応する Wasm 命令に変換
- Phi ノードは Wasm のローカル変数で実現
- CFG → Wasm の structured control flow への変換 (Relooper アルゴリズム)

ステップ:
- [ ] 16-4a: IR Op → Wasm 命令のマッピング
- [ ] 16-4b: Phi → Wasm local の変換
- [ ] 16-4c: CFG → Wasm structured control flow (Relooper or Stackifier)
- [ ] 16-4d: fibonacci, for-loop で Wasm 生成確認
- [ ] 16-4e: 既存の JIT テスト + ベンチマークが壊れてないことを確認

### 16-5: CSE (Common Subexpression Elimination)

SSA + ハッシュテーブルで実装。GVN (Global Value Numbering) として。

```
v0 = Param(0)    // x
v1 = Param(1)    // y
v2 = Add(v0, v1)
v3 = Add(v0, v1)  →  v3 を v2 に置換
v4 = Mul(v2, v3)  →  v4 = Mul(v2, v2)
```

ステップ:
- [ ] 16-5a: GVN パス (opcode + args のハッシュで同値判定)
- [ ] 16-5b: DCE で不要になった Op を除去
- [ ] 16-5c: ユニットテスト

### 16-6: LICM (Loop-Invariant Code Motion)

ループ内で値が変わらない計算をループ外に移動。

```
Block 1 (loop):
  v3 = Param(0)          // x はループ不変
  v4 = Const(2)
  v5 = Mul(v3, v4)       // x * 2 はループ不変 → ループ外に移動
  ...
```

ステップ:
- [ ] 16-6a: Dominator tree の構築
- [ ] 16-6b: ループの検出 (back edge)
- [ ] 16-6c: ループ不変命令の判定 + 移動
- [ ] 16-6d: ベンチマーク (ループ内に不変式があるケースで効果測定)

---

## 学べること

| ステップ | 学び |
|---|---|
| 16-1 | SSA 形式とは何か、なぜ全エンジンが採用するのか |
| 16-2 | スタックマシン → SSA への変換 (抽象解釈、Phi ノード) |
| 16-3 | 最も基本的なコンパイラ最適化 |
| 16-4 | CFG → structured control flow への変換 (Wasm の制約) |
| 16-5 | Value Numbering — コンパイラの古典的手法 |
| 16-6 | ループ最適化 — Dominator tree、back edge |

---

## Phase 17 以降 (検討中)

### Type Specialization in IR
- 型フィードバックを IR レベルで活用
- `Add(any, any)` → `I32Add(i32, i32)` + 型ガード
- Deoptimization: 型ガード失敗 → bytecode VM にフォールバック

### Inlining in IR
- 呼び出し先の IR を呼び出し元の IR にインライン展開
- V8 の Maglev が重視する最適化

### Escape Analysis
- オブジェクトがスコープ外に逃げないなら Scalar Replacement
- GC 負荷の劇的な削減

### Register-based bytecode
- スタックマシン → レジスタマシン
- V8 Ignition はレジスタベース
