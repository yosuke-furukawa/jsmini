# LEARN-Phase28.md — RegExp (Stage A: host 丸投げ)

## やったこと

PLAN-v6 P2 (ベンチスイート対応) の big rock。**Stage A** として host
RegExp を薄く wrap する路線で配線:

- **Lexer**: `/.../flags` を context-sensitive に判定 (除算 vs regex)
- **Parser**: AST に `RegExpLiteral` を追加
- **TW/VM ランタイム**: `RegExpLiteral` → host RegExp instance、`RegExp`
  グローバルを wrapper で公開
- **String.prototype.{match, replace, search, split, matchAll}**: RegExp
  引数版を vm.stringPrototype に追加 (replace の callback wrap 含む)
- **host-patches.ts**: `RegExp.prototype.test/exec` に JSString → string
  unwrap を一度だけパッチ
- **おまけ**: 文字列リテラル行継続 `"...\<newline>` の lexer 対応

50/50 phase28 テスト全パス、npm test 全 896/896、回帰なし。

**Stage B (自前 NFA)** は今フェーズではやらず Phase 29+ の候補に残す。

## 教訓

### 1. `/` の context-sensitive lexer 判定

JS の lexer で `/` は **直前 token に依存**。jsmini も同じ規則で対応:

```ts
function previousTokenAllowsRegex(): boolean {
  if (tokens.length === 0) return true;
  const prev = tokens[tokens.length - 1].type;
  const expressionEnding = [
    "Identifier", "Number", "String",
    "NoSubstitutionTemplate", "TemplateTail",
    "RightParen", "RightBracket",
    "PlusPlus", "MinusMinus",
    "True", "False", "Null", "This", "Super",
  ];
  return !expressionEnding.includes(prev);
}
```

これだけで `var r = /foo/i` も `a / b` も正しく分かれる。
**operator/keyword/open-paren の後 → regex、expression-ending の後 → 除算**。

落とし穴: `function f() { return\n /foo/.test(s) }` のような ASI 絡みは
本来 `return` で文が終わって `/foo/` は別文の expression、ただし jsmini
の ASI 実装次第。今回はテストで踏まなかったので深追いせず。

既存テスト `tokenize("+ - * / %")` (operator 並べただけ) は破綻するので
`"a + b - c * d / e % f"` に置き換えた。

### 2. 文字クラス `[...]` と escape `\/` を意識

regex リテラルを `/` 〜 `/` で雑に切ると `/[/]/` で死ぬ。
**`[` で inClass フラグを立てて `]` まで `/` を無視** + escape `\/`
を透過。フラグ部分は `[gimsuyd]+` を貪欲に読む:

```ts
let inClass = false;
while (pos < source.length) {
  const c = peek();
  if (c === "\\") { advance(); if (pos < source.length) advance(); continue; }
  if (c === "[") { inClass = true; advance(); continue; }
  if (c === "]") { inClass = false; advance(); continue; }
  if (c === "/" && !inClass) break;
  advance();
}
```

### 3. ES5 vs ES6 の "literal が同じ instance" 問題

`var r = /foo/g` が hot loop 内にあると、**ES5** は同一 instance、
**ES6** は毎回新 instance。jsmini の VM は constant pool に host RegExp
を入れて共有する形にしたので **ES5 セマンティクス**。

ES6 を厳密に守るには専用 opcode `CreateRegExp` を入れて、毎回 `new
RegExp(pattern, flags)` する必要がある。Stage A では割り切り。
test262 で `lastIndex` 周りの数十テストが落ちる程度。

### 4. RegExp.prototype.exec を patch するときの落とし穴

最初は `exec` の戻り値の matched substring を `internString` で JSString
化して、jsmini ユーザに返したかった。が、**host の
`String.prototype.replace` が内部で `re.exec(str)` を呼んで結果の host
string をそのまま使うため、JSString に置き換えると C++ レベルの
replace ロジックが壊れる**:

```js
"hello".replace(/l/g, "L")
// 期待: "heLLo"
// 実際 (intern を残した場合): "heL"  ← 1 回目で止まる
```

教訓: **「ユーザに見える境界」と「内部から呼ばれる境界」は同じ関数
オブジェクトを通る場合がある**。両方が成立する patch は引数の unwrap
だけに留めて、**結果の型を変えない** のが安全。

```ts
// host-patches.ts (採用版)
RegExp.prototype.exec = function(this: RegExp, s: unknown) {
  return origExec.call(this, isJSString(s) ? jsStringToString(s) : String(s));
};
// matched substring の intern はやらない
```

### 5. `String.prototype.replace(re, callback)` の callback ラップ

callback が host function なら `(...) => callback(...)` でいい。jsmini
の **BytecodeFunction や closure** を渡された場合は `vm.callFunction` を
通す必要がある。Phase 27 の Map.prototype.forEach パッチと同じレシピ。
TW 側は CallExpression で JSString メソッド呼び出しを intercept する
既存の path に乗せた。

### 6. String literal の **行継続** (line continuation) は ES1 から

`"abc\<newline>def"` は文字どおり改行を捨てて `"abcdef"` と等価。
SunSpider の regexp-dna.js が長い DNA 文字列をこの記法で書いている。
lexer の文字列パースに `\\` の後の改行を消費する分岐を追加するだけ:

```ts
if (peek() === "\\") {
  advance();
  if (peek() === "\n") { pos++; line++; column = 1; continue; }
  ...
}
```

## test262 結果

- pre (Phase 27 まで): Pass 5664 / 12162 (56.4%)
- post (Phase 28): Pass **6558 / 14573** (52.6%)

| ディレクトリ | 通過 | 全体 | 率 |
|---|---|---|---|
| built-ins/RegExp | 642 | 1879 | 34% |
| language/literals/regexp | 201 | 238 | **84%** |
| String/prototype/match | 35 | 51 | 69% |
| String/prototype/replace | 19 | 55 | 35% |
| String/prototype/search | 9 | 43 | 21% |
| String/prototype/split | 60 | 120 | 50% |
| String/prototype/matchAll | 13 | 25 | 52% |

**Lexer/Parser 系 (literals/regexp) は 84%** で強い。
**RegExp 本体は 34%** で、残り fail の多くは:

1. `buildString is not defined` (445 件) — test262 harness の `regExpUtils.js`
   を runner が読み込んでないため。実装すれば数百テスト一気に通る
2. 仕様の細かい部分: `lastIndex` の扱い、Symbol.replace/search、
   accessor descriptor、isConstructor/$262 等の harness 不足
3. `Test262Error` のサブクラス検出が弱い

`buildString` 取り込みは Phase 28 のスコープ外として残した。

## SunSpider 状況

`bench/sunspider/` に regexp-dna.js / string-tagcloud.js /
string-validate-input.js を取得。`var` 補完で strict mode 化しつつ、
`Array.prototype.toJSONString = ...` のような **built-in prototype 拡張**
パターンに対応するため engine 側にも手を入れて 3 本完動:

| ベンチ | TW | VM | JIT |
|---|---|---|---|
| regexp-dna | 21ms | 14ms | 14ms |
| string-tagcloud | 188ms | **123ms** | 122ms |
| string-validate-input | 223ms | 116ms | 122ms |

string-tagcloud は出力長が node と完全一致 (315244 chars)。

### 本当の教訓: TW と VM の "host への寄りかかり方" が非対称

string-tagcloud で **VM が TW より 10x 遅い** という結果が出た。表面的には
「sort が insertion sort だった」が原因だが、なぜそんな書き方をしたかと
いうと **TW と VM で host への delegation の境界がそもそも違う** のを
自分が把握しきれていなかった。これが 28-6 の本当の教訓:

#### TW: 薄いラッパーの集合 (delegating interpreter)

```ts
// src/interpreter/evaluator.ts
env.defineReadOnly("Array", Array);          // ← host Array を直接渡す
env.defineReadOnly("Number", Number);
// String/Map/Set は wrapper だが prototype は host を流用
```

`[1,2,3].sort(cmp)` を TW でやると、**host JS の Array.prototype.sort
(Timsort) が直接動く**。`cmp` が JSFunction だったら? — それは TW の
CallExpression が `evalCallWithJSFunction` で呼ぶ仕組みになっているので
host の sort が cmp(a, b) するときに JSFunction 呼び出しに繋がる。

#### VM: 自前 prototype テーブル (isolated runtime)

```ts
// src/vm/vm.ts: GetProperty
if (Array.isArray(obj) && name in this.arrayPrototype) {
  this.push(this.arrayPrototype[name]);   // ← VM 専用の table を最優先
}
```

```ts
// src/vm/index.ts
vm.arrayPrototype = {
  push: function(this) { ... },
  sort: function(this, fn) { /* 自前 insertion sort */ },
  map: function(this, fn) { /* 自前ループ + vm.callFunction */ },
  ...
};
```

VM は **`vm.arrayPrototype` という独自テーブル** を最優先で見る。これに
入っているメソッドは host JS のものを使わない。**結果として:**

- 各メソッドは VM 内で改めて実装する必要がある
- コールバックは `vm.callFunction(fn, ...)` で呼ぶ必要がある
- アルゴリズム自体も自前 = host より遅くなりがち

なぜこの設計にしたか? — おそらく早期に「VM は閉じていたほうが host と
独立で安全」という設計判断があり、後から `Array.prototype.foo = ...` の
ような extension fallback を追加した。

#### Phase 28-6 で踏んだバグは全部この非対称から来ている

| # | 修正 | TW では問題にならなかった理由 |
|---|---|---|
| 1 | `ArrayCtor.prototype = Array.prototype` | TW は `Array` を直接渡してたので user 拡張が host に乗る |
| 2 | JSString メソッドの host fallback | TW は元から host String.prototype にフォールバックしていた |
| 3 | `callJSFunctionSync` の this/hoist | TW の通常 call path が他にあって、これは別 path |
| 4 | VM の nested fn hoisting | TW は host JS の関数を生成するので host が hoist する |
| 5 | VM の for-in/of を local slot 化 | TW は host JS の for-of を使う、global 衝突しない |
| 6 | JSString の `<` `>` 比較 | TW は host operator が JSString を String 化、または独自比較で動いてた |
| 7 | hasOwnProperty 引数 unwrap | host-patches で globalThis に当てたので両者効く |
| 8 | stringPrototype.concat | TW は host fallback で勝手に解決 |
| 9 | sort O(N²) → host Timsort | TW は host sort なのでそもそも N log N |

**全部「TW は host に寄りかかって free で得てた振る舞いを、VM が独自
実装で再発明していて、再発明が不完全 or 遅かった」というパターン**。

#### 教訓

1. **VM/TW で挙動が違うバグに当たったら、まず「VM がここを独自実装
   している/していないか」を見る**。同じ仕様の二重実装はバグの温床。
2. **VM の独自実装は "boundary handling のための薄いラッパー" に留め、
   アルゴリズム本体は host に丸投げできる場面が多い**。今回の sort
   修正もその例 — comparator の wrap だけ自前、アルゴリズムは host。
3. **`vm.arrayPrototype` `vm.stringPrototype` は本質的に "host prototype
   と並走する第二の table"** で、両者の同期を取れていないと user 視点で
   謎の挙動になる。今後の Phase でメソッド追加するときは TW でも VM でも
   通るかをセットで確認する。

これは Phase 27 (Map/Set) でやった「test262 で host Map.prototype が
汚染されて jsmini 内部が壊れる」も同じ系統の話 — host との境界の
不徹底が原因。

### 「sloppy → strict」 patch のスタンス

SunSpider 1.0.2 (2010 年代製) は当時普通だった sloppy global 依存が散見
される。jsmini は教育目的で strict-only なので、ベンチを動かすときは
**テストファイル側に最小の `var` を足す方針**。git diff で原版との差
を確認可能。

date-format-tofte / date-format-xparb は更に深い sloppy global 連鎖が
あり別タスク。

### 副次効果: test262 +54 pass

上記の修正 (特に for-in 再帰、JSString 比較、hasOwnProperty unwrap) は
他のテストにも効いた。test262 (VM) は **6558 → 6612** に上昇。

## Stage B (自前 NFA エンジン) のスケッチ

Phase 28 範囲外だが LEARN として残す。教育的価値はここ:

```
Pattern → Lexer (regex token) → Parser → AST
  AST: { type: "Concat" | "Alt" | "Star" | "Plus" | "Opt" | "Group" | "CharClass" | "Char" | "Anchor", ... }
→ Thompson 構築 → NFA (epsilon transition + char transition)
→ 実行 (2 通り):
   - Russ Cox 風スレッド (re2): 線形時間保証、backreference 不可
   - バックトラック (V8/Perl): 表現力高、catastrophic backtracking 注意
```

実装目安:
- Lexer + Parser: ~150 行
- Thompson 構築: ~80 行
- NFA simulation (thread): ~120 行
- 文字クラス: ~80 行
- **計 ~500 行**

教育的なベンチ:
- catastrophic backtracking 例 `(a|aa)*b` 入力 `"aaaaaaaaaaa"` → 指数時間
- 同じパターンを Thompson + thread で実行 → 線形時間

これを一発書けると **「正規表現エンジンの中身が分かる」** ステップとして
他のフェーズと比べ突き抜けて成果物が分かりやすい。

## 範囲外 (Phase 28 ではやらない)

- 自前 NFA (Stage B、Phase 29+ 候補)
- ES6 「literal 都度新 instance」 (専用 opcode が要る)
- test262 harness の `regExpUtils.js` `propertyHelper.js` フル対応
- sloppy mode for-in / sloppy global (SunSpider regex 系 unblock 用)
- Unicode property escape `\p{...}`、lookbehind の独自実装
