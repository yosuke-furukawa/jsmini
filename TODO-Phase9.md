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

## 注意: 性能劣化が起きることを承知で実装する

### 劣化の原因

jsmini は V8 の上で動いている。V8 の `string` は C++ で実装された ConsString/SlicedString/Intern 化が既に効いている。これを JS で書いた独自 JSString に置き換えると:

- V8 の最適化された文字列操作を **捨てる**
- 代わりに jsmini の JSString 操作が **V8 のインタプリタ経由で実行される**
- Phase 7-8 で `obj[name]` が遅くなったのと同じ構造

### 影響範囲

**TW への影響:**
- `"hello" + " world"` — V8 の ConsString (O(1)) → 独自 jsStringConcat (JS 関数呼び出し + コピー)
- `obj[name]` — プロパティ名が JSString だと V8 に渡す前に JS string に変換が毎回必要
- テンプレートリテラル — 連結のたびに JSString 操作
- 文字列比較 (`===`) — V8 のインターン化された参照比較 → 独自 jsStringEquals (バイト比較)

**VM への影響:**
- 定数テーブルの文字列が JSString になるので `LdaConst` のたびに変換コスト
- `Add` の文字列連結パスが重くなる
- `StrictEqual` の文字列比較パスが重くなる
- Hidden Class のプロパティ名比較も影響 (lookupOffset で Map.get に JSString を渡す)

**Wasm JIT への影響:**
- Wasm 内では文字列を扱わないので **直接の影響はない**
- ただし JIT コンパイル時に関数名・プロパティ名の比較で JSString → JS string 変換が入り間接的に遅くなる

**最も深刻: V8 との境界**
```
jsmini 内部: JSString で操作
         ↕ 変換コスト
V8 との境界: console.log, obj[name], typeof 等は JS string が必要
```

この変換が **全プロパティアクセスで毎回走る** と壊滅的に遅くなる。
Phase 7 で Hidden Class のプロパティ名を `obj.__hc__` 等の JS string でアクセスしているので、
ここが JSString になると HC の仕組みも影響を受ける。

### なぜそれでもやるのか

1. **「V8 の string をタダ乗りしている」ことを可視化する** — 今は V8 のおかげで速い。外すと何が起きるかを体験する
2. **文字列の内部表現の設計判断を理解する** — ConsString にする閾値 (V8 は 13 文字以上)、Flatten のタイミング、エンコーディングの使い分け
3. **「だから本物のエンジンは C++ で文字列を書く」** — Phase 7-8 の結論と同じ。JS の上に JS を重ねても遅くなるだけ
4. **書籍の章として成立する** — 「文字列の章」で ConsString/SlicedString を説明するとき、実装経験があると解像度が全然違う

---

## 実装タスク

### 9-0. JSString データ構造

- [x] `src/vm/js-string.ts`
  ```typescript
  type SeqString = { kind: "seq"; data: Uint8Array; length: number };
  type ConsString = { kind: "cons"; left: JSString; right: JSString; length: number };
  type SlicedString = { kind: "sliced"; parent: JSString; offset: number; length: number };
  type JSString = SeqString | ConsString | SlicedString;
  ```
- [x] `createSeqString(str)` — JS string → SeqString (UTF-8 エンコード)
- [x] `flatten(str)` — ConsString/SlicedString → SeqString (キャッシュ付き)
- [x] `jsStringToString(str)` — JSString → JS string (UTF-8 デコード)
- [x] `jsStringConcat(a, b)` — 13 文字未満は SeqString、以上は ConsString
- [x] `jsStringSlice(str, start, end)` — 短ければ SeqString、長ければ SlicedString
- [x] `jsStringEquals(a, b)` — 参照比較 → 長さ比較 → バイト比較
- [x] `jsStringCharAt(str, index)` — 1 文字取得
- [x] `numberToJSString`, `booleanToJSString`, `jsStringToNumber` — 型変換
- [x] テスト: 21 テスト全パス

### 9-1. VM の文字列操作を差し替え

- [x] `LdaConst` — 文字列リテラルを `createSeqString` で JSString に変換
- [x] `Add` — JSString 判定して `jsStringConcat` で連結
- [x] `Equal` / `StrictEqual` / `NotEqual` / `StrictNotEqual` — `jsStringEquals`
- [x] `TypeOf` — JSString なら `createSeqString("string")` を返す
- [x] `GetPropertyComputed` / `SetPropertyComputed` — JSString キーを JS string に変換
- [x] `In` — JSString キーを JS string に変換
- [x] `console.log` — JSString → JS string に変換して表示
- [x] 返り値 — JSString → JS string に変換
- [x] テンプレートリテラル — LdaConst + Add 経由で自動的に JSString 対応
- [x] テスト: 全 475 テストパス

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
