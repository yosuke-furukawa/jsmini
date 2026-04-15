# jsmini をどうやって作ったか — 発表資料リサーチ

## この資料の目的

jsmini の構築過程を振り返り、JavaScript エンジンの内部構造を解説する発表資料のための素材をまとめる。

---

## ストーリーライン案

### 1. なぜ作ったのか

- browser-book Part 02 / 第12章「JavaScript エンジン」の執筆
- V8 のソースコードを読んでも **解像度が上がらない** (C++ 30万行)
- 「自分で作れば理解できる」→ TypeScript で教育用エンジン

### 2. 段階的に作った (Phase 1〜24)

**Step 1: 言語を読む**
```
Source Code → [Lexer] → Token列 → [Parser] → AST
```
- 手書き再帰下降パーサー (LL)
- ESTree 準拠の AST
- LR ではなく LL を選んだ理由 (V8/JSC/SpiderMonkey も全部 LL)

**Step 2: 動かす (Tree-Walking)**
```
AST → [Evaluator] → 結果
```
- AST を再帰的に辿って評価
- クロージャ、スコープチェーン、プロトタイプ
- Generator は JS ネイティブの function* で実装

**Step 3: 速くする (Bytecode VM)**
```
AST → [Compiler] → Bytecode → [VM] → 結果
```
- スタックマシン
- V8 の Ignition に相当
- TW の 2-5x 高速化

**Step 4: もっと速くする (Wasm JIT)**
```
Bytecode → [型フィードバック] → [Wasm Compiler] → Wasm → V8が実行
```
- 型フィードバック (monomorphic check)
- Wasm バイナリを手で組み立てる
- Deoptimization (型が変わったら VM にフォールバック)
- TW の 72-1153x 高速化

**Step 5: 最適化する (SSA IR)**
```
Bytecode → [IR Builder] → SSA IR → [Optimizer] → [Codegen] → Wasm
```
- CFG + SSA (V8 Turboshaft と同じ設計)
- Phi ノード、Constant Folding、DCE
- Inlining、LICM、CSE、Strength Reduction
- Range Analysis → i32 overflow 検出 → f64 昇格

**Step 6: 非同期 (Promise + async/await)**
```
Promise → microtask queue → drain
async/await → Generator + Promise でラップ
JSPI → Wasm Stack Switching
```

### 3. 各ステップで学んだこと

---

## 技術トピック (スライド候補)

### パイプライン全体像

```
Source → Lexer → Parser → AST
                           ├→ Tree-Walking (直接評価)
                           └→ Compiler → Bytecode
                                          ├→ VM (インタプリタ)
                                          └→ JIT Manager
                                               ├→ Direct JIT (bytecode → Wasm)
                                               └→ IR JIT (bytecode → SSA IR → optimize → Wasm)
```

### V8 との対応表

| jsmini | V8 | 備考 |
|---|---|---|
| Lexer | Scanner | |
| Parser (LL 再帰下降) | Parser (LL 再帰下降) | 全エンジン共通 |
| Tree-Walking | — | V8 にはない |
| Bytecode Compiler | Ignition (bytecode gen) | |
| VM (スタックマシン) | Ignition (interpreter) | |
| 型フィードバック | Feedback Vector | |
| Direct JIT | Sparkplug (baseline) | |
| IR Builder | Maglev / Turboshaft | |
| SSA IR + 最適化 | Turboshaft passes | |
| Wasm Codegen | Code Generator | V8 はネイティブ、jsmini は Wasm |

### Hidden Class + Inline Cache

```
var p = {};      // HC0: {}
p.x = 1;        // HC0 → HC1: {x: slot 0}
p.y = 2;        // HC1 → HC2: {x: 0, y: 1}
```

- 同じ順序でプロパティ追加 → 同じ Hidden Class
- IC が HC をチェック → slot offset で直接アクセス
- V8 の Map (Hidden Class) + IC と同じ仕組み

### OSR (On-Stack Replacement)

```
function f(n) {
  var sum = 0;
  for (var i = 0; i < n; i++) sum += i;  // ← back edge で OSR 発火
  return sum;
}
f(5000000);  // 1回しか呼ばれないのに JIT される
```

- 最初: paramCount 個だけ渡して最初から再実行 (もどき)
- 修正後: 全 locals を Wasm に渡して途中から再開 (Proper OSR, 215x)

### Range Analysis + Overflow

```js
addUp(50000);
// Direct JIT: -61063496 (i32 overflow で壊れる)
// IR JIT: 41665416675000 (f64 昇格で正確)
```

- [min, max] を追跡、i32 に収まらなければ f64 に昇格
- V8 は CPU の overflow フラグ (jo 命令) を使うが、Wasm では使えない

### LICM × LoadProperty = 79x

```js
Point.prototype.heavy = function() {
  for (var i = 0; i < 100; i++) {
    sum += this.x * this.x + this.y * this.y;  // ← i32.load をループ外に
  }
};
```

- LICM が `LoadProperty(this, "x")` をループ外に移動
- Direct JIT は毎回 i32.load → IR JIT は 1 回だけ
- 「最適化パスが Wasm 上で意味を持つ」唯一のケース

### Promise + Microtask

```
1. スクリプト実行 (同期コード)
2. microtask queue を drain (.then コールバック)
3. 空になったら終了
```

- `enqueueMicrotask` / `drainMicrotasks` (FIFO 配列)
- `.then()` は常に非同期 (settled でも microtask 経由)
- V8 は C++ deque、jsmini は JS 配列

### async/await の実装

```
async function = Generator + Promise でラップ
await = yield { __await__: true, value } → Promise.resolve(v).then(resume)
```

- TW: JS ネイティブ generator で suspend/resume
- VM: YieldSignal throw で suspend、microtask で resume
- JSPI: Wasm スタックごと suspend/resume (15.7x 速いが microtask がボトルネック)

### Wasm を JIT バックエンドにする利点と限界

**利点:**
- ネイティブ機械語を生成しなくていい (V8 が Wasm をさらにコンパイル)
- ポータブル (どのプラットフォームでも動く)
- WasmGC で配列/オブジェクトも管理可能

**限界:**
- V8 の TurboFan が Wasm レベルで同等の最適化をやる → IR 側の LICM/CSE が速度差にならない
- ただし LoadProperty (メモリアクセス) の LICM は Liftoff がやらないので効く
- TypeScript ランタイムの限界 (microtask queue が JS)

---

## 数字で語る

| 指標 | 値 |
|---|---|
| Phase 数 | 24 |
| テスト数 | 753 |
| test262 Promise 通過率 | 49.1% (320/652) |
| TW → JIT 最大倍率 | 1153x (fib) |
| OSR 効果 | 215x (single call) |
| LICM × Property | 79x |
| JSPI suspend | 15.7x vs VM |
| ソースコード行数 | (要計測) |

---

## 発表で伝えたいメッセージ

1. **JavaScript エンジンは段階的に作れる** — Lexer → Parser → TW → VM → JIT → IR は独立したステップ
2. **V8 と同じアーキテクチャ** — Hidden Class, IC, SSA IR, Deopt, OSR は全部 TypeScript で実装可能
3. **Wasm は JIT バックエンドになる** — ネイティブ機械語を書かなくても 1000x 高速化できる
4. **最適化には限界がある** — Wasm バックエンドだと V8 が同じ最適化をやるので差が出にくい
5. **作って初めてわかる** — コードを読むだけでは理解できないことが、実装すると見える

---

## 参考リソース

- [ARCHITECTURE.md](../ARCHITECTURE.md) — jsmini パイプライン全体解説
- [LEARN-*.md](../) — 各 Phase の学び
- [RESEARCH-*.md](../) — V8/JSC/SpiderMonkey の調査
- [playground](https://yosuke-furukawa.github.io/jsmini/) — ブラウザで試せる
