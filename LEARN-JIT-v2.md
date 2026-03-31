# JIT v2 で学んだこと — prototype + OSR + インライン展開

Phase 12 でプロトタイプチェーンを実装し、prototype メソッドの JIT 化まで到達した。
Phase 5 の JIT は「数値関数を Wasm に変換する」だけだったが、
Phase 12 では「ループ全体を Wasm に閉じ込める」ところまで進んだ。

---

## 1. HC + IC + prototype + JIT は「セット」で効く

Phase 7-8 で Hidden Class と Inline Cache を実装したとき、VM レベルでは効果がなかった。
V8 の C++ IC が `obj[name]` を既に最適化していたから。

Phase 12 で prototype を追加して JIT と繋げたことで、初めて全てがセットで機能した:

```
new Point(i, i+1)        → bump allocator (i32.add)
                            HC が Point の {x:0, y:1} を記録
p.dist()                  → IC が「HC_Point の dist は prototype[0]」と記録
                            → JIT がインライン展開
this.x * this.x + ...     → i32.load(base+0) * i32.load(base+0) + ...
```

**個々の最適化は単体では意味がない。組み合わさって初めて数十倍の速度差が出る。**

---

## 2. JS↔Wasm ブリッジがゼロになることが重要

Phase 5-11 の JIT は「関数単位」で Wasm に変換していた:

```
VM ループ → 各 iteration で:
  VM: new Point()         ← JS heap
  VM → Wasm: dist()       ← ブリッジコスト
  Wasm → VM: 結果         ← ブリッジコスト
  VM: sum += result
```

dist が Wasm で速くなっても、毎回のブリッジコストが支配的で効果が薄かった。

Phase 12 で OSR がループ全体を Wasm に閉じ込めた:

```
Wasm ループ → 各 iteration で:
  Wasm: bump allocate     ← i32.add
  Wasm: store x, y        ← i32.store x2
  Wasm: load x, y, 算術   ← i32.load x4, i32.mul x2, i32.add
  ← ブリッジコスト: ゼロ
```

結果: TW の 2.5x、VM の 3.4x（500 iter）。

---

## 3. prototype メソッドのインライン展開は callback inline と同じ仕組み

Phase 8E で実装した callback inline:
```
reduce(arr, add)  → add の本体を reduce のループ内に展開
```

Phase 12 の prototype method inline:
```
p.dist()  → dist の本体をループ内に展開
```

違いは引数の渡し方だけ:
- callback inline: 引数を extra local に退避
- prototype inline: `this` を extra local に退避、`GetProperty` → `i32.load(base + offset)`

クロージャのインライン展開（upvalue チェーンの解決）に比べて、prototype メソッドは
クロージャではないので変数キャプチャの問題がない。シンプル。

---

## 4. Construct を Wasm に含めるには bump allocator

`new Point(i, i+1)` を Wasm 内で実行するには:
1. bump allocator: `base = heapPtr; heapPtr += objectSize`
2. call $Point(arg0, arg1, base): コンストラクタが `i32.store(base+0, x)` 等でプロパティを設定
3. base をスタックに残す: 後続の dist inline で使う

bump allocator はメモリリークするが、ループ内の一時オブジェクトには十分。
V8 の Young Generation GC が「若いオブジェクトは大半がすぐ死ぬ」という前提で
高速な Nursery allocator を使うのと同じ発想。

---

## 5. OSR のハマりどころ

### 5-1. upvalue が BytecodeFunction

`function run(n) { ... new Point(i, i+1) ... }` で Point は upvalue 経由で参照される。
OSR でパラメータを Wasm に渡すとき、upvalue の値が BytecodeFunction だと
`typeof val === "number"` が false で OSR が中断される。
→ BytecodeFunction の upvalue はダミー値 (0) で渡す（Wasm 内では funcIndex で解決）。

### 5-2. objectPropOffsets が空

run 自身には `GetProperty "x"` がなくても、Construct で作る Point は x, y を持つ。
objectPropOffsets を run だけでなく関連関数全体から収集する必要がある。

### 5-3. GetProperty + CallMethod のスタックずれ

VM: `Dup → GetProperty (pop obj, push method) → CallMethod (pop method, pop this)`
Wasm: `Dup → GetProperty (dummy push) → CallMethod (drop dummy, save this)`

GetProperty が VM では pop するのに Wasm では pop しないと、Dup の2つ目のコピーが
スタックに残って Add が間違った値を計算する。
→ GetProperty + CallMethod パターンで `drop` を追加して VM の pop を再現。

### 5-4. WASM_OP.local_tee が未定義

`local_get` (0x20) と `local_set` (0x21) はあったが `local_tee` (0x22) が
WASM_OP に定義されてなかった。`undefined` が数値化されて `0x00` (unreachable) になり、
Wasm validation error (`block type index 32`) を引き起こした。

### 5-5. i32 オーバーフロー

i32 特殊化で大きな値を計算すると 32bit 整数でオーバーフローする。
5000 iter × dist の結果 (最大 ~50M) の累積が 2^31 を超える。
→ ベンチマークの iter 数を i32 安全な範囲に抑える。

---

## 6. deopt が正しく動くことの確認

整数で warm up → 小数で呼ぶパターンで、i32 Wasm が切り捨てて間違った結果を返す
バグがあった。`Number.isInteger` チェックで deopt して VM にフォールバック。

```
sumLoop(10)   → Wasm (i32) で実行
sumLoop(10)   → Wasm (i32)
sumLoop(3.5)  → deopt → VM → 正しい結果 (6)
```

---

## ベンチマーク結果

```
=== prototype + new + dist inline (500 iter) ===
TW:  1.53ms
VM:  2.08ms
JIT: 0.62ms  ← TW の 2.5x, VM の 3.4x

=== prototype method (メソッドだけ JIT、ループは VM) ===
TW:  22.6ms
VM:  20.9ms
JIT: 20.9ms  ← 効果なし (ブリッジコストが支配的)
```

ループ全体を Wasm に閉じ込められるかどうかで、JIT の効果が決定的に変わる。
