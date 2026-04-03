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

### 16-1: IR データ構造

- [ ] 16-1a: `src/ir/types.ts` — Block, Op, PhiOp, IRType, IROpcode
- [ ] 16-1b: `src/ir/printer.ts` — IR の文字列ダンプ (`--print-ir`)
- [ ] 16-1c: テスト

### 16-2: Bytecode → IR 変換

- [ ] 16-2a: `src/ir/builder.ts` — SSA Builder
  - ブロック境界の特定 (ジャンプ先分析)
  - 抽象スタック模擬実行 → SSA 値生成
  - Phi ノード挿入
- [ ] 16-2b: fibonacci, for-loop の IR ダンプ確認
- [ ] 16-2c: テスト

### 16-3: Constant Folding + DCE

- [ ] 16-3a: `src/ir/optimize.ts` — Constant Folding
  - `Add(Const(3), Const(4))` → `Const(7)` 等
- [ ] 16-3b: DCE (use count = 0 の Op を除去)
- [ ] 16-3c: `--print-ir` で最適化前後を表示
- [ ] 16-3d: テスト

### 16-4: IR → Wasm 変換

- [ ] 16-4a: `src/ir/codegen.ts` — IR Op → Wasm 命令
  - Phi → Wasm local
  - CFG → structured control flow
- [ ] 16-4b: fibonacci, for-loop で Wasm 生成確認
- [ ] 16-4c: 既存ベンチマークが壊れてないことを確認

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
