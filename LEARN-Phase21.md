# LEARN-Phase21.md — LICM + CSE + Strength Reduction + IR カバレッジ拡大

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

## IR カバレッジ拡大: クロージャ・プロパティ・Construct

### 最適化パスより「IR に載せる」方が効く

LICM/CSE/SR のマイクロベンチでは、Wasm バックエンド (V8 Liftoff/TurboFan) が同等の最適化を既にやっているため **IR 側の最適化だけでは速度差がほぼゼロ** だった。

一方、「VM フォールバックしていた機能を IR に載せる」と **桁違いの速度改善** が得られた。Wasm が最適化してくれるのは「Wasm に載ったコード」だけなので、IR のカバレッジ拡大 = JIT 対象の拡大がダイレクトに効く。

### クロージャ (LoadUpvalue / StoreUpvalue)

Direct JIT では upvalue を Wasm 関数の追加パラメータとして渡す仕組みが既にあった。IR パスでは `LdaUpvalue`/`StaUpvalue` を IR builder が `default: break` でスキップしていただけ。

```
// IR: adder (makeAdder(5) の内部関数)
v0: any = Param(0)          // x
v1: any = LoadUpvalue(0)    // n (キャプチャされた変数)
v2: i32 = Add(v0, v1)
Return(v2)
```

実装: `LoadUpvalue(n)` → `local.get(paramCount + n)`。JitManager の `executeWasm` が既に upvalue を追加引数として渡す処理を持っていたので、codegen だけの変更で動いた。

### プロパティアクセス (LoadThis / LoadProperty / StoreProperty)

Direct JIT では linear memory 上にオブジェクトの slots を配置し、プロパティ名に固定オフセットを割り当てて `i32.load`/`i32.store` する。IR パスでも同方式を採用。

```
// IR: dist() — Point.prototype.dist
v0: i32 = LoadThis
v1: i32 = LoadProperty(v0, "x")   // i32.load(this + 0)
v3: i32 = LoadProperty(v0, "y")   // i32.load(this + 4)
v4: i32 = Mul(v1, v1)
v5: i32 = Mul(v3, v3)
v6: i32 = Add(v4, v5)
Return(v6)
```

#### __proto__ オフセット問題

JSObject の slots は `[__proto__, x, y]` の順で、`__proto__` が slot 0 にある。IR codegen の propOffsets は `x→0, y→1` と振るので、メモリコピー時に `__proto__` をスキップして数値プロパティだけ詰めてコピーする必要がある。Hidden Class の properties map を使って正しい slot を特定。

### Construct + CallMethod

- `Construct`: `Alloc` (bump allocator) + `Call(ctor, args, this=alloc)` に分解
- `CallMethod`: `Call(methodRef, args, this)` に変換。inlining で消えるのが理想

### LICM × LoadProperty の相乗効果

Phase 21 の最大の発見: **LICM が `LoadProperty(this, "x")` をループ外に巻き上げることで、Direct JIT の 79 倍速くなった。**

```js
Point.prototype.heavy = function() {
  var sum = 0;
  for (var i = 0; i < 100; i++) {
    sum = sum + this.x * this.x + this.y * this.y;  // ← 毎回 i32.load
  }
  return sum;
};
```

- **Direct JIT**: ループ内で毎回 `i32.load(this+0)`, `i32.load(this+4)` を4回実行
- **IR JIT**: LICM が `LoadProperty` をループ外に移動 → ループ内は純粋な算術のみ

```
// LICM 後の IR
B0 (preheader):
  v10: i32 = LoadThis
  v11: i32 = LoadProperty(v10, "x")   // ← ループ外に巻き上げ
  v14: i32 = Mul(v11, v11)            // ← x*x もループ外
  v17: i32 = LoadProperty(v10, "y")
  v20: i32 = Mul(v17, v17)            // ← y*y もループ外
B2 (loop body):
  v15: i32 = Add(v1, v14)             // sum + x*x
  v21: i32 = Add(v15, v20)            // + y*y
```

これは「LICM 単体では Wasm 上で速度差が出ない」という先のベンチ結果と矛盾するように見えるが、違いは **メモリアクセス (i32.load) vs レジスタ演算** にある。

- `i32.mul`, `i32.add` — 1クロック。LICM で外に出してもレジスタ計算なのでほぼ同じ
- `i32.load` — L1 キャッシュヒットでも数クロック + パイプラインストール。ループ外に出すと 100回→1回に減り劇的に効く

**LICM はレジスタ演算には効かないが、メモリアクセスには大きく効く。** V8 の Liftoff はこの最適化をやらない (単純な 1:1 変換) ので、jsmini 側の LICM が初めて効果を発揮したケース。

## ベンチマーク全体の学び

### IR JIT の強み: 正確性

| ベンチ | Direct JIT | IR JIT |
|---|---|---|
| CSE: dup a*b | 1146749120 (overflow) | 666866680000 (正確) |
| i32 overflow | -61063496 (壊れ) | 41665416675000 (正確) |

Range Analysis + f64 昇格で、Direct JIT が壊れるケースでも IR JIT は正しい結果を返す。

### IR JIT の強み: 最適化の組み合わせ

| ベンチ | Direct | IR | IR/Direct |
|---|---|---|---|
| inlining cube(square) | 15.9ms | 9.4ms | **1.7x** |
| method p.heavy() | 984ms | 12.5ms | **79x** |

- inlining: IR パスの inlining + constant folding で Call が消え、演算が最適化される
- p.heavy(): LICM × LoadProperty の相乗効果

### Direct JIT の強み: 単純なループ

| ベンチ | Direct | IR | Direct/IR |
|---|---|---|---|
| for loop sum | 0.13ms | 0.31ms | 2.4x |
| nested loop | 0.11ms | 0.33ms | 3x |
| smi arithmetic | 0.15ms | 0.36ms | 2.4x |

Direct JIT は bytecode → Wasm の直接変換で余分な中間表現がないため、単純なループでは IR JIT より速い。IR パスは builder + optimize + codegen のオーバーヘッドがある。

### まとめ

- **最適化パスを追加する** より **IR に載せる機能を増やす** 方が実効速度への影響が大きい
- ただし LICM × メモリアクセス (LoadProperty) のように、**最適化パスと新機能の組み合わせ** で初めて効果が出るケースもある
- IR JIT の価値は **速度 + 正確性 + 最適化の可視化** の三本柱
