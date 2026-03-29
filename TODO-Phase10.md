# TODO — Phase 10: GC (Mark-and-Sweep)

## 狙い

Phase 7-9 で独自オブジェクト (JSObject, JSArray, JSString) を大量に生成するようになった。
今は V8 の GC に丸投げしているが、**自前の GC を実装して「GC とは何か」を体験する**。

### 学べること

1. **なぜ GC が必要か** — `new` するたびにメモリが増え、解放しないと溢れる
2. **ルートセットとは何か** — グローバル変数、スタック、CallFrame の locals が「生きている」オブジェクトの起点
3. **Mark-and-Sweep の仕組み** — ルートから辿って mark、mark されてないものを sweep
4. **Stop-the-world とは何か** — GC 中は JS の実行を停止する必要がある
5. **GC のコスト** — mark は生きているオブジェクト数に比例、sweep は全オブジェクトを走査
6. **なぜ Generational GC か** — 大半のオブジェクトはすぐ死ぬ (generational hypothesis)

### 性能への影響

Phase 7-9 と同じく、自前 GC は V8 の GC より遅い。教育目的。

---

## 10-0. ヒープアロケータ

- [x] `src/vm/heap.ts` — 全ヒープオブジェクトを追跡するアロケータ
  ```typescript
  type HeapObject = {
    marked: boolean;
    value: unknown;  // JSObject, JSString, JSArray 等
  };

  class Heap {
    objects: HeapObject[];
    allocate(value: unknown): HeapObject;
    size(): number;
  }
  ```
- [x] `allocate` — オブジェクトをヒープに登録して追跡
- [x] `size()` — 現在のヒープ上のオブジェクト数
- [x] テスト: allocate + size

---

## 10-1. Mark フェーズ

- [x] `mark(roots: unknown[])` — ルートセットから到達可能なオブジェクトに mark をつける
  - ルートセット: グローバル変数 (globals Map)、スタック、CallFrame の locals
  - 再帰的に辿る: JSObject の __slots__、JSArray の要素、ConsString の left/right
- [x] mark 済みオブジェクトは再訪しない (無限ループ防止)
- [x] テスト: mark で到達可能なオブジェクトだけ mark される

---

## 10-2. Sweep フェーズ

- [x] `sweep()` — mark されていないオブジェクトをヒープから除去
  - mark されたオブジェクトは mark を false にリセット (次の GC サイクル用)
- [x] sweep 後のヒープサイズが減ることを確認
- [x] テスト: 参照されていないオブジェクトが回収される

---

## 10-3. VM に GC を組み込む

- [x] VM クラスに Heap を持たせる
- [x] `CreateObject` / `CreateArray` / 文字列連結で allocate を呼ぶ
- [x] GC トリガー: allocate 回数が閾値を超えたら mark + sweep
- [x] ルートセットの収集:
  - `this.globals` の全値
  - `this.stack[0..sp]`
  - 全 CallFrame の `locals[]`
  - 全 CallFrame の `thisValue`
- [x] テスト: GC 後も正常に動作 (既存テスト全パス)

---

## 10-4. GC の可視化

- [x] GC ログ: いつ GC が走ったか、何オブジェクト mark / sweep されたか
  ```
  [GC] heap: 1024 objects → mark: 512, sweep: 512 → heap: 512 objects
  ```
- [x] `--trace-gc` フラグ (または vmEvaluate のオプション) で有効化
- [x] playground で GC ログを表示

---

## 10-5. ベンチマーク + ドキュメント

- [x] GC あり/なしのベンチマーク比較
- [x] GC のオーバーヘッドを計測
- [x] Vec class (1000 iter) で GC の挙動を確認
  - 1000 回 `new Vec()` で生成、ループ後に古い Vec が GC 対象に
- [ ] `LEARN-GC.md` 作成
- [x] `BENCHMARK.md` 更新

---

## 実装フロー

```
10-0: Heap アロケータ (オブジェクト追跡)
  ↓
10-1: Mark (ルートから到達可能なオブジェクトに印)
  ↓
10-2: Sweep (印なしオブジェクトを回収)
  ↓
10-3: VM に組み込む (GC トリガー + ルートセット)
  ↓
10-4: GC の可視化 (ログ)
  ↓
10-5: ベンチ + docs
```

10-0〜10-2 はデータ構造とアルゴリズム。10-3 が本体 (VM 変更、テスト全パス必須)。

---

## 設計メモ

### なぜ Stop-the-world か

GC 中に JS が動くとオブジェクトの参照関係が変わり、mark の結果が不正確になる。
V8 は Concurrent/Incremental GC で「JS を動かしながら GC」するが、実装が非常に複雑。
jsmini では最もシンプルな Stop-the-world (GC 中は VM を停止) で実装する。

### GC トリガーのタイミング

- 毎回の allocate でチェック → オーバーヘッドが大きい
- N 回の allocate ごと → シンプル。N = 1000 あたりから開始
- メモリ圧が高いとき → V8 方式だが計測が複雑

jsmini では「N 回の allocate ごと」で十分。

### Generational GC (Phase 10 のスコープ外)

- Young generation: 新しいオブジェクト。Minor GC で頻繁に回収
- Old generation: 何回か生き延びたオブジェクト。Major GC で回収
- Write barrier: Old → Young の参照を追跡

Phase 10 では Mark-and-Sweep のみ。Generational は説明にとどめる。

### Phase 10+ (Wasm GC) との関係

Phase 10 で自前 GC を理解 → Phase 10+ で Wasm GC に委譲。
「GC を自分で書いたからこそ、Wasm GC が何をしてくれるか理解できる」という流れ。
