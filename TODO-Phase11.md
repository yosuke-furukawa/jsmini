# TODO — Phase 11: VM クロージャ対応 (Upvalue)

## 問題

VM で外側の関数スコープの変数をキャプチャできない:

```js
function outer(n) {
  return function inner(m) { return n + m; };
}
outer(1)(5);
// TW: 6 (正しい)
// VM: NaN (n が undefined)
```

inner のバイトコードで `n` が `LdaGlobal "n"` になっている。
`n` は outer のローカル変数なのにグローバルとして探すので見つからない。

TW は Environment チェーン (親スコープへの参照) があるので動く。
VM にはこの仕組みがない。

## 影響範囲

- `function() {}` で外側の変数を参照するパターン全般
- アロー関数 `() => n` も同様
- `forEach(arr, function(x) { sum = sum + x; })` のコールバックで外側の `sum` を参照
- Phase 10E-5 のクロージャ JIT (Wasm GC) の前提条件

## 方針: Upvalue (Lua 方式)

コンパイラが「外側のローカル変数を参照している」ことを検出し、
関数オブジェクトにキャプチャされた変数の値を持たせる。

```
// コンパイル時
inner の bytecode で n を参照 → n は outer のローカル
→ inner の upvalue リストに { parentSlot: 0, name: "n" } を追加
→ inner の bytecode を LdaGlobal "n" → LdaUpvalue 0 に変更

// 実行時
outer(1) を呼ぶ → outer の locals[0] = 1 (n)
→ inner の関数オブジェクトを生成するとき、outer.locals[0] の値をキャプチャ
→ inner.upvalues = [1]
→ inner(5) を呼ぶ → LdaUpvalue 0 → upvalues[0] = 1 → 1 + 5 = 6
```

---

## 11-0. Upvalue の型定義

- [x] `BytecodeFunction` に `upvalues` 情報を追加
  ```typescript
  type UpvalueInfo = {
    name: string;
    parentSlot: number;  // 親関数のローカルスロット番号
  };
  // BytecodeFunction.upvalues: UpvalueInfo[]
  ```
- [x] 新しい opcode: `LdaUpvalue <index>`, `StaUpvalue <index>`
- [x] VM の CallFrame に `upvalueValues: unknown[]` を追加

---

## 11-1. コンパイラ — Upvalue の検出

- [x] 子コンパイラが変数を解決するとき:
  1. 自分のローカルにある → `LdaLocal`
  2. 自分のローカルにない + 親のローカルにある → `LdaUpvalue` (upvalue として登録)
  3. どこにもない → `LdaGlobal`
- [x] `resolveLocal` を拡張: 親コンパイラのローカルを再帰的に探索
- [x] 子コンパイラの `upvalues` リストにキャプチャ情報を記録
- [x] テスト: `inner` のバイトコードに `LdaUpvalue 0` が出ること

---

## 11-2. VM — Upvalue の実行

- [x] `LdaConst` で BytecodeFunction をスタックに push するとき:
  - 親フレームの locals から upvalue の値をキャプチャ
  - 関数オブジェクトに `capturedValues: unknown[]` を付与
- [x] `Call` で関数を呼ぶとき:
  - CallFrame に `upvalueValues` を設定
- [x] `LdaUpvalue <index>` — `frame.upvalueValues[index]` を push
- [x] `StaUpvalue <index>` — `frame.upvalueValues[index]` に store
- [x] テスト: `outer(1)(5)` が 6 を返す

---

## 11-3. ミュータブルなキャプチャ

- [x] キャプチャした変数を内側から書き換えるケース:
  ```js
  function counter() {
    var count = 0;
    return function() { count = count + 1; return count; };
  }
  var c = counter();
  c(); // 1
  c(); // 2
  ```
- [x] 値コピーではなく **参照** でキャプチャする必要がある
  - Lua の upvalue: ローカル変数への参照 (open upvalue) → 関数終了時に値をコピー (closed upvalue)
  - シンプル版: 配列の要素への参照 `{ value: unknown }` ボックス
- [x] テスト: counter パターン

---

## 11-4. compat テスト + ベンチマーク

- [x] compat.test.ts にクロージャテストケースを追加:
  - `function f(n) { return function(m) { return n + m; }; } f(5)(10);` → 15
  - `function counter() { var c = 0; return function() { c = c + 1; return c; }; } var inc = counter(); inc(); inc();` → 2
  - forEach + コールバックで外側変数を参照
- [x] 既存テスト全パス
- [x] Phase 10E-5 のクロージャ JIT が VM 上でも動くことを確認

---

## 実装フロー

```
11-0: Upvalue 型定義 + opcode 追加
  ↓
11-1: コンパイラで upvalue 検出 (LdaGlobal → LdaUpvalue)
  ↓
11-2: VM で upvalue 実行 (キャプチャ + LdaUpvalue)
  ↓
11-3: ミュータブルキャプチャ (counter パターン)
  ↓
11-4: テスト + ベンチ
```

11-1 と 11-2 が本体。11-3 は発展 (値コピーから参照キャプチャへ)。

---

## 設計メモ

### 値コピー vs 参照キャプチャ

**値コピー (シンプル)**:
```
outer(1) → inner を生成するとき n=1 をコピー → inner.upvalues = [1]
```
- 読み取りのみのクロージャには十分
- `makeAdder(n)` パターンはこれで動く

**参照キャプチャ (正確)**:
```
counter() → count=0 をボックスに包む → { value: 0 }
→ inner.upvalues = [ボックスへの参照]
→ inner 内で count++ → ボックス.value = 1
→ 次の inner 呼び出しでもボックス.value = 1 が見える
```
- 書き換えのあるクロージャに必要
- counter パターン、forEach + sum パターン

### Phase 11 の範囲

まず **値コピー** (11-0 ~ 11-2) で makeAdder パターンを動かす。
次に **参照キャプチャ** (11-3) で counter パターンを動かす。
