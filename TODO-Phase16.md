# TODO Phase 16 — SSA IR + Constant Folding

## 動機

現在の JIT は bytecode を直接 Wasm に変換しており、最適化の余地がない。
最小限の IR (CFG + SSA) を導入し、Constant Folding で効果を実証する。

## 現状

```
今:        bytecode → direct Wasm (wasm-compiler.ts) ← 残す
新 (--ir): bytecode → IR (SSA) → Constant Folding + DCE → Wasm (ir/codegen.ts)
```

両パスを共存させる。`--jit` は従来の direct Wasm、`--jit --ir` で IR 経由。
比較ベンチや段階的移行が可能。

## ステップ

### 16-1: IR データ構造 ✅

- [x] 16-1a: `src/ir/types.ts` — Block, Op, PhiOp, IRType, IROpcode + ヘルパー関数
- [x] 16-1b: `src/ir/printer.ts` — IR の文字列ダンプ (printIR)
- [x] 16-1c: テスト (10 tests)

### 16-2: Bytecode → IR 変換 ✅

- [x] 16-2a: `src/ir/builder.ts` — SSA Builder
  - ブロック境界の特定 (ジャンプ先分析)
  - 抽象スタック模擬実行 → SSA 値生成
  - Phi ノード挿入 (ブロック出口ローカル状態比較)
- [x] 16-2b: fibonacci, for-loop の IR ダンプ確認
- [x] 16-2c: テスト (5 tests)

### 16-3: Constant Folding + DCE ✅

- [x] 16-3a: `src/ir/optimize.ts` — Constant Folding (2引数 + 1引数、fixpoint)
- [x] 16-3b: DCE (use count = 0 の Op を除去、制御フロー命令は保護)
- [x] 16-3c: optimize() パイプライン (Constant Folding + DCE の繰り返し)
- [x] 16-3d: テスト (8 tests: fold, nested, comparison, DCE, pipeline)

### 16-4: IR → Wasm 変換 ✅

- [x] 16-4a: `src/ir/codegen.ts` — IR Op → Wasm 命令マッピング + Phi → local
- [x] 16-4b: `--jit --ir` パイプライン (JitManager に compileViaIR 追加)
- [x] 16-4c: `--print-ir` で IR ダンプ (最適化前後)
- [x] 16-4d: 6 codegen テスト + 既存ベンチ正常確認
- [x] 16-4e: IR JIT vs Direct JIT ベンチ: 定数畳み込み 1.9x, add 1.6x 高速

## 目標

- IR ダンプで Constant Folding の効果が見える
- `2 + 3` が IR 上で `5` に畳み込まれる
- fibonacci, for-loop のベンチマークが壊れない (最低限、同等の性能)
- `--print-ir` でパイプラインの可視化

## 技術メモ

### SSA とは

各変数が **1回だけ定義** される形式。合流点では Phi ノードで値を選択。

```
// 通常のコード        // SSA
x = 1;               x1 = 1
if (cond) {           if (cond) {
  x = 2;                x2 = 2
}                     }
use(x);               x3 = Phi(x1, x2)
                      use(x3)
```

利点: use-def が自明、最適化パスが簡単。

### Bytecode → SSA の変換

スタックマシンのスタック位置を SSA 値に対応づける抽象解釈:

```
bytecode        抽象スタック        IR
LdaConst 3      [v0]               v0 = Const(3)
LdaConst 4      [v0, v1]           v1 = Const(4)
Add             [v2]               v2 = Add(v0, v1)
Return          []                 Return(v2)
```
