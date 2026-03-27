# TODO - Flat VM: Uint8Array ベースへの移行

PLAN-FlatVM.md の移行計画をタスク単位に分解したもの。
既存の Object VM を残しつつ並行実装し、全テスト通過後に切り替える。

---

## A-0. 基盤

- [ ] `src/vm/opcodes.ts` — 数値 Opcode 定義
  - `const enum Op` で全 opcode を数値に
  - opcode ごとのバイト長テーブル `OP_SIZE`
  - opcode 名テーブル `OP_NAME` (disassembler 用)
- [ ] `src/vm/bytecode-buffer.ts` — バイト列ビルダー
  - `emitOp(op)` — 1バイト
  - `emitOpU8(op, u8)` — 2バイト
  - `emitOpU16(op, u16)` — 3バイト
  - `patchU16(offset, addr)` — パッチバック
  - `currentOffset()` — 現在位置
  - `finish()` → `Uint8Array`
- [ ] `src/vm/flat-bytecode.ts` — FlatBytecodeFunction 型定義
  ```typescript
  type FlatBytecodeFunction = {
    name: string;
    paramCount: number;
    localCount: number;
    code: Uint8Array;
    constants: unknown[];
    handlers: ExceptionHandler[];
  };
  ```
- [ ] テスト: BytecodeBuffer の基本動作

---

## A-1. パイプライン貫通: `1 + 2 * 3` がフラット VM で動く [P0]

- [ ] `src/vm/flat-compiler.ts` — Flat コンパイラ (最小版)
  - `Literal` → `Op.LdaConst <u8>`
  - `BinaryExpression` → 左コンパイル, 右コンパイル, `Op.Add` / `Op.Sub` / `Op.Mul` / `Op.Div` / `Op.Mod`
  - `UnaryExpression` → `Op.Negate`, `Op.LogicalNot`
  - `ExpressionStatement` → 式 + `Op.Pop` (最後以外)
  - `Program` → 各文をコンパイル
- [ ] `src/vm/flat-vm.ts` — Flat VM (最小版)
  - `code: Uint8Array` から `code[pc++]` で opcode 読み取り
  - 数値 switch でディスパッチ
  - `unknown[]` スタック
  - `LdaConst`, `Add`, `Sub`, `Mul`, `Div`, `Mod`, `Negate`, `LogicalNot`, `Pop`
- [ ] `flatVmEvaluate(source)` を export
- [ ] テスト: `1 + 2 * 3` → `7`

```
ゴール: flatVmEvaluate("1 + 2 * 3;") === 7
```

---

## A-2. 変数 + 制御フロー [P0]

- [ ] Opcode 追加:
  - `Op.LdaLocal <u8>`, `Op.StaLocal <u8>`
  - `Op.LdaGlobal <u8>`, `Op.StaGlobal <u8>`
  - `Op.LdaUndefined`, `Op.LdaNull`, `Op.LdaTrue`, `Op.LdaFalse`
  - `Op.Jump <u16>`, `Op.JumpIfFalse <u16>`, `Op.JumpIfTrue <u16>`
  - `Op.Equal`, `Op.StrictEqual`, `Op.NotEqual`, `Op.StrictNotEqual`
  - `Op.LessThan`, `Op.GreaterThan`, `Op.LessEqual`, `Op.GreaterEqual`
  - `Op.Dup`
- [ ] Flat コンパイラ拡張:
  - `VariableDeclaration`, `Identifier`, `AssignmentExpression`
  - `IfStatement` (パッチバック: `emitOpU16` + `patchU16`)
  - `WhileStatement`, `ForStatement`
  - `BlockStatement`, `LogicalExpression`
- [ ] Flat VM 拡張:
  - グローバル変数テーブル
  - ローカルスロット
  - ジャンプ命令
- [ ] テスト: var, if/else, while, for

```
ゴール: 変数、if/else、while、for がフラット VM で動く
```

---

## A-3. 関数 [P1]

- [ ] Opcode 追加:
  - `Op.Call <u8>` (argc)
  - `Op.Return`
- [ ] Flat コンパイラ拡張:
  - `FunctionDeclaration` → 内部関数を別途 FlatBytecodeFunction にコンパイル
  - `CallExpression`
  - `ReturnStatement`
  - トップレベル vs 関数スコープの変数解決
- [ ] Flat VM 拡張:
  - CallFrame (func, pc, locals)
  - Call: 新フレーム push、引数をローカルスロットにバインド
  - Return: フレーム pop、戻り値をスタックに push
- [ ] テスト: 関数宣言/呼び出し, 再帰 (factorial), グローバル参照

```
ゴール: Phase 1 相当がフラット VM で動く
```

---

## A-4. 文字列 + console.log [P1]

- [ ] Opcode 追加:
  - `Op.GetProperty <u8>` (name_index)
  - `Op.GetPropertyComputed`
  - `Op.CallMethod <u8>` (argc)
- [ ] `Add` で文字列連結対応 (typeof チェック)
- [ ] グローバルに console, undefined, Error を登録
- [ ] テスト: 文字列連結, console.log

---

## A-5. Phase 2 構文 [P2]

- [ ] Opcode 追加:
  - `Op.CreateObject`
  - `Op.SetProperty <u8>` (name_index)
  - `Op.SetPropertyAssign <u8>`
  - `Op.CreateArray <u8>` (count)
  - `Op.ArrayPush`, `Op.ArraySpread`
  - `Op.TypeOf`
  - `Op.Throw`
  - `Op.Construct <u8>` (argc)
  - `Op.LoadThis`
  - `Op.In`, `Op.Instanceof`
  - `Op.Increment`, `Op.Decrement`
- [ ] Flat コンパイラ拡張:
  - オブジェクト/配列リテラル
  - プロパティアクセス/代入
  - typeof, throw, try/catch (例外ハンドラテーブル)
  - new, this
  - ++/--, 複合代入
- [ ] Flat VM 拡張:
  - 全 Phase 2 opcode の実行
- [ ] テスト: オブジェクト, 配列, typeof, try/catch, new, this

---

## A-6. Phase 3 構文 [P2]

- [ ] Flat コンパイラ拡張:
  - アロー関数
  - テンプレートリテラル
  - for...of
  - break / continue (ループスタック + パッチバック)
  - クラス
  - 分割代入 (compileBindingTarget)
  - スプレッド
- [ ] テスト: Phase 3 の全構文

---

## A-7. 全テスト通過 + ベンチマーク [P3]

- [ ] 互換テスト: `flatVmEvaluate` と `evaluate` が全ケースで同じ結果
- [ ] 既存 VM テスト (vm.test.ts) を Flat VM でも実行
- [ ] ベンチマーク (V8-JIT なし):
  - Tree-Walking vs Object VM vs Flat VM の3層比較
  - 全ベンチで Flat VM > Tree-Walking を確認
- [ ] ベンチマーク (V8-JIT あり):
  - Flat VM が Object VM より速いことを確認
- [ ] `--flat-vm` フラグで切り替え可能に

```
期待結果 (V8-JIT なし):
  Tree-Walking:  21ms
  Object VM:     33ms
  Flat VM:       ~10ms

期待結果 (V8-JIT あり):
  Tree-Walking:  2.2ms
  Object VM:     1.6ms
  Flat VM:       ~0.8ms
```

---

## A-8. 旧 VM 削除 + JIT 対応 [P3]

- [ ] Object VM (`vm.ts`) を削除
- [ ] Flat VM をデフォルトの `vm.ts` にリネーム
- [ ] `--vm` フラグがフラット VM を使うように
- [ ] `--print-bytecode` を Flat bytecode 用 disassembler に変更
- [ ] JIT コンパイラ (`wasm-compiler.ts`) を Flat bytecode に対応
- [ ] Feedback collector の動作確認
- [ ] README, PLAN.md, bench.ts 更新
- [ ] 全テスト + Test262 通過確認

---

## 実装フロー

```
A-0: 基盤 (opcodes.ts, bytecode-buffer.ts)
  ↓
A-1: 1 + 2 * 3 が動く (パイプライン貫通)
  ↓
A-2: 変数 + if/else + while/for
  ↓
A-3: 関数 (CallFrame)
  ↓
  ここで Phase 1 相当 + ベンチマーク確認
  ↓
A-4: 文字列 + console.log
  ↓
A-5: Phase 2 構文
  ↓
A-6: Phase 3 構文
  ↓
A-7: 全テスト通過 + ベンチマーク比較
  ↓
A-8: 旧 VM 削除 + JIT 対応
```

Phase 4 の Step 4-1〜4-8 と同じ「パイプライン貫通 → 構文追加」アプローチ。
A-3 到達時点でベンチマークを取り、Flat VM が期待通り速いことを確認してから先に進む。
