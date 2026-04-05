# TODO Phase 19 — ループを含む関数全体の Wasm 化

## 動機

Phase 16-18 で IR (SSA) + Constant Folding + DCE + Inlining を実装したが、
ベンチマークに有意差が出ない。原因は **ループを含む関数全体が Wasm になっていない** から。

```
fibonacci: 関数全体が Wasm → 再帰も Wasm 内で完結 → 3822x
hot add:   add だけ Wasm、ループは VM → 毎回 JS↔Wasm → 1.2x
```

ループを含む関数全体を Wasm にすれば、ループも Inlining された関数も
全て Wasm 内で完結し、fibonacci と同じレベルの高速化が期待できる。

## 現状

```
今の IR codegen:
  - 線形コード (分岐なし) → Wasm ○
  - if/else (forward branch) → Wasm ○ (基本)
  - ループ (back edge) → Wasm ✗ ← ここが未対応

今の direct JIT (wasm-compiler.ts):
  - bytecode を1命令ずつ Wasm に変換
  - ループは対応済み (bytecode の Jump を Wasm の loop/br に変換)
  - ただし IR の最適化 (Inlining, ConstFold) がない
```

## 課題: CFG → Wasm structured control flow

Wasm には goto がない。`block` / `loop` / `br` / `br_if` の structured control flow のみ。
CFG の任意のグラフを Wasm に変換する必要がある。

```
CFG:                          Wasm:
B0 → B1 (loop header)        block $exit
B1 → B2 (body), B3 (exit)      loop $loop
B2 → B1 (back edge)              ;; B1: 条件チェック
                                  br_if $exit    ;; 条件が false → 脱出
                                  ;; B2: ループ本体
                                  br $loop       ;; back edge → ループ先頭
                                end
                              end
```

### アルゴリズム: Stackifier

LLVM が Wasm バックエンドで使う方式を採用。

**ルール:**
1. ブロックをトポロジカル順に並べる (back edge を無視して依存順)
2. 下向きの矢印 (forward edge) → `block` + `br` で脱出
3. 上向きの矢印 (back edge) → `loop` + `br` で先頭に戻る

```
CFG:                          Wasm:
B0 → B1 (forward)            ;; B0 の中身
B1 → B2, B3 (forward)        block $exit
B2 → B1 (back edge)            loop $loop
                                  ;; B1: 条件
                                  br_if $exit
                                  ;; B2: 本体
                                  br $loop
                                end
                              end
                              ;; B3: 出口
```

## ステップ

### 19-1: ループの検出

IR の CFG からループ構造を検出する。

- [x] 19-1a: DFS で back edge 検出
- [x] 19-1b: ループヘッダ + ループ本体 (Set) + 出口ブロックの特定
- [x] 19-1c: トポロジカル順序 (Block ID 昇順)
- [x] 19-1d: テスト (5 tests: linear, if/else, for loop, nested loop, topo order)

### 19-2: Phi → Wasm local の変換 ✅

- [x] 19-2a: Phi の predecessor ごとに local.set を挿入 (init + back edge + forward edge)
- [x] 19-2b: Phi の使用箇所を local.get に置換 (emitValueOrConst)
- [x] 19-2c: Phi input 値も local に割り当て

### 19-3: Stackifier — CFG → Wasm structured control flow

IR のブロックをトポロジカル順に配置し、Wasm の block/loop/br に変換する。

- [x] 19-3a: トポロジカルソート (Block ID 昇順)
- [x] 19-3b: back edge → `loop` + `br`、control stack で depth 計算
- [x] 19-3c: forward edge → `block` + `br_if` (ループ出口)
- [x] 19-3d: ブロックごとに Op → Wasm 命令出力 (emitOp 再利用)
- [x] 19-3e: ネストしたループ対応 (2パス SSA builder + forward edge phiWrites)
- [x] 19-3f: テスト (for loop, nested loop, loop+inlining — 3 tests)

### 19-4: ベンチマーク

- [x] 19-4a: bench.ts に IR JIT 列追加
- [x] 19-4b: hot add/mul をループごと関数に包む (現実的なパターン)
- [x] 19-4c: 結果:
  - hot add: IR 102x (Direct 100x)
  - for loop sum: IR 79x (Direct 77x)
  - nested loop: IR 80x (Direct 76x)
  - IR vs Direct: ~1.0-1.05x (ほぼ同等)

## 目標

- ループを含む関数全体が Wasm にコンパイルされる
- hot add ベンチで有意な改善 (ループ + Inlining が Wasm 内で完結)
- IR の最適化 (Inlining + ConstFold + DCE) の効果が数字に出る
- fibonacci と同レベルの高速化

## 技術メモ

### Wasm の structured control flow

```wasm
;; block: forward branch (脱出)
block $label
  ...
  br_if $label    ;; 条件が true → block の end にジャンプ
  ...
end

;; loop: back edge (繰り返し)
loop $label
  ...
  br_if $label    ;; 条件が true → loop の先頭にジャンプ
  ...
end

;; block + loop の組み合わせ (典型的な for ループ)
block $exit
  loop $continue
    ;; 条件チェック → false なら $exit
    br_if $exit
    ;; 本体
    br $continue   ;; ループ先頭に戻る
  end
end
```

### Phi → local の変換

SSA の Phi は「どのパスから来たかで値を選ぶ」。Wasm では local 変数で表現:

```
IR:                              Wasm:
B1:                              loop $loop
  v2 = Phi(B0:v0, B2:v5)          ;; v2 は local $sum
  ...                              local.get $sum    ;; Phi の代わり
B2:                                ...
  v5 = Add(v2, v3)                 ;; 更新
  Jump → B1                        local.set $sum    ;; Phi input を書き込み
                                   br $loop
```

### direct JIT との共存

```
--jit        → direct (bytecode → Wasm)    ← ループ対応済み
--jit --ir   → IR (bytecode → IR → Wasm)   ← Phase 19 でループ対応
```

direct JIT は引き続き残す。IR パスがフォールバックする先としても必要。
