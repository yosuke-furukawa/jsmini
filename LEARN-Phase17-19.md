# LEARN-Phase17-19.md — Type Specialization + Inlining + Stackifier

## Phase 17: Type Specialization in IR

### 型フィードバックを IR に接続

Phase 5 で実装した型フィードバック (feedback.ts) を IR パスに繋いだ。
Direct JIT は bytecode → Wasm 変換時に i32/f64 を選んでいたが、IR パスでも同じことを IR レベルでやる。

```
buildIR(func, { feedback })
→ Param(0) の type を feedback の argTypes から設定
→ Add(i32, i32) → type: i32, Add(f64, f64) → type: f64
```

### TypeGuard ノード

型の仮定を IR に明示的に記録する。V8 の CheckInt32 / CheckFloat64 に相当。

```
v0 = Param(0)                    // 型不明
v1 = TypeGuard(v0, "i32")       // ← 型ガード: i32 でなければ deopt
v2 = Add(v1, Const(1))          // i32 が確定 → i32.add を安全に使える
```

jsmini では TypeGuard の実行時チェックは JitManager.executeWasm() が担当。
Wasm に入る前に引数の型をチェックし、失敗したら deoptimize() で VM にフォールバック。

### 学び

- 型特殊化は「投機 (speculation)」— 型フィードバックから「多分 i32」と推測して最適化
- 推測が外れたら deopt — jsmini は Phase 5 から deopt の仕組みがあったので、IR でも同じ経路で動いた
- IR パスの実行速度は Direct JIT と同等。差が出るのは Inlining で Call が消えたとき

## Phase 18: Inlining in IR

### SSA だから安全にコピペできる

Inlining は「呼び出し先の IR を呼び出し元にコピペする」操作。
SSA (各値がユニーク ID) だから変数の衝突がない。

```
// 呼び出し元                      // Inlining 後
v3 = Call(square, v0)            v50 = Mul(v0, v0)    // square の中身
v4 = Add(v3, v1)                 v4 = Add(v50, v1)    // Call が消えた
```

手順:
1. 呼び出し先の bytecode → IR に変換
2. Op ID を振り直して衝突回避
3. Param → 引数 ID に置換
4. Return → Call の結果に置換
5. Call ノードを削除

### ネストした Inlining のバグ

`add3(add(a,b),c)` のような2段階のインライン展開で3つのバグがあった:

1. **calleeName/globalName がコピーされない** — Op を複製するとき calleeName フィールドを落としてた。
   ネストした関数参照が解決できなくなる
2. **Phi inputs が書き換わらない** — Call 結果の置換が caller ブロック内の ops だけで、他ブロックの
   Phi inputs を書き換えてなかった。ループ内の Inlining で致命的
3. **buildIROptions に knownFuncs がない** — Inlining で呼び出し先の IR を構築するとき、knownFuncs
   を渡してなくて、ネストした関数参照が LoadGlobal("undefined") になった

教訓: **Inlining は「コピペするだけ」に見えて、参照の書き換えが全箇所に波及する。**

### V8 が Inlining を最重視する理由

Inlining は「他の全最適化を有効化する門番」:
- Inlining 前: 関数の境界で最適化が止まる
- Inlining 後: 関数の中身が見える → Constant Folding / CSE / LICM が効く

jsmini のベンチでも、cube(square(x)) の2段階 Inlining で IR が Direct JIT より 1.47x 速かった。
Call のオーバーヘッド削減だけでなく、Inlining 後の最適化チャンスが大きい。

## Phase 19: Stackifier — ループの Wasm 化

### 動機の変遷

最初の動機は「ループを含む関数全体が Wasm になっていないから hot add が遅い」だったが、
調査の結果「ループの繰り返し回数 (back-edge counter) でホットさを判定してない」が正しい原因だった。

V8 は:
1. 関数呼び出し回数 (invocation count) → Sparkplug → Maglev
2. **ループの back-edge 回数** → OSR で Maglev/TurboFan

jsmini は 1 しかなかった。Phase 11 の OSR (back-edge counter) を IR パスに繋いで解決。

### 2 パス SSA Builder

1パス方式ではネストしたループで Phi の値が正しく伝播しなかった。
内側ループで更新された変数が外側のブロックに反映されない問題。

2パス方式:
- **パス 1**: ブロック構造 + エッジを構築。合流点 (predecessors >= 2) に Phi を予約
- **パス 2**: 抽象解釈。Phi があるブロックに入ったら locals を Phi ID で上書き
- **パス 3**: Phi の inputs を predecessor の出口ローカルで埋める

V8 の Maglev も同じアプローチ。Phi を先に作ってから本体を処理する。

### Stackifier: CFG → Wasm structured control flow

Wasm には goto がない。`block` / `loop` / `br` / `br_if` のみ。
CFG の任意のグラフを Wasm に変換する必要がある。

LLVM が Wasm バックエンドで使う Stackifier 方式:
1. ブロックをトポロジカル順 (依存順) に並べる
2. **下向きの矢印** (forward edge) → `block` + `br` で脱出
3. **上向きの矢印** (back edge) → `loop` + `br` で先頭に戻る

```
B0 (init)               ;; B0 の中身
B1 (loop header)         block $exit
B2 (loop body)             loop $loop
B3 (exit)                    ;; B1: 条件チェック
                             br_if $exit
                             ;; B2: 本体
                             br $loop
                           end
                         end
                         ;; B3: 出口
```

### Phi → Wasm local

SSA の Phi は Wasm のローカル変数で表現:
- **初期値**: 関数の先頭で `local.set`
- **更新値**: back edge / forward edge の直前で `local.set`
- **読み取り**: `local.get`

forward edge でも phiWrites を出力する必要がある (ネストしたループで重要)。

### 不要な Phi の除去

`Phi(B0:v8, B2:self)` — 自己参照のみの Phi は実質 `v8` と同じ。
ループ内で変化しない変数 (`var seven = 3 + 4`) に発生する。
自己参照を無視して全入力が同じ値なら、Phi を削除して直接参照に置き換え。

### 別ブロック参照の local 割り当て

use count > 1 だけでなく、**定義ブロックと使用ブロックが異なる** 値も local に格納する必要がある。
Constant Folding で Phi が除去された後、定数が別ブロックから直接参照されるケースで必要。

### LoadGlobal / StoreGlobal

トップレベルの `<script>` では変数がグローバル (`StaGlobal` / `LdaGlobal`)。
IR に `LoadGlobal` / `StoreGlobal` Op を追加し、codegen で Wasm local に変換。
これによりトップレベルのループも IR に載るようになった。

ただし `<script>` 内の関数定義 (`LdaConst(BytecodeFunction)`) は Wasm に変換できないので、
Call や非数値 Const が残る IR は安全にフォールバック (direct JIT)。

### ベンチマーク結果

| Benchmark | VM | Direct JIT | IR JIT |
|---|---|---|---|
| for loop sum (10K) | 417ms | 77x | **79x** |
| nested loop (100x100) | 477ms | 76x | **80x** |
| inlining: cube(square(x)) | 153ms | 1.25x | **1.84x** (IR 1.47x faster) |
| smi arithmetic | 86ms | 87x | 77x |
| LICM | 14553ms | 2081x | 1866x |

IR の Inlining 効果が明確に出たのは `cube(square(x))` パターン。
2段階の関数呼び出しが `x * x * x` に展開されて 1.47x 高速化。

ループ系は IR と Direct でほぼ同等。差が出るのは Inlining + ループの組み合わせ。
実行速度は同等で、ベンチの数字差はコンパイル時間の違い (IR パスは 3x 遅い)。

### V8 がネイティブ機械語にこだわる理由

i32 overflow の検知:
- **CPU**: `add` + `jo` (overflow flag チェック) — **ゼロコスト** (XOR ゲート1個)
- **Wasm**: overflow flag にアクセスできない → ソフトウェアで 6 命令のチェック

CPU の ALU は加算の副作用として overflow flag を自動計算する
(carry-in XOR carry-out)。`jo` はそのフラグを読むだけ。
Wasm はこれを抽象化して隠すので、自力で判定するしかない。

jsmini の Phase 20 では Range Analysis でコンパイル時に i32/f64 を決定し、
実行時チェックを不要にするアプローチを取る。
