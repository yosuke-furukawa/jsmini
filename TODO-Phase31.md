# TODO Phase 31 — Octane 性能: object JIT (PLAN-v7 P2)

## 動機

Phase 30 で Octane 4 本 × 3 モードが完走したが **JIT ≈ VM** (どこも
効いていない)。棚卸し (LEARN-Phase30) の結果:

- richards/deltablue: ホットな OO メソッドが「非数値 this スロット」で
  全部 deopt
- navier-stokes: 数値カーネルがクロージャ + 配列 + 相互呼び出しで
  1 本も JIT されない
- splay: GC バウンド (JIT の領域外)

本フェーズは **this-model の刷新** で OO メソッドの JIT カバレッジを
上げ、richards/deltablue で JIT > VM を目指す。

## 現行 this-model の問題 (調査済み)

1. **offset の不整合**: codegen の propOffsets は「IR 出現順」なのに、
   executeWasm のコピーは「HiddenClass 挿入順」で 0-based。両者が一致
   するのは使用順と定義順が揃った偶然のケースだけ
2. **全プロパティコピー**: メソッドが使わないプロパティ (オブジェクト
   参照等) も対象になり、1 つでも非数値だと deopt (Phase 30 のガード)
3. **write-back が無い**: `this.state = x` を含むメソッドが JIT される
   と変更が VM 側に反映されない。Phase 30 時点では mutating メソッドが
   偶然 (2) の deopt に守られていただけ

## ステップ

### 31-1: 準備

- [x] 31-1a: TODO + draft PR

### 31-2: this-model 刷新 (used-props ベース)

- [x] 31-2a: compileIRToWasm が propOffsets (offset 順の名前リスト) と
      writtenProps (StoreProperty される名前) を返す
- [x] 31-2b: executeWasm: 関数が**使う**プロパティだけを名前で HC から
      引いて offset 順に copy-in。使うプロパティが非数値 (または i32
      spec で非整数) なら deopt。使わないプロパティは参照でも無視
      (richards の TCB.link 等があっても state だけ使うメソッドは JIT 可)
- [x] 31-2c: writtenProps があれば fn 後に linear memory → jsObjSet で
      copy-back (mutating メソッドの正しさ)
- [x] 31-2d: 回帰テスト — mutating メソッド / プロパティ順不一致 /
      未使用オブジェクト参照プロパティ / f64 値で deopt

### 31-3: 計測

- [x] 31-3a: richards/deltablue の tier 棚卸し再取得 (compiled 増・
      deopt 減の確認)
- [x] 31-3b: octane-bench で JIT vs VM 比較

### 31-4: navier-stokes カーネル (調査 → 可能なら着手)

- [x] 31-4a: lin_solve 等が reject される正確な理由の列挙
      (upvalue / 配列引数 / 相互呼び出しのどれがブロッカーか)
- [x] 31-4b: 対応方針を決める (compileMulti 拡張 or 呼び出し規約追加)。
      規模次第で Phase 32 に切り出し

### 31-5: まとめ

- [x] 31-5a: LEARN-Phase31.md
- [x] 31-5b: PR を Ready for review に

## 技術メモ

### V8 との対比

V8 はオブジェクトスロットを tagged pointer で持つため、参照も数値も
同じモデルに乗り、メソッド JIT に「使うプロパティが数値だけ」という
制約は無い。jsmini の linear memory this-model は asm.js 的な数値専用
ビューなので、「関数が触るスロットだけを型チェックして copy-in/out する」
= 実質的に **per-function の型特殊化** (V8 の map check + unboxing に相当)
として整理できる。

### deopt の位置づけ

used-props に参照が含まれるメソッド (scheduler.schedule 等) は引き続き
deopt で VM 実行。これらを JIT するには tagged 表現か object-table
(参照を整数 ID にして間接参照) が必要で、それは次フェーズ以降の候補。

## 結果 (完了時追記)

- richards: **JIT 112ms vs VM 116ms — JIT 初勝利**。splay/NS 同等、
  deltablue -10% (小メソッド境界コスト。本質解 = メソッドクラスタの
  インライン化 → Phase 32 候補)
- 過程で ||/&&/三項の JIT が最初から壊れていた 3 層バグを発見・修正
  (スタック Phi / Branch phi write / ダイヤモンド構造化)。詳細 LEARN-Phase31
- グローバル読みの JIT が zero-init local を読んでいた correctness バグも
  修正 (読み取り専用パラメータ渡し + StoreGlobal reject)
- 簿記 fast path (__jitCached) で「決まったら profiling を止める」
- 31-4b: NS カーネルは「クロージャクラスタ同時コンパイル + 配列 upvalue」
  が必要と判明 → deltablue インラインと合わせて Phase 32 に切り出し
- 全 985 テストパス (回帰 11 ケース追加)
