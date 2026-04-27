# TODO Phase 26 — Math 三角関数 + Date

## 動機

PLAN-v6 P1 (モダン JS の基本) のうち、Math と Date は **ネイティブ JS の実装を
そのまま delegate** できるので軽い。SunSpider の math/date 系ベンチを動かす
ための足固め。

現状 (Phase 25 時点):

```ts
// src/vm/index.ts
vm.setGlobal("Math", {
  floor, ceil, round, abs, min, max,
  sqrt, pow, log, random, PI, E,
  sign, trunc,
});
// → 三角関数、log2/log10、hypot 等が無い
// → Date 自体が globals に無い
```

## 検証したいこと

1. SunSpider math/date 系ベンチ (`math-cordic.js`, `math-spectral-norm.js`,
   `date-format-tofte.js` 等) が jsmini で実行できるか
2. Math.sin / Date.now の hot path が JIT でどう扱われるか
3. test262 の Math 系テストが追加 + 通るか (要 sparse-checkout 拡張)

## ステップ

### 26-1: Math 三角関数 + 拡張

- [ ] 26-1a: VM (`src/vm/index.ts`): Math wrapper に追加
      `sin, cos, tan, asin, acos, atan, atan2`
- [ ] 26-1b: VM: 拡張系も追加
      `exp, log2, log10, log1p, expm1, hypot, cbrt, sinh, cosh, tanh, asinh, acosh, atanh`
- [ ] 26-1c: VM: 定数も追加
      `LN2, LN10, LOG2E, LOG10E, SQRT2, SQRT1_2`
- [ ] 26-1d: TW (`src/interpreter/evaluator.ts`): 同等に追加
- [ ] 26-1e: テスト: `Math.sin(0) === 0`, `Math.atan2(1,1) === Math.PI/4` 等を
      TW/VM 両方で検証

### 26-2: Date

- [ ] 26-2a: VM: `Date` グローバルを追加
      - `Date()` / `new Date()` → 現在時刻
      - `new Date(ms)` → ms から
      - `new Date(year, month, day, ...)` → 個別フィールド
      - `Date.now()` → 現在時刻 ms
- [ ] 26-2b: VM: インスタンスメソッドを delegate
      `getTime, getFullYear, getMonth, getDate, getDay, getHours, getMinutes,
      getSeconds, getMilliseconds, valueOf, toString, toISOString`
- [ ] 26-2c: TW 側も同様に追加
- [ ] 26-2d: VM の HiddenClass 経由のオブジェクトと Date インスタンスの
      共存に注意 (Date インスタンスはネイティブ Date を返す方針)
- [ ] 26-2e: テスト: `Date.now()` が数値を返す、`new Date(0).getFullYear() === 1970` 等

### 26-3: JIT host import for Math

Phase 24 で `WasmBuilder.addImport` を作った。これを sync 版で流用 (Suspending
ラップ無し) して Math.sin 等を Wasm から host import 経由で呼ぶ。
ハンドライト WAT による高速化は将来フェーズに先送り。

- [ ] 26-3a: Wasm native でカバーできる Math op を inline 化:
      `sqrt → f64.sqrt`, `abs → f64.abs`, `floor → f64.floor`,
      `ceil → f64.ceil`, `trunc → f64.trunc`, `min → f64.min`, `max → f64.max`
- [ ] 26-3b: それ以外 (`sin, cos, tan, asin, acos, atan, atan2, exp, log,
      log2, log10, pow, hypot, cbrt, ...`) は host import で `call $__math_xxx`
- [ ] 26-3c: IR で `Math.X(args)` パターンを検出する仕組み:
      compiler/IR builder で `LdaGlobal "Math" → GetProperty "sin" → Call`
      を `MathCall(name, args)` に縮約する
- [ ] 26-3d: codegen: `MathCall` を inline (native op) または
      `call $__math_X` import に lowering
- [ ] 26-3e: JitManager で imports に host Math 関数を渡す
      (Phase 24 JSPI と同パス、Suspending 不要)
- [ ] 26-3f: tier log 確認: hot loop 内 `Math.sin(x)` が Wasm 化される
- [ ] 26-3g: ベンチ: `for (i; i < N; i++) sum += Math.sin(i)` の VM vs JIT 比較

### 26-4: SunSpider math/date 試行

- [ ] 26-4a: SunSpider の `math-cordic.js` を取得して jsmini で実行
- [ ] 26-4b: `math-spectral-norm.js`, `math-partial-sums.js` を試行
- [ ] 26-4c: `date-format-tofte.js`, `date-format-xparb.js` を試行
- [ ] 26-4d: 動作したベンチで TW vs VM vs JIT の時間比較
      (V8-JITless 条件: `--noopt --no-sparkplug --no-maglev`)

### 26-5: test262 (オプション)

- [ ] 26-5a: test262 を sparse-checkout で `test/built-ins/Math` と
      `test/built-ins/Date` を pull (要ユーザー確認、~数百テスト追加)
- [ ] 26-5b: runner の TEST_DIRS に Math/Date を追加
- [ ] 26-5c: pre/post 計測

### 26-6: まとめ

- [ ] 26-6a: LEARN-Phase26.md に結果を記録 (host import 方針の根拠を含む)
- [ ] 26-6b: ベンチ結果を BENCHMARK.md に追記

## 期待される効果

| 項目 | 期待 |
|---|---|
| Math 三角関数 | SunSpider math-cordic 等が動く |
| Math.log2, hypot 等 | モダンなユースケースを unblock |
| Date 全般 | パフォーマンス計測コードが動く (start = Date.now()) |
| test262 | Math/Date 取り込んだら +N テスト (要計測) |

## 技術メモ

### Math は薄いラッパーで OK

ネイティブ Math のメソッドは数値しか扱わないので、JSString とのラッパー処理は
不要。`Math.sin` をそのまま参照すればよい。

```ts
vm.setGlobal("Math", {
  ...既存,
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  atan2: Math.atan2,
  exp: Math.exp, log2: Math.log2, log10: Math.log10,
  log1p: Math.log1p, expm1: Math.expm1,
  hypot: Math.hypot, cbrt: Math.cbrt,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  LN2: Math.LN2, LN10: Math.LN10,
  LOG2E: Math.LOG2E, LOG10E: Math.LOG10E,
  SQRT2: Math.SQRT2, SQRT1_2: Math.SQRT1_2,
});
```

### Date は new ありなし両対応に注意

`Date()` (new なし) は現在時刻文字列を返す。`new Date()` は Date オブジェクトを
返す。両方サポートする必要がある。

```ts
const DateCtor: any = function(this: unknown, ...args: unknown[]) {
  // new Date() でも Date() でも、ネイティブ Date インスタンスを返す
  if (args.length === 0) return new Date();
  if (args.length === 1) return new Date(args[0] as any);
  return new (Date as any)(...args);
};
DateCtor.now = Date.now;
DateCtor.parse = Date.parse;
DateCtor.UTC = Date.UTC;
```

ネイティブ Date インスタンスは jsmini の HiddenClass オブジェクトではなく
ホスト JS の Date。`getTime()` 等は通常の prototype 経由で呼べるはず。

### JIT 方針: 当面は host import、将来 hand-written WAT

Wasm core spec には sin/cos 等の三角関数は含まれない (sqrt/floor 等の
丸め系のみ)。選択肢:

1. **host import** (今回採用): `WebAssembly.Module` の import に host Math.sin
   を渡す。Phase 24 JSPI と同じ枠組みで Suspending を外すだけ。実装ほぼ 0。
   コスト: JS↔Wasm 境界 (数 ns/call)。
2. **rust libm を wasm 化**: 純 Wasm で完結、~10-30 KB。Rust toolchain が必要。
3. **musl libm を emcc で wasm 化**: Emscripten の方式。同上。
4. **WAT で手書き**: CORDIC/Taylor で sin/cos を実装。教育的価値あり、~数 KB。

教育プロジェクトとして筋がいいのは 4 だが、ベンチで「ここがボトルネック」と
判明してから着手する。当面は 1 で動かす。

### 範囲外 (Phase 26 ではやらない)

- Date の locale 周り (`toLocaleString` 等) → ホストの実装を delegate するだけで
  特に追加実装は不要。テストは省略。
- `Date.prototype.setX` 系 mutator → ベンチに必要になったら追加。
- Intl 全般 → 別フェーズ。
- Math/Date の手書き Wasm 実装 → 将来フェーズ (上記 JIT 方針参照)。
