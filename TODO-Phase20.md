# TODO Phase 20 — Range Analysis + Overflow Check Elimination

## 動機

jsmini の IR JIT は全演算を i32 で行うが、i32 overflow 時に結果が壊れる。

```js
function addUp(n) {
  var sum = 0;
  for (var i = 0; i < n; i++) { sum = sum + i * i; }
  return sum;
}
addUp(50000);
// TW/VM: 41665416675000 (正しい)
// IR JIT: -61063496 (i32 overflow で壊れる)
```

V8 は CPU の overflow flag (`jo` 命令) でゼロコスト検知 → deopt。
Wasm にはこれがないので、ソフトウェアで overflow チェックが必要 (6 命令)。
ただし全演算にチェックを入れると遅い。

**解決策: Range Analysis で値の範囲を追跡し、overflow しないことがわかる演算はチェックを省く。**

## Range Analysis とは

IR の各 Op に `range: [min, max]` を付けて、値の範囲を伝播する。

```
v0 = Const(100)             // range: [100, 100]
v1 = Param(0)               // range: [-2^31, 2^31)  (i32 全範囲)
v2 = Mod(v1, v0)            // range: [0, 99]
v3 = Mul(v2, v2)            // range: [0, 9801] → i32 に余裕。チェック不要
```

ループカウンタ:
```
for (var i = 0; i < n; i++)   // i: [0, n-1]
  i * i                        // [0, (n-1)^2]
  // n = 100 → i*i max = 9801 → チェック不要
  // n = 50000 → i*i max = 2.5B → i32 超える → チェック必要 or f64 昇格
```

V8 の TurboFan にも Range Analysis があり、Bounds Check Elimination にも使われる。

## ステップ

### 20-1: Range 型の定義

- [ ] 20-1a: `src/ir/range.ts` — Range 型 `{ min: number, max: number }`
- [ ] 20-1b: Op に range フィールドを追加
- [ ] 20-1c: テスト

### 20-2: Range の伝播

各 Op の range を引数の range から計算する。

- [ ] 20-2a: Const → `[value, value]`
- [ ] 20-2b: Param → `[-2^31, 2^31)` (i32 全範囲)、型フィードバックで絞れる場合あり
- [ ] 20-2c: Add(a, b) → `[a.min + b.min, a.max + b.max]`
- [ ] 20-2d: Sub(a, b) → `[a.min - b.max, a.max - b.min]`
- [ ] 20-2e: Mul(a, b) → 4通りの組み合わせの min/max
- [ ] 20-2f: Mod(a, b) → `[0, |b|-1]` (b が正の定数の場合)
- [ ] 20-2g: LessThan の true 側: Phi の range を絞る (`i < n` → i: [min, n-1])
- [ ] 20-2h: Phi → predecessor の range の union
- [ ] 20-2i: テスト

### 20-3: Overflow チェックの挿入/省略

Range に基づいて overflow チェックを制御。

- [ ] 20-3a: `canOverflow(op)`: op.range が i32 に収まるか判定
  - `[min, max]` が `[-2^31, 2^31)` 内 → チェック不要
  - 範囲外 → チェック必要
- [ ] 20-3b: codegen で overflow 可能な演算に検知コードを挿入
  ```wasm
  ;; (a ^ res) & (b ^ res) の MSB が 1 → overflow
  local.get $a
  local.get $b
  i32.add
  local.tee $res
  local.get $a
  i32.xor
  local.get $b
  local.get $res
  i32.xor
  i32.and
  i32.const 31
  i32.shr_u
  if
    unreachable   ;; trap → deopt
  end
  ```
- [ ] 20-3c: チェック不要な演算はそのまま `i32.add`
- [ ] 20-3d: テスト

### 20-4: f64 への昇格 (フォールバック)

Range が広すぎて常に overflow する場合、f64 に昇格。

- [ ] 20-4a: 型フィードバックで f64 が来た関数は最初から f64
- [ ] 20-4b: Range で overflow が確実な演算を f64 に昇格
- [ ] 20-4c: deopt 後の再コンパイルで f64 を選択
- [ ] 20-4d: テスト

### 20-5: ベンチマーク

- [ ] 20-5a: addUp(50000) が正しい結果を返す
- [ ] 20-5b: addUp(100) など小さい入力は overflow チェックなしで高速
- [ ] 20-5c: bench.ts の i32 overflow テストが match=true になる

## 目標

- overflow で結果が壊れないこと (正確性)
- Range Analysis で不要な overflow チェックを省略 (性能)
- V8 の Range Analysis + Bounds Check Elimination と同じ考え方を学ぶ

## 技術メモ

### V8 の overflow 対処

1. i32 (Smi) で投機的にコンパイル
2. `add` + `jo` で CPU の overflow flag をチェック (ゼロコスト)
3. overflow → deopt → bytecode VM にフォールバック
4. 再コンパイル時に f64 で特殊化

### Wasm の制約

- CPU の overflow flag (OF) にアクセスできない
- ソフトウェアで overflow チェック: 6 命令のオーバーヘッド
- wide-arithmetic proposal (`i64.add128`) で間接的に検知可能だが未策定

### Range Analysis の限界

- ループの range はイテレーション数に依存 → Phi の range が fixpoint に到達するまで反復が必要
- 動的な `n` (Param) は range が広い → overflow チェックが必要
- 定数の `n` (Const) なら range が確定 → チェック省略可能
