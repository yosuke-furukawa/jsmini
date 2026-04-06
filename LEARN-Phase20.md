# LEARN-Phase20.md — Range Analysis + Overflow Safety + 配列 IR 対応

## Range Analysis: コンパイル時に i32/f64 を決定

### 問題: i32 overflow で結果が壊れる

jsmini の IR JIT は全演算を i32 で行っていたが、i32 の範囲 (-2^31 ~ 2^31-1) を超えると結果が壊れる。

```js
function addUp(n) {
  var sum = 0;
  for (var i = 0; i < n; i++) { sum = sum + i * i; }
  return sum;
}
addUp(50000);
// 正解: 41665416675000
// i32:  -61063496 (overflow で壊れる)
```

### 3 つのアプローチとトレードオフ

| アプローチ | 方法 | コスト | 採用 |
|---|---|---|---|
| 実行時チェック | overflow したら f64 に切替 | 毎回6命令 (jo/branch) | V8 (ネイティブ CPU の jo 命令が使える) |
| Range Analysis | コンパイル時に [min, max] を追跡して判定 | 0命令 (コンパイル時のみ) | jsmini ✅ |
| 全部 f64 | 常に f64 で計算 | 全演算が f64 (遅い) | 安全だが遅い |

**Wasm では CPU の overflow フラグ (jo 命令) が使えない**ので、V8 方式の実行時チェックは重い。
Range Analysis ならコンパイル時に決定でき、実行時のコストはゼロ。

### Range 伝播の仕組み

各 IR Op に `range: { min, max }` を付与し、fixpoint iteration で伝播:

```
Const(10)       → [10, 10]
Param(0)        → [-2^31, 2^31)     (最悪ケース)
Add(a, b)       → [a.min + b.min, a.max + b.max]
Mul(a, b)       → [min(全組合せ), max(全組合せ)]  (符号考慮)
Phi(a, b)       → [min(a.min, b.min), max(a.max, b.max)]
```

### ループカウンタの Range

ループの上限が定数か Param かで大きく変わる:

```js
// 定数上限 → range 確定
for (var i = 0; i < 100; i++) sum += i;
// i: [0, 99], sum: [0, 4950] → i32 安全

// Param 上限 → 最悪ケース
for (var i = 0; i < n; i++) sum += i * i;
// n: [-2^31, 2^31), i*i: [0, 2^62) → f64 昇格
```

### 学び

- Range Analysis は**保守的 (conservative)**。「安全と証明できなければ f64」なので、実際には i32 で収まるケースも f64 になることがある
- fixpoint iteration はループの Phi ノードで range が安定するまで回す。実用上は 2-3 回で収束
- V8 の Turbofan は Range Analysis をやった上で、さらに実行時チェックも入れる (二段構え)。jsmini は教育目的なのでコンパイル時判定のみ

## f64 昇格の codegen

### 関数単位で i32/f64 を切り替え

`functionNeedsF64(irFunc)` が true なら、その関数の全 params/locals/results を f64 にする。

```
;; i32 モード (安全)
(func $f (param i32 i32) (result i32)
  (i32.add (local.get 0) (local.get 1)))

;; f64 モード (overflow 危険)
(func $f (param f64 f64) (result f64)
  (f64.add (local.get 0) (local.get 1)))
```

Op 単位ではなく関数単位にしたのは:
- Wasm の local は型が固定なので、同じ local を i32/f64 で使い分けられない
- 関数境界で型変換 (i32→f64, f64→i32) すれば済む
- 実装がシンプル

### Const/Param の emit 順序問題

f64 昇格実装時に発見したバグ: Const と Param の emit タイミングが Wasm スタック順序を壊していた。

```js
function smallAdd(a, b) { return (a % 100) + (b % 100); }
// 期待: a % 100 → b % 100 → add
// バグ: 100 % a → 100 % b → add (Const が先に push されていた)
```

**原因**: emitOp が Const/Param を即座に Wasm スタックに push していた。
Wasm はスタックマシンなので、push 順序 = 演算の引数順序。

**修正**: Const/Param の emitOp は何もしない。値が使われる場所 (emitLoadValue) でインラインに出力。

```
// 修正前: emitOp(Const(100)) → stack: [100]  ← ここで push してしまう
// 修正後: emitOp(Const(100)) → 何もしない
//         emitLoadValue(Const(100)) → その場で f64.const 100 を出力
```

### 学び

- SSA の IR は「値の定義」と「値の使用」が分離している。スタックマシン (Wasm) にマッピングする際、定義時に push するのではなく、使用時にインラインで出力する方が安全
- これは register マシンでは問題にならない (レジスタに入れるだけ)。Wasm のスタックマシン特有の落とし穴

## 配列の IR 対応

### WasmGC の配列は bounds check が自動

WasmGC の `array.get` / `array.set` は Wasm ランタイムが bounds check を保証する。範囲外アクセスは trap。jsmini 側で判定不要。

```wat
;; array.get は自動で bounds check
(array.get $arr (local.get $a) (local.get $idx))
;; idx が範囲外なら trap — jsmini で if 文を入れる必要なし
```

V8 はネイティブ機械語で Range Analysis + bounds check elimination をやるが、Wasm 経由ではそもそも Wasm の安全性保証として bounds check が入る (省略不可)。

### IR opcode: ArrayGet / ArraySet / ArrayLength

```
v5 = ArrayGet(v0, v1)      // arr[idx]
v6 = ArraySet(v0, v1, v2)  // arr[idx] = val
v7 = ArrayLength(v0)       // arr.length
```

Builder が `GetPropertyComputed` → `ArrayGet`、`SetPropertyComputed` → `ArraySet`、`GetProperty("length")` → `ArrayLength` に変換。

### JS ↔ WasmGC 配列変換

JitManager が JS 配列と WasmGC 配列の相互変換を担当:

```
JS → Wasm: [1, 2, 3] → array.new_fixed $arr 3 (i32.const 1) (i32.const 2) (i32.const 3)
Wasm → JS: array → for i in 0..len: arr[i] = array.get $arr i
```

### 学び

- WasmGC の配列は「安全だけど遅い」— bounds check は省略できないので、V8 のネイティブ配列より遅い
- でも「安全に動く」ことが最優先。最適化は後から
- quicksort が IR パスで 7.3x は、配列が IR に載ったことで JIT 対象になった成果

## TCO (Tail Call Optimization) について

Phase 20 では実装しなかったが、IR があれば可能。トレードオフを整理した。

### スタックトレースが消える

TCO は末尾再帰をループに変換するので、再帰のスタックフレームが消える:

```
// TCO なし: fact(5) → fact(4) → fact(3) → ... (全フレーム見える)
// TCO あり: fact(5) → ループ (途中のフレームが消える)
```

### 各エンジンの判断

- **Safari (JSC)**: ES2015 の Proper Tail Calls を唯一実装。スタックトレースは消える
- **V8 / SpiderMonkey**: スタックトレースが壊れるのを嫌って未実装
- **Wasm**: `return_call` 命令がある (tail call proposal)

### 学び

- TCO は「正しさ vs デバッグ容易性」のトレードオフ
- jsmini で実装するなら、Playground で on/off トグルを付けてトレードオフを可視化するのが教育的に面白い
- fib は `fib(n-1) + fib(n-2)` の `+` がある時点で末尾再帰じゃない。末尾再帰版 `fib(n, a, b)` に書き換えが必要
