# NODE_PROBLEMS.md — Node.js lib/ を jsmini の JIT 視点で読む

jsmini で実装してきた JIT 技術 (Phase 29〜39) を物差しに、Node.js 本体の
`lib/` (JS 実装の標準 API) から「この種の method JIT が構造的に効かないコード」を
洗い出したメモ。行番号は nodejs/node main ブランチ (2026-07 時点)。

対応する jsmini の技術:
- i32/f64 の関数単位型特殊化 + range 分析 (Phase 29, 37)
- 30bit Smi tagged slots (数値/bool/null/undefined/参照タグ, Phase 33, 36-5)
- hidden class + inline cache (単型前提)
- クラスタコンパイル (callee identity guard + 直接呼び出し解決, Phase 32)
- ネスト参照 deref の `__load_slot` import + DEOPT_SENTINEL
- spread 呼び出し等は ExecStmt フォールバック (JIT どころか bytecode 化もされない)
- try/catch 入り関数は wasm 化対象外 (VM 専用)

## 1. 型多相スロット + 辞書オブジェクト — events.js

```js
// lib/events.js:567-586 (addListener)
existing = events[type];
if (typeof existing === 'function') {
  existing = prepend ? [listener, existing] : [existing, listener];  // 関数→配列に変異
}
// lib/events.js:508-513 (emit)
const handler = events[type];          // undefined | function | array の 3 態
if (typeof handler === 'function') { ... }
```

- `_events[type]` は **undefined → 関数 → 配列** と型が変わる設計。
  jsmini の classifyTaggedProps は「消費者が許可リスト内の単型」前提なので即 demote。
- `_events` は**イベント名を動的キーにする辞書** → hidden class が発散して
  IC は毎回ミス (jsmini の IC は単型キャッシュ)。
- V8 は polymorphic IC (4-way) + megamorphic stub cache で受けるが、
  それでも emit は歴史的に高速化に苦労してきた典型。

## 2. 間接呼び出しの徹底 (primordials) — クラスタコンパイル殺し

```js
// lib/internal/per_context/primordials.js:23
const uncurryThis = bind.bind(call);
// "... after it may have been mutated by users." (原文コメント)
```

- lib/ 全体が `StringPrototypeSlice(str, ...)` のような **bound function 経由の
  間接呼び出し**で書かれている (プロトタイプ汚染への防御)。
- jsmini のクラスタ (Phase 32) は「callee がコンパイル時に既知の
  BytecodeFunction」で identity guard を張る方式 → bound + host 関数の壁で
  inline も直接呼び出し解決も全滅。
- **速度より堅牢性を選んだ意図的設計**であり、V8 が bind を貫通最適化できる
  から成立している書き方。素朴な method JIT には最悪の敵。

## 3. Smi/i32 範囲を超える数値 — timers.js のミリ秒演算

```js
// lib/internal/timers.js:401-402
const msecs = item._idleTimeout;
if (msecs < 0 || msecs === undefined) ...
```

- タイマー起点は `Date.now()` 系ミリ秒 (~1.7e12) → jsmini の 30bit Smi
  (±5.4 億) にも i32 (±21 億) にも入らず**常に f64 昇格** (Phase 37 の教訓の
  全面適用形)。整数高速パスは効かない。
- さらに `number | undefined` の union でタグ混在。

## 4. ネスト参照 deref — timers の双方向リンクリスト

```js
// lib/internal/timers.js:41-47 のコメント図
// TimersList { _idleNext: { }, _idlePrev: (self) }   ← 循環参照
```

- `item._idleNext._onTimeout` のようなチェーン歩きは、jsmini では
  `__load_slot` import 経由で危険検出のたび DEOPT_SENTINEL。
  richards の `TCB.link` で経験した「ポインタチェーンは wasm 内に閉じられない」
  代表格。

## 5. 可変長引数 + spread — emit / ReflectApply

- `emit(...args)` / `ReflectApply(handler, this, args)` — jsmini では spread
  呼び出しは ExecStmt フォールバックで **JIT どころか bytecode にもならない**。
- Node が昔 emit を「引数 0〜3 個で switch して apply を避ける」実装にしていた
  のは、この領域が JIT に厳しいことへの配慮そのもの。

## 6. その他の敵対パターン

- **util.inspect / assert.deepEqual**: 任意 shape の再帰走査 = 本質的
  megamorphic。getter throw 対策の try/catch だらけ → jsmini は try/catch
  入り関数を wasm 化できず永遠に VM。V8 ですら inspect は遅い
- **async_hooks / `Module._extensions` / `require.cache`**: 実行時に関数や
  ディスパッチテーブルを差し替える設計 → identity guard が定常的に破れて
  deopt ループ
- **fs の bigint stats / `hrtime.bigint()`**: jsmini は BigInt 不在。
  V8 でも BigInt は heap オブジェクトで Smi 系最適化の外
- **EventTarget**: defineProperty + accessor 定義だらけ → jsmini は accessor
  が VM でも未対応 (PROBLEMS.md §2)

## 7. 逆に「効く」コード

`path.js` / `string_decoder` / `querystring` の **charCodeAt ループ**:
i32 単型・数値比較分岐・固定 shape で、jsmini の i32 特殊化がそのまま刺さる形。
lib/ 内でも文字列パーサ系は JIT フレンドリー。

## まとめ

Node の lib/ は「防御的設計 (primordials・動的差し替え・辞書オブジェクト) を
速度より優先」しており、jsmini 流の楽観的特殊化 + deopt では events / timers /
inspect あたりが構造的に効かない。それでも Node が速いのは V8 側が
polymorphic IC・bound function 貫通・megamorphic stub cache でこの書き方を
受け止めているからで、**「エンジンが賢いから標準ライブラリは堅牢側に振れる」
という分業**が見える。

jsmini 側への示唆 (将来フェーズ候補):
- polymorphic IC (2〜4 way) — events 型の辞書 + 多相スロットへの現実解
- bound function の貫通 (bind 済み関数の callee 解決)
- 可変長引数の JIT 対応 (spread の ExecStmt 脱却)
- try/catch 入り関数の wasm 化 (wasm の try_table 命令 or handler 分割)
