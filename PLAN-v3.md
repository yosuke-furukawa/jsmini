# PLAN v3 — jsmini の次のステップ

Phase 1-11 を完了。Lexer → Parser → TW → VM → JIT → Hidden Class → IC →
Object JIT → String → GC → Wasm GC → Closure → 仕様準拠改善まで来た。

test262: TW 245/841 (30.0%), VM 244/841 (29.9%)

---

## これまでの全体像

```
Phase 1-3:  言語の基礎 (Lexer, Parser, TW)
Phase 4:    Bytecode VM (スタックマシン)
Phase 5:    Wasm JIT (型フィードバック + コンパイル)
Phase 6:    Element Kind (配列の型追跡 → Wasm linear memory)
Phase 7:    Hidden Class (プロパティレイアウト)
Phase 8:    Inline Cache + Object JIT
Phase 9:    独自文字列表現 (ConsString/SlicedString/Intern)
Phase 10:   Mark-and-Sweep GC + Wasm GC
Phase 11:   Closure (Upvalue) + OSR + 仕様準拠改善
```

---

## 次にやれること

### A. 仕様準拠の拡大

現在 30% の test262 準拠率を上げる。書籍の「JS エンジンが何をしているか」の
解像度を上げるために、実装範囲を広げる。

候補:
- **Object.prototype** — toString, hasOwnProperty, valueOf のデフォルト実装。
  プロトタイプチェーンで全オブジェクトから使えるようにする。
  → JSObject に `__proto__` を設定して Object.prototype を参照させる
- **for-in** — オブジェクトのプロパティを列挙。Hidden Class の properties を使える
- **正規表現** — 最低限の RegExp (test, exec)。パーサーに `/pattern/flags` リテラルを追加
- **getter/setter** — `get x() {}` / `set x(v) {}`。Hidden Class に accessor 情報を追加
- **optional chaining** (`?.`) — パーサー拡張。test262 ハーネスが使ってるので準拠率に直結
- **switch 文** — パーサー + コンパイラ追加
- **ラベル付き文** — break/continue のターゲット

### B. プロトタイプチェーン

V8 の核心的な仕組み。現在は `new Foo()` で `__proto__` を設定しているが、
メソッド解決やプロパティ検索でチェーンを辿る仕組みが不完全。

やること:
- Object.prototype をルートに置く
- Function.prototype, Array.prototype, String.prototype
- `obj.toString()` が Object.prototype.toString を見つける
- instanceof がプロトタイプチェーンを正しく辿る

**学べること**: V8 が prototype chain + IC でメソッドディスパッチを最適化する仕組み

### C. Generational GC

Phase 10 で Mark-and-Sweep を実装した。次は Generational GC:
- Young generation (Nursery) + Old generation (Tenured)
- Minor GC: Young だけ走査 (高速)
- Write barrier: Old → Young の参照を追跡

**学べること**: なぜ V8 の Orinoco は世代別 GC を使うのか、Write barrier のコスト

### D. Register-based bytecode

現在はスタックベース。V8 の Ignition はレジスタベース。
- スタックの push/pop を減らし、レジスタ間の直接転送に
- JIT コンパイルが容易になる (レジスタ割り当てが不要)

**学べること**: なぜ V8 はスタックマシンではなくレジスタマシンを選んだのか

### E. IR (中間表現) ベースの JIT

現在の JIT は bytecode → Wasm を直接変換している。
V8 は Bytecode → IR (Sea of Nodes / CFG) → マシンコード。

- 定数畳み込み、デッドコード削除、ループ不変式移動
- インライン展開の判断
- Escape Analysis (オブジェクトのスタック割り当て)

**学べること**: なぜ V8 は Turbofan/Turboshaft という最適化パイプラインを持つのか

---

## 推奨順序

書籍の章構成を考えると:

```
Phase 12: プロトタイプチェーン + Object.prototype
  → 仕様準拠が大きく改善 (toString, hasOwnProperty, instanceof)
  → 「なぜ V8 はプロトタイプチェーンを最適化するのか」の土台

Phase 13: 構文拡大 (switch, optional chaining, for-in, etc.)
  → test262 準拠率向上
  → 書籍の「対応構文一覧」が充実

Phase 14: Generational GC or Register-based VM
  → どちらも V8 の設計判断を理解するのに重要
  → 書籍のスコープ次第
```

Phase 12 (プロトタイプチェーン) が最もインパクトが大きい。
Object.prototype.toString があれば `{} + {}` が動き、
Array.prototype.push/map/filter があればより現実的なコードが動く。
