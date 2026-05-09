# TODO Phase 28 — RegExp

## 動機

PLAN-v6 P2 (ベンチスイート対応) の big rock。RegExp が無いと:
- SunSpider 4 本 (regexp-dna、date-format-xparb 等) が動かない
- Octane の string 系もブロック
- test262 の `built-ins/RegExp` (~2000 テスト) を全くカバーできない
- `String.prototype.match/replace/search/matchAll` の RegExp 引数版が動かない

Phase 26-27 の **host JS 丸投げ** 路線でいくか、**自前 NFA エンジン** で
教育的に書くかで方針が分かれる。LEARN-Phase26 の Math 高速化議論と
似た構図。

## 方針

PLAN-v6 (Phase 28: RegExp 大きい) の主旨は **「自前 NFA を書いて
SunSpider regexp-dna が動く」** だが、まずは段階的に進める:

1. **Stage A (host RegExp 丸投げ)**: Lexer/Parser で `/.../flags` を
   認識し、host `RegExp` をそのまま VM/TW に流す。`String.prototype.match`
   等の RegExp 版も host にdelegate。test262 をある程度通す
2. **Stage B (自前 NFA、別フェーズ候補)**: NFA → Thompson 構築 → サブセット
   構成 (DFA 化はしない)、バックトラック方式で `*/+/?/|/()` を実装。
   教育的価値はここに集中

このフェーズ (28) は **Stage A** までを目指す。Stage B は Phase 29 以降の
候補として LEARN に残す。

## 検証したいこと

1. `/abc/i` のような literal が Lexer で認識される (`/` の文脈判別が要)
2. AST に `RegExpLiteral` 型が追加され、TW/VM が host RegExp を構築できる
3. `"foo".match(/o+/)` `"foo".replace(/o/g, "X")` が動く
4. test262 RegExp テストの通過率が baseline > 0% になる
5. SunSpider の `regexp-dna.js` `string-tagcloud.js` が動く

## ステップ

### 28-1: Lexer 対応 (`/.../flags`)

JS の lexer で `/` の意味は文脈依存:
- `a / b` → 除算
- `;/foo/` → regex リテラル
- `function() { return /foo/; }` → regex リテラル

判定ルール (V8 等が使う方式): 直前の token が **expression が来うる位置**
なら regex、それ以外なら除算。具体的には直前の token が:
- `(`、`,`、`=`、`+`、`-`、`*`、`/`、`%`、`!`、`~`、`<`、`>`、`==`、`!=`、
  `===`、`!==`、`&&`、`||`、`?`、`:`、`{`、`}`、`;`、keyword (return, typeof,
  delete, throw, new, in, instanceof, void) などのとき → regex
- それ以外 (Identifier、Number、String、`)`、`]`、`++`、`--`) → 除算

- [x] 28-1a: lexer に `previousTokenAllowsRegex(prevType)` ヘルパを追加
- [x] 28-1b: `/` を読むとき previousTokenAllowsRegex なら regex literal、
      `/.../flags` を一気に読む。class `[...]` 内の `/` は閉じない
      (escape 処理: `\/`、`\\`、文字クラス内など)
- [x] 28-1c: token type `RegExp` を追加。lexer test: 各種 regex literal
      `/abc/`、`/[a-z]+/i`、`/foo\/bar/`、`/[/]/`、`/abc/gimsuy`

### 28-2: Parser & AST

- [x] 28-2a: AST に `RegExpLiteral` 型を追加
      `{ type: "RegExpLiteral", pattern: string, flags: string }`
- [x] 28-2b: parser の primary expression に `RegExp` token を加える
- [x] 28-2c: parser test: `/abc/i` を含む式 / 関数で AST が正しい

### 28-3: TW/VM ランタイム

- [x] 28-3a: TW の `evalExpression` で `RegExpLiteral` → `new RegExp(pattern, flags)`
      (host RegExp)
- [x] 28-3b: VM compiler で `RegExpLiteral` → `LdaConstant <RegExp instance>`
      (constant pool に host RegExp を入れる方式が簡単)
- [x] 28-3c: `RegExp` グローバルを TW/VM に公開 (`new RegExp("abc", "i")`
      も動くように。JSString 引数を unwrap)
- [x] 28-3d: `instanceof RegExp` テスト

### 28-4: String.prototype の RegExp 版

現状 `String.prototype.match/replace` は文字列引数のみ対応 (要確認)。
RegExp 引数を受け取るようにする:

- [x] 28-4a: `String.prototype.match(re)` — re が RegExp なら host の
      str.match(re) に delegate、結果は配列 (host Array)
- [x] 28-4b: `String.prototype.replace(re, replacement)` — replacement が
      関数の場合は VM callback wrap が要る
- [x] 28-4c: `String.prototype.search(re)` `String.prototype.matchAll(re)`
- [x] 28-4d: `String.prototype.split(re)` (区切り文字に regex を取れる)
- [x] 28-4e: TW/VM 両方で動く

### 28-5: テスト

- [x] 28-5a: `src/runtime/phase28.test.ts` を作成
      - regex literal の Lexer/Parser
      - `/abc/i.test("ABC")` `/o+/.exec("foooo")`
      - String.match/replace/search/split の RegExp 引数版
      - `new RegExp("\\d+", "g")` のコンストラクタ呼び出し
      - flag combinations (i, g, m, s, u, y)
- [x] 28-5b: TW/VM 両方で同じテストを通す

### 28-6: SunSpider 試行

- [x] 28-6a: `bench/sunspider/regexp-dna.js` `string-tagcloud.js`
      `string-validate-input.js` を取得 + 文字列リテラル行継続 `\<newline>`
      の lexer 対応
- [x] 28-6b: テストファイル側 `var` 補完 + engine 側 8 修正で **3 本全部完動**:
      - regexp-dna:           TW 21ms / VM 14ms / JIT 14ms
      - string-tagcloud:      TW 190ms / VM 2049ms / JIT 2101ms (出力長一致)
      - string-validate-input: TW 233ms / VM 118ms / JIT 124ms
- [x] 28-6c: built-in prototype 拡張対応 + 関連バグ修正 (詳細は LEARN):
      ArrayCtor.prototype = Array.prototype、JSString method の host fallback、
      callJSFunctionSync の this/hoist、VM の nested fn hoist、for-in/of の
      local slot 化、JSString 比較、hasOwnProperty JSString unwrap 等
      → test262 にも効いて +54 pass (6558 → 6612)

### 28-7: test262

- [x] 28-7a: sparse-checkout 拡張: `test/built-ins/RegExp`
      `test/built-ins/String/prototype/{match,replace,search,split,matchAll}`
- [x] 28-7b: pre/post 計測
- [x] 28-7c: `test/language/literals/regexp/` も追加 (regex literal の
      lexer/parser テスト)

### 28-8: まとめ

- [x] 28-8a: LEARN-Phase28.md
      - Lexer の context-sensitive `/` 判定
      - host RegExp 丸投げの利点 / 限界
      - 自前 NFA を書く場合の設計 (Thompson 構築 → backtracking 実行)
      - test262 通過率
- [ ] 28-8b: BENCHMARK.md (任意)

## 落とし穴予測

### Lexer の `/` 文脈判定

ASI (自動セミコロン挿入) が絡むと特に厄介:

```js
a = b
/foo/.test(c)
```

ここで改行があるが、`b\n/foo/...` の `/` は除算扱いが正解 (JS 仕様)。
jsmini が ASI をどこまでサポートしているかで挙動変わる。最初は単純に
「直前 token を見る」方式で進め、エッジケースは後回し。

### test262 で host RegExp と仕様の差

V8/Node の host RegExp は ECMAScript 2024 までの機能 (named groups、
lookbehind、Unicode property escapes) をサポートしている。test262 の
RegExp テストは大半通るはずだが、**lookbehind (`(?<=...)`)** や
**named groups (`(?<name>...)`)** はパターンが複雑すぎて jsmini の
将来の自前 NFA で再現する場合の境界線になる。

### String.prototype.replace の関数引数

`str.replace(/o/g, m => m.toUpperCase())` のコールバックは VM 側で
BytecodeFunction の場合があるので wrapVMCallback が必要 (Phase 27 と同じ
レシピ)。

### RegExp の Symbol.match / Symbol.replace 等

ES6 以降、`String.prototype.match` は内部で `re[Symbol.match](this)` を
呼ぶ仕様。host RegExp は当然これをサポートしているので普通は気にしなくて
よいが、**`String.match` を自前実装する場合は意識が要る**。今回は host
任せなので関係なし。

## Stage B (Phase 29 以降の候補)

教育的価値の本丸。host RegExp を捨てて自前で書く:

```
Pattern → Lexer (regex token: literal char, *, +, ?, |, (), [], etc)
       → Parser → AST (concat, alt, star, plus, opt, group, charclass)
       → Thompson 構築 → NFA (epsilon transition + char transition)
       → 実行: スレッド方式 (Russ Cox 風) or バックトラック方式
```

スレッド方式 (`re2`) は線形時間保証だが backreference 不可。
バックトラック方式 (V8、Perl) は表現力高いが catastrophic backtracking
の危険。教育的には **両方書く** か、Thompson NFA + simulation で進める
のが筋がいい。**~500 行で書ける**。

## 範囲外 (Phase 28 ではやらない)

- 自前 NFA エンジン (Stage B)
- RegExp の JIT 最適化
- Unicode プロパティエスケープ (`\p{...}`)
- sticky/global flag の高度な処理 (host にお任せ)
