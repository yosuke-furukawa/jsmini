# TODO - Phase 5: Wasm JIT — 最適化の体験

browser-book 第12章「JIT コンパイラ」「多層 JIT」「脱最適化」の解像度を上げるため、
ホットコードを Wasm にコンパイルして実行する仕組みを実装する。

Phase 4 の Bytecode VM に「型フィードバック → Wasm 生成 → 脱最適化」の層を追加し、
Bytecode VM → Wasm の2層構成で多層 JIT を再現する。

---

## 実行パイプライン（最終形）

```
Source → Lexer → Parser → AST → BytecodeCompiler → Bytecode
                                                      ↓
                                            Bytecode VM (通常実行)
                                            型フィードバック収集
                                                      ↓ ホット判定 (N回呼び出し)
                                            Wasm Compiler (型特殊化)
                                                      ↓
                                            WebAssembly.instantiate()
                                            で高速実行
                                                      ↓ 型推測ミス
                                            脱最適化 → Bytecode VM に戻る
```

---

## 5-1. 型フィードバック収集 [P0]

VM の実行中に統計情報を蓄積する仕組みを作る。

### 設計

```typescript
type TypeFeedback = {
  callCount: number;        // 関数の呼び出し回数
  argTypes: string[][];     // 引数ごとの型履歴 (例: [["number","number"], ["number","number"]])
  returnType: string[];     // 戻り値の型履歴
  isMonomorphic: boolean;   // 常に同じ型パターンか
};

// 関数ごとに TypeFeedback を保持
type FeedbackMap = Map<BytecodeFunction, TypeFeedback>;
```

### 実装

- [x] `src/jit/feedback.ts` — TypeFeedback の型定義と FeedbackCollector
- [x] VM の `Call` 命令実行時に引数の型を記録 (`recordCall`)
- [x] VM の `Return` 命令実行時に戻り値の型を記録 (`recordReturn`)
- [x] 呼び出し回数をカウント (`callCount`)
- [x] `isMonomorphic` の判定（全サンプルが同じ型パターンか）
- [x] `--print-feedback` フラグでフィードバック情報をダンプ
- [x] テスト (4件)

```bash
$ npm start -- --vm --print-feedback '
function add(a, b) { return a + b; }
for (var i = 0; i < 100; i = i + 1) { add(i, i); }
'
# Feedback for add:
#   callCount: 100
#   argTypes: [number, number] (monomorphic)
#   returnType: number
```

```
ゴール: 関数の型フィードバックを収集・表示できる
```

---

## 5-2. Wasm バイナリ生成 [P0]

TypeScript から Wasm バイナリ（バイト列）を手で組み立てる。

### Wasm バイナリフォーマットの基礎

```
Wasm モジュール = マジックナンバー + バージョン + セクション列

セクション:
  1. Type section    — 関数シグネチャ (例: (f64, f64) → f64)
  2. Function section — 関数インデックス → Type インデックス
  3. Export section   — 外部に公開する関数名
  4. Code section     — 関数の本体 (Wasm 命令列)
```

### Wasm 命令 (最小セット)

```
local.get <idx>    — ローカル変数をロード
local.set <idx>    — ローカル変数にストア
f64.const <val>    — f64 定数をスタックに push
f64.add            — 加算
f64.sub            — 減算
f64.mul            — 乗算
f64.div            — 除算
f64.lt             — 比較 (<)
f64.gt             — 比較 (>)
if ... else ... end — 条件分岐
loop ... br_if ... end — ループ
call <idx>         — 関数呼び出し
return             — 戻る
```

### 実装

- [x] `src/jit/wasm-builder.ts` — Wasm バイナリビルダー
  - マジックナンバー + バージョン、Type/Function/Export/Code セクション
  - LEB128 エンコーディング、f64ToBytes、WASM_OP 定数
- [x] `src/jit/wasm-compiler.ts` — BytecodeFunction → Wasm 変換
  - LdaLocal → local.get, Add → f64.add, Return → return 等
  - number 以外の定数を含む関数は null (JIT 不可) を返す
- [x] `WebAssembly.instantiate()` で生成した Wasm を実行
- [x] テスト (7件): add/sub/mul の直接 Wasm、BytecodeFunction → Wasm 変換、非対応関数の拒否

```javascript
// ゴール: この関数が Wasm に変換されて実行される
function add(a, b) { return a + b; }
// → Wasm: (func (param f64 f64) (result f64) local.get 0 local.get 1 f64.add)
```

```
ゴール: add(3, 4) が Wasm 経由で 7 を返す
```

---

## 5-3. ホットコード検出 + 自動 JIT [P1]

型フィードバックをもとに、ホットな関数を自動的に Wasm にコンパイルする。

### 設計

```
関数呼び出し回数 < しきい値 → Bytecode VM で実行
関数呼び出し回数 >= しきい値 && monomorphic → Wasm にコンパイル、以降 Wasm で実行
```

### 実装

- [x] `src/jit/jit.ts` — JitManager
  - しきい値の設定 (デフォルト: 100回、`jitThreshold` で変更可)
  - 関数ごとに Wasm モジュールをキャッシュ (`wasmCache`)
  - `tryCall()`: しきい値超え && monomorphic && 全引数 number → Wasm 実行
  - 同期コンパイル (`compileToWasmSync`) で即座にキャッシュ
- [x] VM に JIT 統合
  - `Call` 命令: フィードバック記録 → `jit.tryCall()` → Wasm あればスタックに結果を push して CallFrame をスキップ
  - `vm.jit` フィールド
- [x] `vmEvaluate({ jit: true, jitThreshold: N })` で JIT を有効化
- [x] テスト (3件): ホット関数の自動切り替え、JIT なしとの一致、文字列関数の非 JIT

```bash
$ npm start -- --jit '
function fib(n) { if (n <= 1) { return n; } return fib(n-1) + fib(n-2); }
fib(30);
'
# [JIT] Compiling fib to Wasm (callCount=100, argTypes=[number])
```

```
ゴール: ホットな関数が自動的に Wasm に切り替わる
```

---

## 5-4. 型特殊化 [P2]

monomorphic な型情報をもとに、型特殊化した Wasm コードを生成する。

### 実装

- [ ] number 専用パスの生成
  - 引数が常に number → Wasm の f64 で直接演算
  - 型チェック不要（ガードは脱最適化で対応）
- [ ] 比較演算の特殊化
  - `f64.lt`, `f64.gt` 等を直接使用
- [ ] 条件分岐 + ループの Wasm 化
  - `if ... else ... end`
  - `loop ... br_if ... end`

```
ゴール: 型特殊化した Wasm が生成され、型チェックなしで高速実行される
```

---

## 5-5. 脱最適化 (Deoptimization) [P2]

型推測が外れた場合に、Wasm から Bytecode VM にフォールバックする仕組み。

### 設計

```
1. Wasm 関数にガードを挿入
   - 引数が f64 でなければ → 脱最適化フラグを立てて early return
2. 呼び出し側でフラグを検知
   - Wasm キャッシュを無効化
   - Bytecode VM で再実行
3. ログ出力
   - "[DEOPT] add: expected number but got string"
```

### 実装

- [ ] Wasm コードにタイプガード挿入
  - Wasm 内では直接型チェックできないので、呼び出し前に TypeScript 側でチェック
  - 型が合わなければ Wasm を呼ばずに Bytecode VM にフォールバック
- [ ] Wasm キャッシュの無効化
- [ ] 脱最適化カウンタ（頻繁に脱最適化する関数は JIT 対象から除外）
- [ ] `--print-deopt` フラグでログ出力
- [ ] テスト

```javascript
function add(a, b) { return a + b; }
for (var i = 0; i < 100; i++) { add(i, i); }  // → Wasm にコンパイル
add("hello", "world");                          // → 脱最適化！VM にフォールバック
```

```
ゴール: 型推測が外れた時に安全に Bytecode VM に戻る
```

---

## 5-6. 多層実行の可視化 [P2]

実行が Bytecode VM → Wasm → 脱最適化 → Bytecode VM と切り替わる様子を可視化する。

### 実装

- [ ] `--trace-tier` フラグで実行層の切り替えをログ出力
- [ ] Playground に実行層の表示を追加
  - 関数ごとに「Interpreter」「Wasm」のバッジ
  - 脱最適化の発生を赤でハイライト

```bash
$ npm start -- --jit --trace-tier '
function sum(a, b) { return a + b; }
for (var i = 0; i < 200; i = i + 1) { sum(i, i); }
sum("a", "b");
'
# [TIER] sum: Bytecode VM (call #1)
# [TIER] sum: Bytecode VM (call #100)
# [TIER] sum: → Wasm compiled (monomorphic: [number, number] → number)
# [TIER] sum: Wasm (call #101)
# [TIER] sum: Wasm (call #200)
# [TIER] sum: → DEOPT (expected number, got string)
# [TIER] sum: Bytecode VM (call #201)
```

```
ゴール: browser-book の多層 JIT の動きが目に見える
```

---

## 5-7. ベンチマーク + 3層比較 [P3]

Tree-Walking, Bytecode VM, Wasm JIT の3層でパフォーマンスを比較する。

- [ ] `npm run bench` を3層対応に拡張
- [ ] 結果を README に記載
- [ ] browser-book 第12章の「ギアの例え」と対比

```
期待される結果:
  fibonacci(25):
    tree-walking : 138ms
    bytecode-vm  : 40ms   (3.4x)
    wasm-jit     : ???ms  (??x)   ← ここが新しい
```

---

## 実装フロー

```
Step 5-1: 型フィードバック収集 (--print-feedback)
    ↓
Step 5-2: Wasm バイナリ生成 (add(3,4) が Wasm で動く)
    ↓
  ここで「バイトコード → Wasm」の変換を体験
    ↓
Step 5-3: ホットコード検出 + 自動 JIT (--jit)
    ↓
  ここで browser-book の「ホットコード」の概念を体験
    ↓
Step 5-4: 型特殊化 (number 専用 Wasm)
    ↓
Step 5-5: 脱最適化 (Wasm → VM フォールバック)
    ↓
  ここで browser-book の「脱最適化」を体験
    ↓
Step 5-6: 多層実行の可視化 (--trace-tier)
    ↓
Step 5-7: 3層ベンチマーク比較
```

**最初のマイルストーンは Step 5-2**。`add(3, 4)` が手作りの Wasm バイナリ経由で `7` を返す。
Wasm バイナリを手で組み立てる体験は、browser-book の「バイトコード → 機械語」の話を
一番具体的に理解できる瞬間。

---

## browser-book との対応

| browser-book の記述 | jsmini での体験 |
|---|---|
| 統計情報（関数呼び出し回数、型情報）| TypeFeedback: callCount, argTypes, isMonomorphic |
| ホットコードの検出 | しきい値 (100回) を超えた関数を JIT 対象に |
| 型の推定 | monomorphic 判定: 常に同じ型パターンか |
| JIT コンパイラがバイトコードから機械語を生成 | WasmCompiler が BytecodeFunction → Wasm バイナリ |
| 多層 JIT（ベースライン → 中間層 → トップ層）| Bytecode VM → Wasm の2層 |
| 脱最適化（推測が外れたらバイトコードに戻る）| 型ガード失敗 → Wasm キャッシュ無効化 → VM 実行 |
| 「ギアの切り替え」の例え | --trace-tier で実際に切り替わる様子を表示 |

---

## Wasm バイナリフォーマット参考

```
// add(a: f64, b: f64) → f64 の最小 Wasm モジュール
0x00 0x61 0x73 0x6d  // マジックナンバー "\0asm"
0x01 0x00 0x00 0x00  // バージョン 1

// Type section (1)
0x01 0x07            // section id=1, size=7
0x01                 // 1つの型
0x60                 // func type
0x02 0x7c 0x7c       // 2 params: f64, f64
0x01 0x7c            // 1 result: f64

// Function section (3)
0x03 0x02            // section id=3, size=2
0x01                 // 1つの関数
0x00                 // type index 0

// Export section (7)
0x07 0x07            // section id=7, size=7
0x01                 // 1つのexport
0x03 0x61 0x64 0x64  // name "add"
0x00 0x00            // kind=func, index=0

// Code section (10)
0x0a 0x09            // section id=10, size=9
0x01                 // 1つの関数本体
0x07                 // body size=7
0x00                 // local declarations: 0
0x20 0x00            // local.get 0
0x20 0x01            // local.get 1
0xa0                 // f64.add
0x0b                 // end
```

この 41 バイトが `(a, b) => a + b` の Wasm バイナリ。
jsmini ではこれを TypeScript で1バイトずつ組み立てる。
