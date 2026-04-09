# TODO Phase 22 — Proper OSR (On-Stack Replacement)

## 動機

現在の OSR は「もどき」。ループ途中で JIT を検出しても、**関数を最初から Wasm で再実行** している。
途中まで VM で実行した分が丸ごと無駄になる。

```
VM: i=0 → i=1 → ... → i=4999 (back edge counter 到達)
現在: i=0 から Wasm で再実行 (4999回分の計算が無駄)
目標: i=4999, sum=現在値 を引き継いで Wasm で続行
```

## ステップ

### 22-1: 全 locals を Wasm パラメータとして渡す

- [x] 22-1a: attemptOSR で全 locals を引数に渡す (非数値は 0 にフォールバック)
- [x] 22-1b: compileIRToWasm に osrLocalCount 引数追加、extra locals をパラメータに昇格
- [x] 22-1c: tryOSRViaIR で func.localCount を osrLocalCount として渡す
- [x] 22-1d: OSR ログ追加 (traceTier 時)

### 22-2: ベンチマーク

- [x] 22-2a: f(5M) — VM 895ms → OSR 4.8ms (185x)
- [x] 22-2b: ループ途中 (i=101, sum=5050) から Wasm 引き継ぎ確認
- [x] 22-2c: 全 659 テストパス

## 技術メモ

### 全 locals をパラメータにする方式

Wasm 関数は `(param $p0 i32 $p1 i32 ... $pN i32)` で全ての locals を受け取る。
OSR 時に VM の `frame.locals` をそのまま Wasm の引数として渡す。

Wasm 内ではループの先頭から実行されるが、sum と i が初期値 (0) ではなく
VM から引き継いだ値で始まるので、**途中から再開したのと同じ結果** になる。

厳密にはループヘッダの途中にジャンプするのがベストだが、
全 locals をパラメータで渡せば関数先頭から実行しても正しい結果が得られる。
ループの条件判定でそのまま正しい反復に入る。
