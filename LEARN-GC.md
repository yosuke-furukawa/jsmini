# GC で学んだこと

jsmini の Phase 10 で Mark-and-Sweep GC を実装する中で得た知見をまとめる。

---

## 1. なぜ GC が必要か

jsmini の Vec class ベンチ (1000 iter) では:

```
var sum = new Vec(0, 0);
for (var i = 0; i < 1000; i = i + 1) {
  sum = sum.add(new Vec(i, i * 2));
}
```

ループのたびに `new Vec()` で新しいオブジェクトが 2 つ生成される (引数の Vec + add の結果)。しかし古い `sum` はもう参照されない。

GC なし → 2002 個のオブジェクトがメモリに残り続ける。
GC あり → 1998 個が回収され、最終的に 4 個だけ残る。

```
heap: alloc=2002 peak=1002 final=4 gc=2x swept=1998
```

実際のプログラムでは関数呼び出しのたびにオブジェクトが生成される。GC がなければメモリは増え続ける。

---

## 2. Mark-and-Sweep の仕組み

### ルートセット

「生きている」オブジェクトの起点。jsmini では:

- **グローバル変数** — `globals` Map の全値
- **スタック** — `stack[0..sp]` の全値
- **CallFrame** — 各フレームの `locals[]` と `thisValue`
- **定数テーブル** — バイトコード関数の `constants[]`

### Mark フェーズ

ルートセットから辿れる全オブジェクトに印をつける:

```
root (sum) → Vec { x: 499500, y: 999000 }
  → __proto__ → prototype { add: ..., dot: ... }
    → add (BytecodeFunction) → constants [...]

→ 3 個が mark される
```

辿り方はオブジェクトの種類ごとに異なる:
- **JSObject** — `__slots__` の全要素を再帰的に辿る
- **JSString (ConsString)** — `left` と `right` を辿る
- **JSArray** — 全要素を辿る
- **一般オブジェクト** — `Object.keys` で全プロパティを辿る

循環参照は `visited` Set で検出し、再訪しない。

### Sweep フェーズ

ヒープ上の全オブジェクトを走査し、mark されていないものを除去:

```
ヒープ: [Vec✓, Vec✗, Vec✗, Vec✗, ..., prototype✓]
              ↑ mark あり = 残す
                    ↑ mark なし = 除去
```

Sweep 後、残ったオブジェクトの mark をリセットして次の GC サイクルに備える。

---

## 3. Stop-the-world

GC の mark フェーズ中に JS が動くと、オブジェクトの参照関係が変わる:

```
mark 中:
  GC: obj.child を辿ろうとしている
  JS: obj.child = null に書き換えた  ← GC が古い参照を辿ってしまう
```

これを防ぐために Mark-and-Sweep は **Stop-the-world** — GC 中は JS の実行を完全に停止する。

jsmini では VM の `maybeGC()` が dispatch ループの中で呼ばれ、GC が終わるまで次の命令を実行しない。シンプルだが、GC が長いとプログラムが一時停止する。

V8 の解決策:
- **Incremental marking** — mark を少しずつ進め、JS の実行と交互に行う
- **Concurrent sweeping** — sweep を別スレッドで実行
- **Write barrier** — JS がオブジェクトを書き換えたとき GC に通知

jsmini ではこれらは実装していない。「Stop-the-world がなぜ問題で、どう解決するか」を知っているだけで十分。

---

## 4. GC のコスト

### 計算量

- **Mark**: 生きているオブジェクト数に比例 O(live)
- **Sweep**: 全オブジェクト数に比例 O(total)
- **合計**: O(total) — ヒープが大きいほど遅い

### jsmini の実測

```
Vec class (1000 iter):
  GC 1 回目: heap 1000 → mark 1, sweep 999 → heap 1
  GC 2 回目: heap 1001 → mark 1, sweep 1000 → heap 1
```

ほとんどのオブジェクトがすぐ死ぬ (mark 1 / sweep 999)。これが **Generational hypothesis** — 「大半のオブジェクトは若くして死ぬ」。

### GC のオーバーヘッド

jsmini のベンチでは GC のオーバーヘッドは計測誤差レベル。理由:
- mark: 生存オブジェクトが 1-4 個しかないので一瞬で終わる
- sweep: 配列の filter 操作で、V8 が最適化している

実際のプログラムでは生存オブジェクトが何万個にもなり、mark のコストが増える。

---

## 5. なぜ Generational GC が必要か

Mark-and-Sweep は毎回全オブジェクトを走査する。生存オブジェクトが 10 万個あれば 10 万個辿る。

**Generational hypothesis**: 大半のオブジェクトはすぐ死ぬ。

jsmini の Vec ベンチでは:
```
1000 回 new Vec() → 999 個がすぐ死ぬ (99.9%)
                    1 個だけ生き残る (sum)
```

Generational GC:
- **Young generation (Nursery)**: 新しいオブジェクト。Minor GC で頻繁に回収
  - 小さい領域だけ走査するので高速
  - 99% のオブジェクトがここで死ぬ
- **Old generation (Tenured)**: 何回かの Minor GC を生き延びたオブジェクト
  - Major GC で回収 (低頻度)

V8 の Orinoco GC:
```
Minor GC (Scavenge): Young generation だけ走査。数 ms
Major GC (Mark-Compact): 全世代を走査。数十 ms ~ 数百 ms
  + Incremental: 少しずつ mark
  + Concurrent: 別スレッドで sweep
  + Compaction: メモリの断片化を解消
```

jsmini は Mark-and-Sweep のみ。Generational は「知っている」だけで十分。

---

## 6. ヒープの統計で見える GC の効果

ベンチマーク結果のヒープ統計:

```
Vec class (1000 iter):
  alloc=2002 peak=1002 final=4 gc=2x swept=1998

quicksort (200 x10):
  alloc=10 peak=10 final=10 gc=0x swept=0

fibonacci(25):
  alloc=0 peak=0 final=0 gc=0x swept=0
```

- **Vec class**: 大量の一時オブジェクト → GC が頻繁に走る → peak 1002 で抑えられる
- **quicksort**: 配列 10 個だけ → GC 不要
- **fibonacci**: オブジェクト生成なし → GC 不要

GC が必要なのは **オブジェクトを大量に生成するプログラム**。数値計算や配列操作だけなら GC は走らない。

---

## 7. V8 の GC と jsmini の GC の違い

| 特性 | jsmini | V8 (Orinoco) |
|------|--------|-------------|
| アルゴリズム | Mark-and-Sweep | Generational + Mark-Compact |
| 世代 | なし (全部同じ) | Young + Old |
| 並行性 | Stop-the-world | Incremental + Concurrent |
| Compaction | なし (断片化する) | Mark-Compact で解消 |
| Write barrier | なし | あり (Old→Young 追跡) |
| 実装言語 | TypeScript | C++ |

jsmini の GC は **最もシンプルな GC**。V8 の GC は数十年の最適化の結果。しかし根本原理は同じ: **到達可能なオブジェクトを残し、それ以外を回収する**。

---

## まとめ

GC は「メモリを解放する仕組み」以上のもの:

1. **ルートセットの概念** — 何が「生きている」かの定義
2. **到達可能性** — 参照のグラフ構造を辿る
3. **Stop-the-world** — GC と実行の排他制御
4. **Generational hypothesis** — 若いオブジェクトの短命さを利用
5. **コストのトレードオフ** — GC の頻度と停止時間のバランス

jsmini で Mark-and-Sweep を実装したことで、V8 の Orinoco GC が **なぜ Generational + Incremental + Concurrent** という複雑な構成になっているかが体感で理解できた。
