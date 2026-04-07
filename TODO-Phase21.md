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

- [x] 21-2a: `src/ir/cse.ts` — 同一ブロック内の CSE (Local CSE)
- [x] 21-2b: ハッシュ: `opcode + args.join(",")` で同値判定
- [x] 21-2c: 重複 Op を最初の Op に置換 (uses の付け替え)
- [x] 21-2d: optimize() パイプラインに CSE を追加
- [x] 21-2e: テスト (同一式の除去、副作用ありは除外、ブロックまたぎ)

### 21-3: Strength Reduction

- [x] 21-3a: `src/ir/strength-reduce.ts` — Mul/Div/Mod の 2 冪変換
- [x] 21-3b: 恒等変換 (x*0→0, x*1→x, x+0→x, x-0→x)
- [x] 21-3c: Range 情報を使った安全判定 (右シフトは正の整数のみ)
- [x] 21-3d: optimize() パイプラインに追加 (Constant Folding の後)
- [x] 21-3e: テスト (2冪変換、恒等変換、負数で変換しないケース)
- [x] 21-3f: f64 モードで ShiftLeft/BitAnd を Mul/i32変換する codegen 対応

### 21-4: ベンチマーク + 統合テスト

- [x] 21-4a: LICM ベンチ: x*2 ループ外移動、TW 11.96ms → IR 0.61ms
- [x] 21-4b: CSE ベンチ: 冗長 (i+1)*(i+2)、Direct JIT overflow → IR 正確
- [x] 21-4c: Strength Reduction ベンチ: x*4 → x<<2、TW 10.67ms → IR 0.30ms
- [x] 21-4d: 全 658 テストパス
- [x] 21-4e: Playground プリセット「IR Optimizations (LICM/CSE/SR)」追加

### 21-5: クロージャ IR 対応

Direct JIT では upvalue を追加パラメータとして Wasm 関数に渡す仕組みがあるが、
IR パスでは `LdaUpvalue` / `StaUpvalue` を扱えず VM フォールバックしていた。

- [x] 21-5a: IR opcode `LoadUpvalue` / `StoreUpvalue` を追加
- [x] 21-5b: Builder: `LdaUpvalue` → `LoadUpvalue`、`StaUpvalue` → `StoreUpvalue` 変換
- [x] 21-5c: Codegen: upvalue を追加パラメータとして Wasm 関数に渡す (Direct JIT と同方式)
- [x] 21-5d: JitManager の executeWasm が既に upvalue 対応済み → 変更不要
- [x] 21-5e: makeAdder, makeMul, makeLinear が IR パスで動作確認

### 21-6: プロパティアクセス IR 対応

Direct JIT では `this.x` を linear memory 上の固定オフセットで i32.load/store しているが、
IR パスでは `GetProperty("length")` → `ArrayLength` 以外の named property が未対応。

- [ ] 21-6a: IR opcode `LoadThis`, `LoadProperty`, `StoreProperty` を追加
- [ ] 21-6b: Builder: `LoadThis` → `LoadThis`、`GetProperty` → `LoadProperty`、`SetPropertyAssign` → `StoreProperty`
- [ ] 21-6c: Codegen: linear memory + プロパティ名→オフセットマップ + i32.load/store
- [ ] 21-6d: `compileIRToWasm`: WebAssembly.Memory 追加、プロパティオフセット算出
- [ ] 21-6e: JitManager: IR パスで this + memory の連携 (slots コピー)
- [ ] 21-6f: テスト (this.x 読み書き、Point.dist() 相当)

## 目標

- ループ内の冗長な計算を除去 (LICM)
- 重複計算を共有 (CSE)
- 高コスト演算を低コストに置換 (Strength Reduction)
- クロージャが IR パスで動く (upvalue 対応)
- プロパティアクセスが IR パスで動く (linear memory)
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
