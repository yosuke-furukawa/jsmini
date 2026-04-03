# LEARN-Phase15.md — 構文対応拡大 + test262 ハーネス正直化

## test262: 41% → 52%

Phase 15 で TW 41.1% → 52.1% (+984)、VM 41.9% → 51.2% (+838) に引き上げた。
ただしこの数字には「ハーネスの正直化」による減少と増加の両方が含まれている。

### 偽 PASS の発見

assert.sameValue/notSameValue は実装してたが **assert.throws の変換が漏れていた**。
1,254 テストが `undefined is not a function` で落ちてるように見えて、実は assert.throws が
呼べてなかっただけ。1行の修正で 55% まで跳ねたが...

### assert が throw しなかった問題

旧ハーネスの assert 関数は失敗しても **throw しなかった**:

```js
// 旧: 失敗しても何も起きない → テストが通ったことになる
function assert_sameValue(a, b) {
  if (a === b) return;
  // ← throw がない！
}
```

修正後:
```js
assert.sameValue = function(a, b, msg) {
  if (a === b) return;
  throw new Error(msg || "sameValue failed");
};
```

これにより 55% → 45% に「正直に」下がった。**偽 PASS が約 1,000 件あった**。

### assert.throws の型チェック

さらに assert.throws が「何か throw されれば OK」で型チェックしてなかった。
`instanceof` チェックを追加したら追加で 200 件の偽 PASS が剥がれた。

教訓: **テストハーネスの品質がテスト結果の信頼性を決める**。

## 空文 (`;`) で +478

`function f() {};` の末尾セミコロンがパースエラーだった。
ECMAScript の EmptyStatement を実装したら一気に +478 テスト。

test262 のほぼ全ファイルが `};` パターンを含んでいた。
**1文字の構文対応が最大のインパクトだった。**

## Iterator Protocol と分割代入

配列分割代入 `[a, b] = iterable` が、iterable を配列として直接インデックスアクセスしていた:

```js
// 旧: 配列前提
const arr = value as unknown[];
arr[0], arr[1], arr[2]...
```

Generator オブジェクトは配列じゃないので全部 `undefined` になる。
Iterator Protocol (`next()` で1要素ずつ取得) に修正:

```js
// 新: V8 と同じ 1-pass 方式
const iterator = iterable[Symbol.iterator]();
for (each element) {
  const r = iterator.next();
  bindPattern(el, r.value);  // 取得即 bind
}
```

V8 の Ignition も同じ「取得即 bind」方式。
最初に「全部集めてから bind」にしたらバグった（rest で return すると先行要素が未 bind）。

## Function.prototype.call/apply/bind

jsmini の JSFunction (TW) や BytecodeFunction (VM) はネイティブ JS 関数ではないので、
`.call()` / `.apply()` / `.bind()` が存在しない。

TW: MemberExpression の解決で JSFunction の `.call` を検出して直接実行:
```js
if (isJSFunction(thisValue) && key === "call") {
  return yield* evalCallWithJSFunction(jsFnObj, rest, env, callThis);
}
```

VM: GetProperty で BytecodeFunction/closure の `.call` を検出してネイティブラッパーを返す:
```js
if (this.isBytecodeCallable(obj) && name === "call") {
  this.push(function(...args) {
    return self.callFunction(callable, args[0], args.slice(1));
  });
}
```

また、ネイティブ関数のメソッド呼び出しで `thisValue` をバインドしてなかったバグも修正。
`hasOwnProperty.call(obj, key)` が動かなかった原因。

## ToPrimitive のネイティブ関数対応

VM の `toPrimitive()` が BytecodeFunction の `valueOf`/`toString` だけチェックして、
ネイティブ関数の `valueOf`/`toString` を呼べなかった。
`new String("hello") + ""` が `[object Object]` になってた。

## eval: strict mode なら簡単

direct eval は「呼び出し元のスコープにアクセスする」ので難しいと思われがちだが、
strict mode なら:
- 呼び出し元の変数は **読める**（スコープチェーンで辿る）
- `var` 宣言は **eval スコープに閉じる**（外に漏れない）

TW の実装は「呼び出し元の env を親にした isFunctionScope=true の子 Environment」を作るだけ:

```js
const evalEnv = new Environment(env, true); // var を閉じ込める
const gen = evalProgram(parse(code), evalEnv);
```

VM は TW にフォールバックし、VM のグローバル変数を TW の env に注入する方式。

## V8 の Full-Codegen と IC の話

Phase 15 の作業中に V8 の歴史を深掘りした。

### Full-Codegen (2008-2016)

AST から直接機械語を生成するベースラインコンパイラ。型特殊化はせず、
各演算に IC stub（Inline Cache の機械語スタブ）への `call` を埋め込む。

```
a + b の Full-Codegen 出力:
  mov rax, [rbp-8]     ; a
  mov rbx, [rbp-16]    ; b
  call AddIC_stub      ; IC が型チェック + 実行 + 型記録
```

IC stub は自己書き換え:
1. 初回: 汎用コード → 両方 Smi だと判明 → stub を Smi 特化コードに書き換え
2. 2回目以降: 特化コードを直接実行（型チェック最小限）
3. 別の型が来たら → polymorphic に拡張

### なぜ Ignition (bytecode) に変わったか

IC stub が「呼び出し箇所ごとに機械語コピー」なのでメモリを食う。
大規模アプリで stub だけで MB 単位。モバイル (512MB) で破綻。

Ignition: bytecode ハンドラは **1つだけ共有**、型情報だけ箇所別 (FeedbackVector)。
メモリ 1/3 に。速度は IC 経由なので大差なし。

### Sea of Nodes → CFG

V8 の最適化コンパイラ TurboFan は Sea of Nodes IR を使ってたが、
JS のほぼ全操作が副作用を持つため自由な命令移動ができず、
L1 キャッシュミス 3-7倍、デバッグ困難。CFG ベースの Turboshaft に移行。

jsmini で将来 IR を入れるなら CFG ベースが正解。
