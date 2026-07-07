# TODO Phase 32 — 呼び出し境界を消す (クロージャ/メソッドの JIT 拡大)

## 動機

Phase 31 の結論: richards は JIT 勝ち、deltablue は定常 +2.9% まで縮小、
残る大物は 2 つ:

1. **navier-stokes のカーネルが 1 本も JIT されない** (2.1s — spectral-norm
   の経験則ではカーネルが Wasm に乗れば 1 桁変わる。最大の伸び代)
2. deltablue の小メソッド境界 (本質解 = インライン)

どちらも「呼び出し境界を消す/越える」systematics。NS を優先する
(伸び代が桁違い)。

PLAN-v7 の Phase 32 (test262 ブースト) は Phase 33 に繰り下げ。

## ステップ

### 32-1: 準備

- [ ] 32-1a: TODO + draft PR

### 32-2: NS カーネルの compile ブロッカーを具体特定

Phase 31 の棚卸しでは「unknown call ×10 / array-upvalue escape ×3」。
ただし lin_solve 等の**カーネル単体** (純数値ループ + 配列引数) が
なぜ compile されないかは未特定 (呼び出し側の reject と混在)。

- [ ] 32-2a: 関数ごとの reject 理由を対応付け (lin_solve / diffuse /
      advect / project / dens_step / vel_step / reset / update)
- [ ] 32-2b: ブロッカーの分類 (upvalue 数値 / 配列 upvalue / 兄弟呼び出し /
      その他) と優先順位付け

### 32-3: カーネル単体の JIT (ブロッカー解消)

- [ ] 32-3a: 特定したブロッカーを順に潰す (見込み: 数値 upvalue は
      既対応、配列を「引数」で受けるカーネルは配列 JIT が効くはず)
- [ ] 32-3b: lin_solve 級のカーネルが [Wasm] で実行されることを確認

### 32-4: 兄弟クロージャ呼び出し (unknown call の解消)

呼び出し側 (dens_step 等) が callee を upvalue 経由で呼ぶ。

- [ ] 32-4a: 方式決定 — (a) インライン展開 (callee を IR に埋める) vs
      (b) 同一モジュール複数関数 + call。コンパイル時に upvalue の実体
      (BytecodeFunction) を解決できるか確認
- [ ] 32-4b: 実装 (最小: 1 段の直接呼び出し。再帰/相互再帰は bail)

### 32-5: 計測

- [ ] 32-5a: navier-stokes の TW/VM/JIT (目標: JIT が VM に明確に勝つ)
- [ ] 32-5b: Octane 4 本 + SunSpider の回帰確認

### 32-6: まとめ

- [ ] 32-6a: LEARN-Phase32.md
- [ ] 32-6b: PR を Ready for review に

## 技術メモ

### NS の構造 (再掲)

FluidField 内の inner functions (lin_solve/diffuse/advect/project/...) が
数値 upvalue (rowSize/size/dt 等) を共有し、配列は引数で受け渡す。
配列の実体は reset() が upvalue に格納 (`dens = new Array(size)`) し、
this.update が引数として渡す。

### インライン vs 複数関数モジュール

- インライン: 呼び出し規約設計が不要で既存 inlinePass の拡張。callee の
  upvalue インデックスを caller のものに再マップする必要がある
- 複数関数モジュール: compileMulti の IR 版。呼び出し規約 (配列 ref を
  Wasm 関数間で渡す) は WasmGC ref 型パラメータで自然に書ける
- どちらもコンパイル時に「upvalue スロット → 実関数」の解決が必要。
  tryCall は upvalueValues (値) を持っているので、compile 時点の値で
  特殊化し、変わったら deopt (関数の再代入は稀)
