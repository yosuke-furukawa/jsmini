# LEARN-Phase26.md — Math 三角関数 + Date + JIT host import

## やったこと

PLAN-v6 P1 (モダン JS の基本) のうち Math と Date を全モードに広げ、Math.X
を JIT で Wasm 化する。SunSpider math/date 系を動かす足固めも行った。

- VM / TW: Math を **host JS の Math そのもの** で全公開
  (sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh,
  atanh, exp, log, log2, log10, log1p, expm1, hypot, cbrt, fround, clz32,
  imul + 定数 LN2/LN10/LOG2E/LOG10E/SQRT2/SQRT1_2)
- VM / TW: Date を host Date のラッパーで公開
- JIT: Math.X を Wasm 化 (native f64 op / host import で分岐)
- Lexer: 指数表記 `1e10 / 1.5e-3 / 2E+5` 対応 (Math テストの `1e-15` 等)
- SunSpider math/date を 5 本取得し動作確認

## ベンチ結果 (Math.X hot loop)

V8-JITless (`--noopt --no-sparkplug --no-maglev`):

| ベンチ | TW | VM | JIT | JIT/VM |
|---|---|---|---|---|
| Math.sin 50K | 327ms | 395ms | 2.1ms | **187x** |
| Math.sqrt 100K (native) | 650ms | 789ms | 1.3ms | **610x** |
| Math.atan2 30K | 206ms | 248ms | 1.7ms | 147x |
| sin+cos+sqrt 混合 30K | 502ms | 588ms | 3.2ms | 186x |

V8-JIT 有効:

| ベンチ | TW | VM | JIT | JIT/VM |
|---|---|---|---|---|
| Math.sin 50K | 59ms | 18ms | 1.3ms | 14x |
| Math.sqrt 100K | 115ms | 34ms | 0.45ms | **75x** |
| Math.atan2 30K | 36ms | 12ms | 0.67ms | 18x |
| sin+cos+sqrt 混合 30K | 101ms | 33ms | 1.2ms | 26x |

## 教訓

### 1. VM の Math は host Math のラッパー、JIT の高速化はループ dispatch 除去から

```ts
// src/vm/index.ts
vm.setGlobal("Math", { sin: Math.sin, cos: Math.cos, sqrt: Math.sqrt, ... });
```

`Math.sin` の本体は VM でも JIT でも **同じ host Math.sin** を呼ぶ。
JIT が 187x 速くなった主な要因は:

- ループ本体が Wasm 化 → bytecode dispatch (1 命令ごとの switch + push/pop) が消える
- ループ内の `for (i; i < n; ++i)` も Wasm の整数演算で完結
- `s = s + Math.sin(i)` の累算が VM の generic Add 命令経由じゃなくなる

つまり Math.X は単なる leaf function call で、**ホットループのフレームワーク
オーバーヘッドが消えること自体が JIT の主成果**。built-in を追加して JIT で
適切に lowering するだけで、計算アルゴリズム自体を触らなくても 100x 出る。

### 2. host import は Wasm core spec の "穴" を埋める標準パターン

Wasm core には `f64.sqrt / abs / floor / ceil / trunc / min / max / nearest`
しか無い。`sin / cos / log / exp` は仕様に無い。これは Wasm を使う処理系
全部の問題で、解決策は概ね 4 つ:

1. **host import** — JS Math.sin を import として渡す (今回採用)
2. **rust libm を wasm 化** — 純 Wasm 完結、~10-30 KB
3. **musl libc を emcc で wasm 化** — Emscripten の方式
4. **手書き WAT (CORDIC / Taylor)** — 教育的

今回は (1) を採用。Phase 24 の JSPI で作った `WasmBuilder.addImport` を
Suspending 抜きで sync 版として流用するだけで配線は完了した。

### 3. native vs host import で **610x vs 187x** の差

Math.sqrt は f64.sqrt の inline で純 Wasm 完結 → JS↔Wasm 境界 call が
ゼロ。50K iter で 1.3ms。Math.sin は 50K 回 host call が走るので 2.1ms。
**Wasm 内で完結できるなら、host import は最後の手段** という結論。

将来 hand-written WAT を入れる動機はここにある。Math.sin が host call
じゃなくなれば、たぶん sqrt と同等の数値に近づく。

### 4. IR builder は GetProperty で `calleeName` をタグ付けする方が筋がいい

最初は Call IR ノードの後付けで Math.X を検出しようとしたが、CallMethod
ハンドラが globalName="sin" でオーバーライドしてきて取り回しが悪い。

採用したパターン:

```ts
// LoadProperty 作成時に「object が LoadGlobal Math か」を即見て tag
case "GetProperty": {
  const op = createOp(...);
  op.globalName = name;
  const objOp = opById.get(obj);
  if (objOp?.opcode === "LoadGlobal" && objOp.globalName === "Math") {
    op.calleeName = "Math." + name;  // ← ここでタグ
  }
}
```

Call / CallMethod は両方とも `calleeName ?? globalName` を見るように統一。
**IR ノード生成の時点で意味的なタグを埋め込む** ほうが下流の codegen が
分岐しやすい。

### 5. Math.X 用の LoadProperty / LoadGlobal は dead code 扱い

`Math.sin(x)` の bytecode は:

```
LdaGlobal "Math"      → LoadGlobal IR
Dup
GetProperty "sin"     → LoadProperty IR (calleeName="Math.sin")
CallMethod 1          → Call IR (Math.sin に dispatch)
```

Call が `Math.sin` を直接呼ぶように lowering したので、LoadGlobal "Math"
と LoadProperty "Math.sin" は **何も emit しなくていい**。

最初これを emit していて `i32.load expected i32, found f64` エラーで Wasm
コンパイル失敗 → codegen で skip するように修正。`hasPropertyOps` の検出
からも除外しないとメモリ初期化が無駄に走る。

### 6. functionNeedsF64 は Math.X 含む関数を強制 f64 化

Math.X は f64 in / f64 out なので、関数が i32 で済んでいても Math.X が
1 つでも出てきたら全体を f64 に格上げ。これで引数 / ローカル / 演算が
f64 で揃う。Range Analysis (overflow 判定) と並列の判定として追加。

```ts
// src/ir/range.ts
export function functionNeedsF64(irFunc: IRFunction): boolean {
  for (const block of irFunc.blocks) {
    for (const op of block.ops) {
      if (op.opcode === "Call" && op.calleeName?.startsWith("Math.")) return true;
    }
  }
  // 既存: Range Analysis チェック
  ...
}
```

### 7. SunSpider は 5 本中 1 本完動 — 残りは別軸の作業

| ベンチ | 状態 | ブロック要因 |
|---|---|---|
| math-cordic | ✅ 完動 | (整数 >> ベース、Math 呼び出し無し) |
| math-spectral-norm | TW のみ | 配列内 f64 計算で VM/JIT の結果が違う |
| math-partial-sums | VM のみ | TW は chain-assign sloppy global 未対応 |
| date-format-tofte | 全 NG | chain-assign 未対応 |
| date-format-xparb | 全 NG | regex リテラル `/.../` 未対応 (Phase 28) |

Phase 26 の目的「Math/Date を入れて SunSpider が動く足場」としては OK。
実走には別タスクが必要、と整理できた。

### 8. Date は host Date のラッパー、ただし JSString → string 変換は必須

```ts
const DateCtor: any = function(this: unknown, ...args: unknown[]) {
  const a = args.map(unwrapStr);  // JSString → native string
  if (new.target) return new (Date as any)(...a);
  return Date();
};
DateCtor.prototype = Date.prototype;  // インスタンスメソッドは host 経由
```

`new Date("2024-01-15...")` の文字列引数が JSString だと host Date が
"Invalid Date" を返してしまうので、wrapper で変換するのを忘れずに。

## 範囲外にしたもの

- 手書き WAT による Math 高速化 → ベンチで「ボトルネック」と判明したら別フェーズ
- regex リテラル → Phase 28
- chain-assign の sloppy global declaration → 別タスク
- 配列 f64 計算の VM バグ (spectral-norm が VM で違う結果) → 別タスク
- Date.prototype 拡張系 (date-format-tofte の `Date.prototype.formatDate = ...`)
- test262 の `test/built-ins/Math` 取り込み → sparse-checkout 拡張が要る

## 次フェーズ (Phase 27) 予告

PLAN-v6 によると:

- Map / Set (Symbol.iterator 経由で for-of 対応済み)
- WeakMap / WeakSet

Phase 26 と違って **VM 内部の HiddenClass / Symbol 体系との整合** が要る。
host JS の Map/Set をそのまま公開しても、jsmini の JSString や JSObject
が key になるとハマる可能性がある。Phase 25 の JSString → string 変換と
同じ系統の調整が必要。
