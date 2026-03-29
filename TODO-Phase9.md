# TODO — Phase 9: 独自文字列表現

## 狙っている効果

### 1. 「V8 がなぜ std::string を使わないのか」を体験で理解する

jsmini は現在 V8 の `string` 型をそのまま使っている（タダ乗り）。
文字列連結 `"a" + "b"` は V8 の ConsString が裏で動いている。
独自実装することで **文字列のデータ構造が性能にどう影響するか** を実体験する。

### 2. ConsString で連結を O(1) にする

ナイーブな文字列連結は毎回全体をコピーするので O(N)。
ループで 1000 回連結すると O(N^2) になる。
ConsString は左右のポインタを持つだけなので O(1)。

```js
var s = "";
for (var i = 0; i < 1000; i = i + 1) {
  s = s + "x";  // ナイーブ: 毎回コピー O(i) → 合計 O(N^2)
}                // ConsString: ポインタ追加 O(1) → 合計 O(N)
```

**ただし jsmini は V8 の上で動くので、V8 の ConsString が既に効いている。
独自の ConsString に置き換えると V8 のものより遅くなる可能性が高い。**

### 3. 教育的な価値

速くなることが目的ではなく、**以下を理解すること** が目的:

- **なぜ文字列は immutable か** — 変更のたびにコピーが必要だから。ConsString で回避
- **なぜ V8 は 5 種類の文字列表現を持つか** — SeqString, ConsString, SlicedString, ThinString, ExternalString それぞれに理由がある
- **なぜ intern 化するか** — `===` をポインタ比較にするため。プロパティ名の比較が O(1) になる
- **なぜエンコーディングを使い分けるか** — ASCII は 1 byte、Unicode は 2 byte。メモリ半減

### 4. Phase 7-8 と同じパターンの学び

Phase 7-8 (Hidden Class + IC) で学んだこと:
- **VM レベルでは V8 のネイティブ実装に勝てない**
- **JIT で初めて効果が出る**

Phase 9 でも同じことが起きるはず:
- 独自文字列に置き換えると **VM は遅くなる** (V8 の string が最適化されているから)
- **データ構造を理解した上で「だから V8 は C++ で書く」と結論付ける** のが学び

### 5. 期待される計測結果

```
文字列連結ベンチ (1000 回):
  V8 の string:         Xms (V8 の ConsString が効く)
  独自 SeqString のみ:  遅い (毎回コピー)
  独自 ConsString:      V8 の string より遅いが O(N^2) は回避
```

## 注意

- **速くすることが目的ではない。** 理解することが目的
- V8 の string を独自実装に置き換えると **全テストに影響する** (~840 行の変更)
- Phase 6-8 と違い JIT との連携はスコープ外 (Wasm で文字列は扱えない)

---

## 実装タスク

### 9-0. JSString データ構造

- [ ] `src/vm/js-string.ts`
  ```typescript
  type SeqString = { kind: "seq"; data: Uint8Array; length: number };
  type ConsString = { kind: "cons"; left: JSString; right: JSString; length: number };
  type SlicedString = { kind: "sliced"; parent: JSString; offset: number; length: number };
  type JSString = SeqString | ConsString | SlicedString;
  ```
- [ ] `createSeqString(str)` — JS string → SeqString (UTF-8 エンコード)
- [ ] `flatten(str)` — ConsString/SlicedString → SeqString
- [ ] `jsStringToString(str)` — JSString → JS string (UTF-8 デコード)
- [ ] `jsStringConcat(a, b)` — 短ければ SeqString、長ければ ConsString
- [ ] `jsStringSlice(str, start, end)` — SlicedString
- [ ] `jsStringEquals(a, b)` — 文字列比較
- [ ] `jsStringCharAt(str, index)` — 1 文字取得
- [ ] テスト: 生成、連結、slice、比較、flatten

### 9-1. VM の文字列操作を差し替え

- [ ] `Add` — 文字列連結を `jsStringConcat` に
- [ ] `LdaConst` — 文字列リテラルを `createSeqString` で変換
- [ ] `StrictEqual` / `Equal` — 文字列比較を `jsStringEquals` に
- [ ] テンプレートリテラル — 連結を `jsStringConcat` に
- [ ] `console.log` — JSString を JS string に変換して表示
- [ ] テスト: 既存テスト全パス

### 9-2. TW の文字列操作を差し替え

- [ ] evaluator.ts の全文字列操作を JSString 対応に
- [ ] テスト: 既存テスト全パス

### 9-3. 型変換

- [ ] `Number → JSString` (数値の文字列化)
- [ ] `JSString → Number` (文字列の数値化)
- [ ] `Boolean → JSString`
- [ ] `typeof` で JSString を "string" と返す

### 9-4. Intern 化 (オプション)

- [ ] 文字列リテラルとプロパティ名を intern テーブルに登録
- [ ] `===` を intern 済みならポインタ比較に

### 9-5. ベンチマーク + ドキュメント

- [ ] 文字列連結ベンチ: V8 string vs 独自 SeqString vs 独自 ConsString
- [ ] `LEARN-String.md` 作成
- [ ] `BENCHMARK.md` 更新

---

## 実装フロー

```
9-0: JSString データ構造 + 基本操作
  ↓
9-1: VM の文字列操作を差し替え
  ↓
9-2: TW の文字列操作を差し替え
  ↓
9-3: 型変換
  ↓
9-4: Intern 化 (オプション)
  ↓
9-5: ベンチ + docs
```

9-0 はデータ構造のみ。9-1 と 9-2 が本体 (全テストに影響)。
9-4 は余裕があれば。
