# PLAN v6 — Built-in 拡充

## 動機

jsmini は Lexer → Parser → VM → JIT → IR → Promise/async のパイプラインが揃った。
しかし built-in オブジェクトが不足しているため、test262 の通過率が伸びず、
SunSpider/Octane 等のベンチスイートも動かない。

test262 Promise テスト: 320/652 (49.1%) — 失敗の多くは built-in 不足が原因。

## 優先度

### P0: test262 通過率に直結

| Built-in | 理由 | 規模 |
|---|---|---|
| **Object.defineProperty / getOwnPropertyDescriptor** | test262 ハーネス (propertyHelper.js) が依存。これがないとプロパティ検査系テストが全滅 | 中 |
| **Object.getPrototypeOf / setPrototypeOf** | prototype チェーン検査 | 小 |
| **Object.getOwnPropertyNames** | プロパティ列挙 | 小 |
| **Promise.withResolvers** | test262 の 6 テスト | 小 |

### P1: モダン JS の基本

| Built-in | 理由 | 規模 |
|---|---|---|
| **Map / Set** | モダン JS で多用。for-of 対応済みなので Iterator で回せる | 中 |
| **WeakMap / WeakSet** | GC 連携。Map/Set の後に | 中 |
| **Date** | 日付操作、`Date.now()` でタイミング計測 | 中 |
| **Math 三角関数** (sin, cos, tan, atan2 等) | SunSpider 3D 系ベンチ、科学計算 | 小 |

### P2: ベンチスイート対応

| Built-in | 理由 | 規模 |
|---|---|---|
| **RegExp** | SunSpider 4 テスト + Octane 1 テスト + 文字列メソッド (match, replace) | 大 |
| **Typed Arrays** (Uint8Array, Int32Array, ArrayBuffer, DataView) | Octane zlib/Mandreel | 大 |

### P3: メタプログラミング

| Built-in | 理由 | 規模 |
|---|---|---|
| **Reflect** (apply, construct, defineProperty, ...) | test262 ハーネス、Proxy と連携 | 中 |
| **Proxy** | メタプログラミング、Vue/Mobx 等のリアクティブ | 大 |

## ステップ案

### Phase 25: Object メタ + Promise.withResolvers

- Object.defineProperty / getOwnPropertyDescriptor
- Object.getPrototypeOf / setPrototypeOf
- Object.getOwnPropertyNames / getOwnPropertySymbols
- Promise.withResolvers
- test262 再計測

### Phase 26: Math 三角関数 + Date

- Math: sin, cos, tan, asin, acos, atan, atan2, exp, log2, log10, hypot, cbrt
- Date: コンストラクタ, Date.now(), getTime, getFullYear, getMonth 等
- SunSpider math/date ベンチ試行

### Phase 27: Map / Set

- Map: コンストラクタ, get, set, has, delete, size, forEach, keys, values, entries, Symbol.iterator
- Set: コンストラクタ, add, has, delete, size, forEach, values, Symbol.iterator
- WeakMap / WeakSet (GC 連携)

### Phase 28: RegExp (大きい)

- RegExp リテラル (`/pattern/flags`) の Lexer/Parser 対応
- NFA ベースの正規表現エンジン (基本: `.`, `*`, `+`, `?`, `[]`, `^`, `$`, `|`, `()`)
- String.prototype: match, matchAll, search, replace (RegExp 版)
- test262 RegExp テスト + SunSpider regexp ベンチ

## 期待される効果

| Phase | test262 への影響 |
|---|---|
| 25 (Object メタ) | propertyHelper.js が動く → 多数のテストが unblock |
| 26 (Math/Date) | 小さいが SunSpider 対応 |
| 27 (Map/Set) | モダン JS テストが通る |
| 28 (RegExp) | test262 + SunSpider + Octane で大幅改善 |

## 方針

- 各 Phase は小さく保つ (1-2 日で完了)
- test262 の通過率を各 Phase 後に計測
- SunSpider/Octane の個別テスト実行可能性を Phase ごとに確認
- 教育的価値: 各 built-in がエンジン内部でどう実装されるかを LEARN に記録
