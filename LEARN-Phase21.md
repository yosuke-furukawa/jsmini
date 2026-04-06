# LEARN-Phase21.md — LICM + CSE + Strength Reduction

## LICM (Loop-Invariant Code Motion)

### ループ不変式とは

ループ内で値が変わらない計算。全引数がループ外で定義されているか、既にループ不変と判定された Op。

```js
function f(n, x) {
  var sum = 0;
  for (var i = 0; i < n; i = i + 1) {
    sum = sum + x * 2;  // x * 2 はループ不変
  }
  return sum;
}
```

### 実装: preheader への移動

1. `analyzeCFG()` でループ構造を取得 (Phase 19 で実装済み)
2. ループヘッダの predecessor でループ外のブロック = preheader
3. ループ内の Op を走査、不変なら preheader の terminator 直前に移動
4. fixpoint iteration: ある Op が不変と判定されると、それを引数にする Op も不変になりうる

### ネストしたループ

body サイズが小さい順 (内側→外側) に処理。内側ループから外側ループの本体に移動した Op は、次の外側ループの LICM でさらに巻き上げ可能。optimize の fixpoint loop で自動的に多段巻き上げが起きる。

### 移動不可な Op

副作用のある Op は移動しない:
- `Call` — 関数呼び出しの副作用
- `StoreGlobal`, `ArraySet` — メモリ書き込み
- `TypeGuard` — deopt 位置が重要
- 制御フロー (`Branch`, `Jump`, `Return`)

## CSE (Common Subexpression Elimination)

### 同一計算の重複除去

SSA 形式なら「同じ opcode + 同じ args」を見つけるだけ。

```
v5 = Add(v0, v1)     // 最初の計算
v6 = Add(v0, v1)     // 重複 → v5 に置換
v7 = Mul(v5, v6)     // → Mul(v5, v5) に
```

### Local CSE (ブロック内)

同一ブロック内でのみ CSE を行う。ブロックをまたぐ CSE (Global CSE / GVN) は未実装だが、LICM と組み合わさることで多くのケースをカバー。

### CSE 対象外

副作用や値が変わりうる Op は対象外:
- `Call`, `StoreGlobal`, `ArraySet` — 副作用
- `LoadGlobal`, `ArrayGet`, `ArrayLength` — 間に副作用があると値が変わりうる
- `Param`, `Const`, `Phi` — ユニーク or 特殊

## Strength Reduction

### 2冪変換

整数の乗除算を安価なシフト演算に変換:

| 元の演算 | 変換後 | 条件 |
|---|---|---|
| `x * 2` | `x << 1` | — |
| `x * 4` | `x << 2` | — |
| `x / 2` | `x >> 1` | `x >= 0` (Range で判定) |
| `x % 4` | `x & 3` | `x >= 0` (Range で判定) |

除算・剰余のシフト変換は負数で挙動が変わるため、Range Analysis の結果を使って安全性を確認。

### 恒等変換

| 元の演算 | 結果 |
|---|---|
| `x * 0` | `0` |
| `x * 1` | `x` |
| `x + 0` | `x` |
| `x - 0` | `x` |

### 実装の注意: Const Op の共有問題

Strength Reduction で `Mul(v0, v1)` → `ShiftLeft(v0, v_new)` に変換する際、既存の Const Op の value を直接書き換えてはいけない。同じ Const が他の場所で使われていると壊れる。

```
// NG: right.value = shift (元の Const(2) が Const(1) に変わってしまう)
// OK: createConst(func, shift) で新しい Const を作る
```

### f64 モードとの互換性

Wasm の f64 にはビットシフト命令がない。f64 モード (Range Analysis で overflow を検出した場合) では:

- `ShiftLeft(x, n)` → `f64.mul(x, 2^n)` に展開
- `BitAnd(x, mask)` → `i32.trunc_f64_s` → `i32.and` → `f64.convert_i32_s` に展開

これは codegen 側で対応。optimize は f64 モードかどうかを知らなくてよい。

## パイプライン順序

```
Inlining → Constant Folding → CSE → DCE → LICM → Strength Reduction
```

- Constant Folding: 定数を畳んでから CSE (定数畳み込みで同値になるケースを先に処理)
- CSE: 重複を消してから DCE (参照が消えて use count が 0 になる Op を DCE で回収)
- LICM: CSE/DCE 後にループ不変式を巻き上げ
- Strength Reduction: 最後に低コスト演算に変換 (CSE の後にやらないと同じ shift が複数残る可能性)

### 学び

- LICM は既存のループ解析 (Phase 19) をそのまま使えた。SSA + CFG の基盤が整っていれば、新しい最適化パスの追加は比較的容易
- CSE のハッシュは `opcode:args.join(",")` という単純な方式。GVN (Global Value Numbering) のようなより高度な手法もあるが、Local CSE でも十分実用的
- Strength Reduction は Range Analysis (Phase 20) との連携が重要。負数のシフト変換バグを防げる
- f64 モードとのビットシフト互換性問題は事前に想像しにくい。テストで発見
