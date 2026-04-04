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

### アルゴリズムの選択肢

1. **Stackifier** (LLVM が使う方式)
   - ブロックをトポロジカル順に配置
   - back edge → `loop` + `br`、forward edge → `block` + `br`
   - シンプルで jsmini に適している

2. **Relooper** (Emscripten が使った方式)
   - 任意の CFG を structured control flow に変換
   - 複雑だが汎用的

3. **直接パターンマッチ** (jsmini 向け)
   - for ループ: `B0 → B1(header) → B2(body) → B1` のパターンを検出
   - if/else: `B0 → B1, B2 → B3` のパターンを検出
   - 対応できないパターンは direct JIT にフォールバック

jsmini では (3) の直接パターンマッチが最もシンプルで教育的。

## ステップ

### 19-1: ループの検出

IR の CFG からループ構造を検出する。

- [ ] 19-1a: back edge の検出 (successor が自分より前のブロック)
- [ ] 19-1b: ループヘッダ + ループ本体 + 出口ブロックの特定
- [ ] 19-1c: テスト

### 19-2: Phi → Wasm local の変換

ループヘッダの Phi ノードを Wasm のローカル変数に変換する。

- [ ] 19-2a: Phi の predecessor ごとに local.set を挿入
  - B0 (entry) → local.set で初期値を書く
  - B2 (back edge) → local.set で更新値を書く
- [ ] 19-2b: Phi の使用箇所を local.get に置換
- [ ] 19-2c: テスト

### 19-3: CFG → Wasm structured control flow

IR のブロック構造を Wasm の block/loop/br に変換する。

- [ ] 19-3a: for ループパターンの認識と変換
  ```wasm
  (local $sum i32) (local $i i32)
  ;; B0: 初期化
  i32.const 0
  local.set $sum
  i32.const 0
  local.set $i
  ;; B1: ループ
  block $exit
    loop $loop
      ;; 条件チェック
      local.get $i
      local.get $n
      i32.lt_s
      i32.eqz
      br_if $exit
      ;; B2: 本体 (Inlining 済みの add(i,1) = i+1)
      local.get $sum
      local.get $i
      i32.const 1
      i32.add        ;; add(i, 1) → i + 1
      i32.add        ;; sum + (i + 1)
      local.set $sum
      ;; i++
      local.get $i
      i32.const 1
      i32.add
      local.set $i
      br $loop
    end
  end
  ;; B3: return sum
  local.get $sum
  ```
- [ ] 19-3b: if/else パターン (forward branch) の変換
- [ ] 19-3c: ネストしたループ / if の対応
- [ ] 19-3d: テスト

### 19-4: ベンチマーク

- [ ] 19-4a: hot add (10K calls) — ループ + Inlining が Wasm 内で完結
  - 期待: Direct JIT と同等以上、VM の 10x 以上
- [ ] 19-4b: for loop sum — 単純ループが Wasm 内で完結
- [ ] 19-4c: nested loop — ネストしたループ
- [ ] 19-4d: Inlining + ループの相乗効果
  - `sum += add(i, 1)` → ループ内で `i + 1` に展開 + ループ全体が Wasm

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
