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
string-validate-input.js を取得。**全 3 本が動かない**:

| ベンチ | 壁 |
|---|---|
| regexp-dna | `for(i in seqs)` (sloppy global、jsmini は strict-only) |
| string-tagcloud | 同様の sloppy global |
| string-validate-input | `letters = new Array(...)` (sloppy global) |

これは Phase 28 の範囲外。手元で var を入れる加工をすれば動かせる
可能性あり。

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
