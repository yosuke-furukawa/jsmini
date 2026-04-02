# PLAN v3 — jsmini の次のステップ

Phase 1-13 完了。test262: TW 41.1%, VM 44.3%。

---

## これまでの全体像

```
Phase 1-3:   言語の基礎 (Lexer, Parser, TW)
Phase 4:     Bytecode VM (スタックマシン)
Phase 5:     Wasm JIT (型フィードバック + コンパイル)
Phase 6:     Element Kind (配列の型追跡 → Wasm linear memory)
Phase 7:     Hidden Class (プロパティレイアウト)
Phase 8:     Inline Cache + Object JIT
Phase 9:     独自文字列表現 (ConsString/SlicedString/Intern)
Phase 10:    Mark-and-Sweep GC + Wasm GC (struct)
Phase 11:    Closure (Upvalue) + OSR
Phase 12:    プロトタイプチェーン + Object.prototype
Phase 13:    構文拡大 + Generator + Symbol + Iterator Protocol
```

---

## Phase 14: WasmGC Array + ビルトイン自前実装

### 14-1: WasmGC Array で配列操作を JIT

現在の Wasm JIT は数値演算のみ Wasm 内で完結する。配列操作 (`arr[i]`) は
Wasm → ホスト境界を超えるため、quicksort のような配列ベンチが JIT で遅くなる。

WasmGC の `array.new` / `array.get` / `array.set` を使えば、
配列を Wasm GC ヒープ上に作って Wasm 内で直接操作できる。

現在の WasmGC コンパイラ (`wasm-gc-compiler.ts`) は struct のみ対応。
これを配列に拡張する。

やること:
- `array.new_fixed` / `array.get` / `array.set` の Wasm 命令生成
- Element Kind (SMI/f64) に応じた型特殊化
- quicksort, map/filter 等の配列ベンチで効果確認
- **目標: quicksort JIT で 10x 以上**

現在のベンチ結果:
```
quicksort: TW 486ms / VM 448ms / JIT 499ms (JIT が負けてる！)
fibonacci: TW 1630ms / VM 1063ms / JIT 0.42ms (3912x)
```

**学べること**: なぜ V8 は配列の内部表現を最適化するのか (Element Kind → GC 管理配列)

### 14-2: ビルトイン自前実装

VM が V8 のネイティブ `Array`, `String` 等をそのまま使っている問題を解消。

やること:
- `Array` コンストラクタを自前実装 (JSObject ベース)
- `Array.prototype.map/filter/reduce/forEach/find/some/every` を jsmini の関数として実装
- `String.prototype.charAt/indexOf/slice/toUpperCase/trim/split/includes/replace` 同様
- `vm.setGlobal("Array", Array)` → 自前 Array コンストラクタに置き換え
- **目標: TW と VM の test262 差 (284件) を解消**

**学べること**: V8 のビルトイン関数は C++ で書かれている理由、Torque DSL の役割

---

## Phase 15 以降 (検討中)

### Generational GC
- Young generation (Nursery) + Old generation (Tenured)
- Minor GC: Young だけ走査 (高速)
- Write barrier: Old → Young の参照を追跡

### Register-based bytecode
- V8 の Ignition はレジスタベース
- スタックの push/pop を減らし、レジスタ間の直接転送に

### IR (中間表現) ベースの JIT
- 定数畳み込み、デッドコード削除、ループ不変式移動
- Escape Analysis (オブジェクトのスタック割り当て)

### 未実装構文
- `yield*` (generator 委譲)
- `generator.throw()`
- `eval()`
- `arguments` オブジェクト
- 正規表現 (RegExp)
