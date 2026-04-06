# TODO Phase 21 — LICM + CSE + Strength Reduction

## 動機

Phase 16-20 で SSA-IR + Range Analysis + 配列対応が揃った。
IR の上に古典的な最適化パスを積んで、IR JIT の実行速度を引き上げる。

### 1. LICM (Loop-Invariant Code Motion)

ループ内で値が変わらない計算をループ外に移動。
ループ回数が多いほど効果大。

```js
function f(n, x) {
  var sum = 0;
  for (var i = 0; i < n; i++) { sum += x * 2; }
  return sum;
}
// x * 2 はループ不変 → ループ外に巻き上げ
```

### 2. CSE (Common Subexpression Elimination)

同じ計算の重複を除去。SSA なら「同じ opcode + 同じ args」を探すだけ。

```js
var a = x + y;
var b = x + y;  // ← a を再利用、計算を省略
```

### 3. Strength Reduction

高コスト演算を低コストに置き換え。

```js
x * 2   → x << 1    // (i32 のみ)
x * 4   → x << 2
x / 2   → x >> 1    // (正の整数のみ、Range で判定)
x % 2   → x & 1     // (正の整数のみ)
x * 0   → 0
x * 1   → x
x + 0   → x
```

## ステップ

### 21-1: LICM

- [x] 21-1a: `src/ir/licm.ts` — ループ不変判定 (`isLoopInvariant(op, loopBlocks)`)
- [x] 21-1b: ループヘッダの直前 (preheader) に不変 Op を移動
- [x] 21-1c: ネストしたループ対応 (内側から外側へ段階的に巻き上げ)
- [x] 21-1d: optimize() パイプラインに LICM を追加
- [x] 21-1e: テスト (不変式巻き上げ、ループ依存は移動しない、ネストループ)

### 21-2: CSE

- [ ] 21-2a: `src/ir/cse.ts` — 同一ブロック内の CSE (Local CSE)
- [ ] 21-2b: ハッシュ: `opcode + args.join(",")` で同値判定
- [ ] 21-2c: 重複 Op を最初の Op に置換 (uses の付け替え)
- [ ] 21-2d: optimize() パイプラインに CSE を追加
- [ ] 21-2e: テスト (同一式の除去、副作用ありは除外、ブロックまたぎ)

### 21-3: Strength Reduction

- [ ] 21-3a: `src/ir/strength-reduce.ts` — Mul/Div/Mod の 2 冪変換
- [ ] 21-3b: 恒等変換 (x*0→0, x*1→x, x+0→x, x-0→x)
- [ ] 21-3c: Range 情報を使った安全判定 (右シフトは正の整数のみ)
- [ ] 21-3d: optimize() パイプラインに追加 (Constant Folding の後)
- [ ] 21-3e: テスト (2冪変換、恒等変換、負数で変換しないケース)

### 21-4: ベンチマーク + 統合テスト

- [ ] 21-4a: LICM ベンチ: ループ内定数計算が巻き上がることを確認
- [ ] 21-4b: CSE ベンチ: 冗長計算除去の効果を計測
- [ ] 21-4c: Strength Reduction ベンチ: 2冪 Mul → Shift の効果
- [ ] 21-4d: 全テストパス (既存 634+ テスト)
- [ ] 21-4e: Playground プリセット追加 (LICM / CSE / Strength Reduction の可視化)

## 目標

- ループ内の冗長な計算を除去 (LICM)
- 重複計算を共有 (CSE)
- 高コスト演算を低コストに置換 (Strength Reduction)
- IR の printIR / Playground で最適化の before/after が見える

## 技術メモ

### LICM の前提条件

ループ構造は `src/ir/loop-analysis.ts` で既に解析済み (Phase 19)。
バックエッジ検出、ループブロック集合、ループヘッダ特定ができている。

ループ不変の定義:
- Op の全引数がループ外で定義されている
- または、全引数が既にループ不変と判定された Op

副作用のある Op (Call, StoreGlobal, ArraySet) は移動しない。

### CSE と Constant Folding の関係

Constant Folding は `Const(2) + Const(3) → Const(5)` (定数同士の畳み込み)。
CSE は `Add(v0, v1)` と `Add(v0, v1)` が同じなら一方を消す。

パイプライン順序: Constant Folding → CSE → LICM → Strength Reduction
(CSE で冗長を消してから LICM、Strength Reduction は最後)

### Strength Reduction と Range Analysis

`x / 2 → x >> 1` は x が正の場合のみ安全 (負数の除算は切り捨て方向が違う)。
Phase 20 の Range Analysis で `x.range.min >= 0` なら安全に変換できる。
