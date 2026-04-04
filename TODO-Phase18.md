# TODO Phase 18 — Inlining in IR

## 動機

Phase 16-17 で IR (CFG + SSA) を導入し、Constant Folding + DCE + 型特殊化を実装した。
しかし関数呼び出しのオーバーヘッドが依然として最大のボトルネック。

```
hot add (10K calls): Direct 7.1ms, IR 6.8ms
```

`add(i, 1)` を1万回呼ぶと、毎回 JS → Wasm ブリッジ + 引数コピー + フレーム生成が走る。
Inlining で Call を消せば、この呼び出しオーバーヘッドが丸ごと消える。

V8 の Maglev が Inlining を重視するのは、Inlining が **他の全最適化を有効化する門番** だから:
- Inlining → 関数の中身が見える → Constant Folding / CSE / LICM が効く
- Inlining しないと関数の境界で最適化が止まる

## 現状

```
今の IR パス:
  bytecode → IR (SSA) → Constant Folding + DCE → Wasm
  Call ノードはそのまま → Wasm の call 命令に変換

Inlining 後:
  bytecode → IR (SSA) → **Inlining** → Constant Folding + DCE → Wasm
  Call ノードが消えて、呼び出し先の中身が展開される
```

## Inlining のアルゴリズム

SSA だから安全にコピペできる:

```
// 呼び出し元の IR                    // Inlining 後
v3 = Call(square, v0)               v50 = Mul(v0, v0)     // square の中身
v4 = Add(v3, v1)                    v4 = Add(v50, v1)     // Call が消えた
```

手順:
1. Call ノードを見つける
2. 呼び出し先の bytecode を取得 → IR に変換
3. 呼び出し先の Param を、呼び出し元の引数に置換
4. 呼び出し先の Return を、Call の結果に置換
5. Op の ID を振り直して呼び出し元の IR にマージ
6. Call ノードを削除

## ステップ

### 18-1: 関連関数の IR 取得

JIT マネージャが知ってる関数 (knownFuncs) の bytecode → IR 変換。

- [ ] 18-1a: `buildIR` で呼び出し先の BytecodeFunction を解決する仕組み
  - Call の対象が定数テーブルの BytecodeFunction なら取得可能
  - `LdaGlobal(name) → Call` パターンで knownFuncs から解決
- [ ] 18-1b: テスト

### 18-2: Inlining パス

IR グラフを走査して、Call ノードをインライン展開する。

- [ ] 18-2a: `src/ir/inline.ts` — Inlining パス
  - Call ノードの検出
  - 呼び出し先の IR を構築
  - Op ID の振り直し (衝突回避)
  - Param → 引数の置換
  - Return → Call 結果の置換
  - ブロックのマージ
- [ ] 18-2b: Inlining 条件の判定
  - 再帰関数はスキップ (無限展開を防ぐ)
  - 関数サイズの上限 (bytecode 命令数 N 以下)
  - 最大 Inlining 深さ
- [ ] 18-2c: テスト (square, add, nested calls)

### 18-3: optimize パイプラインに Inlining を追加

- [ ] 18-3a: Inlining → Constant Folding → DCE の順で実行
  - Inlining 後に新しい定数畳み込みのチャンスが生まれる
- [ ] 18-3b: `--print-ir` で Inlining 前後が見えることを確認
- [ ] 18-3c: テスト

### 18-4: ベンチマーク

- [ ] 18-4a: hot add (10K calls) で効果測定
  - 呼び出しオーバーヘッドが消えるので大幅改善するはず
- [ ] 18-4b: square + sum のパターン
- [ ] 18-4c: Direct JIT vs IR JIT (with Inlining) 比較

## 目標

- `add(a, b)` の Call が消えて `i32.add` になる
- hot add ベンチマークで有意な改善
- 再帰関数 (fib) は Inlining されない (安全)
- Inlining + Constant Folding の相乗効果が見える

## 技術メモ

### SSA だから安全

SSA では全ての値がユニークな ID を持つ。2つの関数の IR を混ぜても:
- 変数名の衝突がない (ID を振り直すだけ)
- スコープ / Environment の管理が不要
- スタック位置のズレがない

### 再帰の扱い

```js
function fib(n) { ... return fib(n-1) + fib(n-2); }
```

fib の中の `Call(fib, ...)` を Inlining すると、展開先にまた `Call(fib, ...)` が出現 → 無限。
再帰関数は Inlining しない (同じ関数名への Call をスキップ)。

### Inlining とスタックトレース

Inlining すると Call が消えるので、エラー発生時のスタックトレースが不正確になる。
V8 は各 IR ノードに source position (元の関数名 + 行番号) を記録して再構築する。
jsmini では今は無視 (教育用エンジンとしてはスタックトレースの品質は優先度低)。

### 期待される効果

```
// before Inlining
for (var i = 0; i < 10000; i++) {
  sum += add(i, 1);    // Call: ブリッジ + フレーム + return
}

// after Inlining
for (var i = 0; i < 10000; i++) {
  sum += i + 1;         // Call が消えて直接演算
}
```

V8 では Inlining が最も重要な最適化とされ、TurboFan/Maglev 両方で積極的に行われる。
