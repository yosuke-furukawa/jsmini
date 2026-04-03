# LEARN-Phase16.md — SSA IR + Constant Folding

## なぜ IR を入れたか

Phase 5 で導入した Wasm JIT は bytecode を「1命令ずつ」Wasm に変換していた。

```
LdaConst 3   →  i32.const 3
LdaConst 4   →  i32.const 4
Add          →  i32.add
```

これは **直訳** であり、最適化の余地がない。`2 + 3` は実行時に毎回計算される。
IR (中間表現) を挟むことで、コンパイル時に計算を済ませたり、
不要なコードを削除したりできるようになる。

## CFG + SSA — 全エンジンが収束した形式

V8, JSC, SpiderMonkey の3大エンジンが全て **CFG (Control Flow Graph) + SSA (Static Single Assignment)** に収束した。

- V8: Sea of Nodes → **Turboshaft (CFG)** に移行 (2022-)
- JSC: DFG → **B3 (CFG + SSA)** (2016-)
- SpiderMonkey: **MIR (CFG + SSA)** (2013-)

Sea of Nodes (ブロックなし、ノードが自由に浮遊) は JS には合わなかった。
JS のほぼ全操作が副作用を持つため、結局順序を追跡する必要があり、CFG と変わらなくなった上に複雑さだけが残った。

### CFG とは

プログラムを **基本ブロック** (途中で分岐しない命令列) に分割し、
ブロック間を **エッジ** (制御の流れ) で繋いだグラフ。

```
B0 (entry):
  v0 = Const(0)     // sum = 0
  v1 = Const(10)    // limit
  Jump → B1

B1 (loop header):         ← B0, B2
  v2 = Phi(B0:v0, B2:v5)  // sum
  v3 = Phi(B0:v0, B2:v6)  // i
  v4 = LessThan(v3, v1)
  Branch(v4) → B2, B3

B2 (loop body):
  v5 = Add(v2, v3)        // sum + i
  v6 = Add(v3, Const(1))  // i + 1
  Jump → B1

B3 (exit):
  Return(v2)
```

### SSA とは

**各変数が1回だけ定義される** 形式。同じ変数への再代入は、新しい番号の変数として扱う。

```js
// 通常のコード    →    SSA
x = 1;                 v0 = Const(1)
x = x + 2;            v1 = Add(v0, Const(2))
```

合流点 (if の後、ループの先頭) では **Phi ノード** で「どのパスから来たか」によって値を選ぶ:

```
v3 = Phi(B0:v0, B2:v5)  // B0 から来たら v0、B2 から来たら v5
```

SSA の利点:
- **use-def チェーンが自明**: 各値は1回だけ定義されるので、定義元が一意
- **最適化パスが簡単**: use count で DCE、ハッシュで CSE、etc.

## Bytecode → SSA の変換

スタックマシンの bytecode を SSA に変換するのが SSA Builder の仕事。
V8 の Maglev や SpiderMonkey の WarpBuilder と同じ役割。

**アルゴリズム:**

1. **ブロック境界の特定**: ジャンプ先と次の命令をブロック境界にする
2. **抽象スタック模擬実行**: スタック位置を SSA 値 ID に対応づけながら bytecode を走査
3. **Phi ノード挿入**: 複数の predecessor から異なる値が来る合流点に Phi を置く

```
bytecode:           抽象スタック     IR:
LdaConst 3          [v0]            v0 = Const(3)
LdaConst 4          [v0, v1]        v1 = Const(4)
Add                 [v2]            v2 = Add(v0, v1)
Return              []              Return(v2)
```

ループの場合は、ループヘッダのブロックに Phi ノードが入る。
ブロックの出口でのローカル変数状態を比較して、異なる値が来る場合に Phi を挿入。

## Constant Folding + DCE

### Constant Folding

定数同士の演算をコンパイル時に計算する。最も基本的な最適化。

```
v0 = Const(2)                v6 = Const(21)
v1 = Const(3)      →         Return(v6)
v2 = Add(v0, v1)    fold
v3 = Const(3)
v4 = Const(4)
v5 = Add(v3, v4)
v6 = Mul(v2, v5)
Return(v6)
```

7 命令 → 2 命令。実装は SSA グラフを走査して、両引数が Const の演算を見つけたら結果で置換するだけ。ネストした定数式は fixpoint ループで繰り返し畳み込む。

### Dead Code Elimination (DCE)

使われていない Op を除去する。Constant Folding で畳み込まれた後、
元の `Const(2)`, `Const(3)` は誰にも使われなくなるので消せる。

SSA なら実装が自明: 各 Op の **use count** を数えて、0 のものを削除。
制御フロー命令 (Return, Branch, Jump) は use count に関係なく保持。

## IR → Wasm 変換

最適化済み IR を Wasm バイナリに変換する。

- 各 Op → 対応する Wasm 命令 (Add → i32.add, Const → i32.const, etc.)
- Phi ノード → Wasm local 変数 (predecessor が local に書き込み、successor が local.get)
- CFG → Wasm の structured control flow (block/loop/br)

## Direct JIT vs IR JIT

両パスを共存させた:

```
--jit        bytecode → 直接 Wasm (従来)
--jit --ir   bytecode → IR → Constant Folding + DCE → Wasm (新)
```

ベンチマーク比較:

| テスト | Direct JIT | IR JIT | 速度比 |
|--------|-----------|--------|--------|
| 定数畳み込み (sum of (2+3)*(4+5)) | 7.9ms | **4.1ms** | **1.9x** |
| add(a,b) x 10000 | 13.4ms | **8.6ms** | **1.6x** |

IR JIT が速い理由:
- 定数畳み込みで Wasm 内の計算量が減る
- DCE で不要な命令が消えて Wasm コードが小さくなる

今はまだ Constant Folding + DCE だけ。CSE (共通部分式除去) や
LICM (ループ不変式移動) を追加すればさらに効くはず。

## 参考

- [RESEARCH-IR.md](./RESEARCH-IR.md) — V8, JSC, SpiderMonkey の IR 設計調査
- [V8 Turboshaft](https://v8.dev/blog/leaving-the-sea-of-nodes) — Sea of Nodes を捨てた経緯
- [JSC B3](https://webkit.org/blog/5852/introducing-the-b3-jit-compiler/) — LLVM を 5x 速い自前 IR で置換
- [SpiderMonkey MIR](https://firefox-source-docs.mozilla.org/js/MIR-optimizations/index.html) — MIR 最適化パス
