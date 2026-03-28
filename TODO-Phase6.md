# TODO — Phase 6: Hidden Class (Element Kind)

配列の Element Kind を追跡し、整数配列を Wasm linear memory で JIT する。
**ゴール**: quicksort(200) が Wasm JIT で動き、TW の 100 倍以上速くなる。

---

## 6-0. JSArray 型の導入

- [x] `src/vm/js-array.ts` — Element Kind 付き配列型
  ```typescript
  type ElementKind = "SMI" | "DOUBLE" | "GENERIC";
  const ELEMENT_KIND: unique symbol;

  function createJSArray(elements: unknown[]): unknown[]
  function getElementKind(arr: unknown[]): ElementKind
  function setElement(arr: unknown[], index: number, value: unknown): void
  ```
- [x] `classifyElements(elements)` — 初期要素から Element Kind を判定
- [x] `transitionElementKind(arr, newValue)` — 要素追加時の一方通行遷移
  - SMI: 全要素が整数 (`Number.isInteger`)
  - DOUBLE: 全要素が数値
  - GENERIC: 非数値が混在
- [x] テスト: Element Kind の分類と遷移 (21 テスト)

---

## 6-1. VM の配列操作を JSArray 対応に

- [x] `CreateArray` — `createJSArray(elements)` を使う
- [x] `ArrayPush` — `pushElement` で Element Kind を追跡
- [x] `SetPropertyComputed` — 配列への代入時に `setElement` で Element Kind を更新
- [x] `GetPropertyComputed` — (変更不要、読み取りは Element Kind に影響しない)
- [x] `GetProperty "length"` — JSArray の length (変更不要、`arr.length` はそのまま動く)
- [x] テスト: 既存の全テスト (441) がパスすること

---

## 6-2. 型フィードバックの拡張

- [x] `FeedbackCollector.classifyType` に配列型を追加
  - `Array.isArray(value) && getElementKind(value) === "SMI"` → `"smi_array"`
  - `Array.isArray(value) && getElementKind(value) === "DOUBLE"` → `"double_array"`
  - その他の配列 → `"array"`
- [x] `toWasmType` で `"smi_array"` → `"i32"` (memory base address) として認識
- [x] `isArrayType` ヘルパー追加

---

## 6-3. WasmBuilder に Memory セクション追加

- [x] `WasmBuilder.enableMemory(pages)` — Memory セクション (id=5) を出力
  - `(memory 1)` = 1 ページ = 64KB = 整数 16384 個分
- [x] Memory を export: `(export "memory" (memory 0))`
- [x] `WASM_OP` に追加:
  - `i32.load` (0x28)
  - `i32.store` (0x36)
  - `f64.load` (0x2b)
  - `f64.store` (0x39)
- [x] テスト: Memory 付き Wasm モジュールのビルドと動作確認

---

## 6-4. バイトコード静的解析 — 配列ローカルの特定

- [x] `detectArrayLocals(func)` — バイトコードをスキャンして配列として使われているローカル変数を特定
  ```
  パターン: LdaLocal N ... GetPropertyComputed → local N は配列
  パターン: LdaLocal N ... SetPropertyComputed → local N は配列
  パターン: LdaLocal N ... GetProperty "length" → local N は配列
  ```
- [x] 配列ローカルの情報を Wasm コンパイラに渡す (TranslateContext.arrayLocals)
- [x] テスト: swap=[0], partition=[0], qsort=[], fib=[], sumArr=[0]

---

## 6-5. Wasm コンパイラ — 配列アクセスの変換

- [x] 配列ローカルの引数を i32 (memory base address) として扱う
- [x] `GetPropertyComputed` の変換:
  ```
  stack: [base, idx] → i32.const 4 / i32.mul / i32.add / i32.load
  ```
- [x] `SetPropertyComputed` の変換:
  ```
  stack: [base, idx, value] → temp local に退避 → addr 計算 → i32.store
  ```
- [x] `if (void)` パターン対応 (else なし、return なし)
- [x] `compileMultiSync` が配列ローカルを検出して自動で memory 有効化
- [x] `GetProperty "length"` の変換: メモリレイアウト [length][elem0][elem1]... で `i32.load(base)` に変換
- [x] テスト: swap, partition, qsort が Wasm で動作。quicksort(200) = TW の 195 倍速い

---

## 6-6. 配列引数の in/out コピー

- [x] JitManager の呼び出しラッパー:
  1. Element Kind が SMI であることを確認 (型ガード)
  2. JS 配列 → Wasm memory にコピー (length ヘッダ + Int32Array)
  3. Wasm 関数を呼ぶ (base address + 数値引数)
  4. Wasm memory → JS 配列に書き戻す
- [x] 関連関数の自動収集 (`collectRelatedFuncs`) — LdaGlobal+Call パターンから依存関数を探索
- [x] 複数関数が同じ memory を共有 (swap, partition, qsort を 1 モジュールに)
- [x] `registerFunc` で VM のグローバル関数を JitManager に追跡
- [x] テスト: quicksort([5,3,1,4,2]) が VM の Call 経由で自動的に Wasm JIT 実行

---

## 6-7. quicksort の Wasm JIT 実行

- [x] swap, partition, qsort を `compileMultiSync` で 1 つの Wasm モジュールに (自動)
- [x] partition 内の `swap(arr, i, j)` → Wasm 内の `call $swap`
- [x] qsort 内の `partition(arr, lo, hi)` → Wasm 内の `call $partition`
- [x] qsort の自己再帰 → Wasm 内の `call $qsort`
- [x] テスト: quicksort(200) が正しくソートされる (result=298)
- [ ] ベンチマーク: TW / VM / Wasm JIT の 3 層比較

---

## 6-8. 型ガード + deopt

- [ ] Wasm 実行前の Element Kind チェック
  - `getElementKind(arr) !== "SMI"` → deopt → VM にフォールバック
- [ ] 実行中に Element Kind が変わるケースの処理
  - quicksort 内では整数しか扱わないので変わらないはずだが、安全のため
- [ ] deopt ログに配列の Element Kind 変化を記録
- [ ] テスト: 整数配列 → 正常動作、混合配列 → VM フォールバック

---

## 6-9. playground + ドキュメント更新

- [ ] playground: quicksort プリセットが Wasm JIT モードで動く
- [ ] playground: WAT に `i32.load` / `i32.store` が表示される
- [ ] `BENCHMARK.md` 更新: quicksort の Wasm JIT 結果追加
- [ ] `LEARN-HiddenClass.md` 作成: Element Kind から学んだこと
- [ ] `bench.ts` 更新: quicksort を JIT eligible に

---

## 実装フロー

```
6-0: JSArray 型 (Element Kind 追跡)
  ↓
6-1: VM の配列操作を JSArray 対応
  ↓
6-2: 型フィードバック拡張 ("smi_array")
  ↓
6-3: WasmBuilder に Memory セクション
  ↓
6-4: バイトコード静的解析 (配列ローカル検出)
  ↓
6-5: Wasm コンパイラ (GetPropertyComputed → i32.load)
  ↓
6-6: 配列引数の in/out コピー
  ↓
6-7: quicksort の Wasm JIT 実行 ← ゴール
  ↓
6-8: 型ガード + deopt
  ↓
6-9: playground + ドキュメント
```

6-0 ～ 6-1 は VM の基盤変更。既存テスト全パスが必須。
6-3 ～ 6-5 は Wasm 側の拡張。小さい関数 (swap) で先にテスト。
6-7 が本番。swap → partition → qsort の順で動かす。

---

## 依存する既存コード

| ファイル | 変更内容 |
|---------|---------|
| `src/vm/js-array.ts` | **新規**: Element Kind 付き配列 |
| `src/vm/vm.ts` | CreateArray, SetPropertyComputed を JSArray 対応 |
| `src/vm/compiler.ts` | (変更なし — バイトコードは同じ) |
| `src/jit/feedback.ts` | classifyType に `"smi_array"` 追加 |
| `src/jit/wasm-builder.ts` | Memory セクション、i32.load/store |
| `src/jit/wasm-compiler.ts` | GetPropertyComputed/SetPropertyComputed → i32.load/store |
| `src/jit/jit.ts` | 配列引数の in/out コピー、型ガード |
| `src/bench.ts` | quicksort を JIT eligible に |
