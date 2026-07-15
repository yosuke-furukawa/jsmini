# PROBLEMS.md — 既知の未解決問題

Phase 35 (差分ファザによるバグ一掃、PR #35) 時点で判明している未解決の問題台帳。
divergence は `npm run fuzz -- --iterations 10000 --seed 1613533855 --isolate` で
903/5000 件 → **6/10000 件**まで削減した後の残り。正しさの基準は node (strict mode)。

## 1. ファザが検出し続けている divergence (JIT の数値表現の構造的限界)

### 1-1. JIT: 計算で生まれた -0 が 0 になる

```js
function f0(p0) { return -p0; }   // p0 = 0 のとき実 JS は -0
for (var i = 0; i < 300; i++) console.log(f0(0));
// TW/VM: -0    JIT (OSR 後): 0
```

- i32 に -0 は存在しない。**定数の -0** は Phase 35-8 で修正済み (canFitI32 が
  弾いて f64 化) だが、**演算結果として生まれる -0** (`-x` で x=0、`0 * -1` 等) は
  range 分析では静的に追えない。
- V8 も Smi は -0 を表現できず「-0 を生みうる演算」に deopt を仕込んで対処している。
  同じことをするなら Negate/Mul に -0 チェック付き slow path が必要。コスト大・
  実害小なので保留。

### 1-2. JIT: tagged slots が boolean プロパティを number にする

```js
// this.k0 = false を持つオブジェクトをメソッドが触り、後で console.log すると
// TW/VM: {"k0": false}    JIT (write-back 後): {"k0": 0}
```

- Phase 33 の tagged slots は 1bit タグ (偶数=30bit 数値, 奇数=object index) で、
  boolean は数値 0/1 として copy-in され、write-back で number に化ける。
- 対策候補: (a) bool を持つプロパティは copy-in 時に deopt、(b) タグ空間に
  bool を追加 (TAG_FALSE/TAG_TRUE を null/undefined と同様の特殊値に)。
  (b) が本筋。Phase 36 候補。

## 2. ファザの生成器が踏まない構文の divergence (手動確認済み)

### 2-1. switch の case 内 function 宣言が TW で見えない

```js
switch (1) { case 1: function sf() { return 9; } var x = sf(); }
// 実 JS (strict): 9 (switch ブロック内で可視)   VM: 9   TW: ReferenceError
```

- Phase 35-4 の function-in-block 修正は BlockStatement のみ対応。TW の
  SwitchStatement は case 本体を素の env で評価しており巻き上げが無い。
  VM は compileStatement 経由で動く。TW の SwitchStatement に
  hoistFunctionDeclarations を足せば直る (小規模)。

### 2-2. TW の host 配列メソッドが JSString 要素を壊す

```js
["a", "b"].join(",")
// 実 JS: "a,b"   VM: "a,b" (自前 join)   TW: "[object Object],[object Object]"
```

- TW は `Array` を host のまま公開しているため、join/indexOf/includes 等の
  host メソッドが JSString 要素を "[object Object]" として扱う。
- VM は arrayPrototype に JSString 対応の自前実装を持つ。TW にも同等の
  ラッパが必要 (対象メソッドの洗い出しから)。ファザの生成器は配列メソッド
  呼び出しを生成しないため未検出だった。生成器の拡張候補でもある。

### 2-3. メンバー代入 `obj.p = rhs` の評価順が rhs 先

```js
o().p = r();   // 実 JS の評価順: o → r。 VM は r → o (non-computed のみ)
```

- 実 JS は object 参照の評価が先。VM の SetPropertyAssign (non-computed) は
  rhs を先にコンパイルしている。computed (`o[k] = v`) は正しい順。
- TW も put 時に object 式を再評価する実装 (object が 2 回評価される) で同罪。
- 両エンジンが同じ方向に間違っているため差分には映らない。副作用のある
  object 式 + throw する rhs の組み合わせで実 JS と食い違う。

### 2-4. const を閉包する関数の巻き上げ順エッジ

```js
const x = 1; function f() { x = 5; } f();
// 実 JS/期待: TypeError (const 再代入)
// 現状: f がプログラム先頭で hoisting コンパイルされる時点で constLocals が
// 未登録のため StaGlobalStrict に落ち、ReferenceError になる
```

- どちらも throw はするので実害は小さいが、エラー種別が違う。
- 直すなら compileProgram/compileFunctionBody の hoisting パスの前に
  const 宣言名だけ先行スキャンして constLocals へ登録する。

## 3. 全エンジン共通のスペック違反 (差分ファジングには映らない)

差分ファザは「TW/VM/JIT が同じ間違いをする」バグを検出できない。node との
差分実行 (`--corpus` + 本家 Fuzzilli、あるいはリファレンス実行の追加) が将来課題。

### 3-1. `==` が string と number を数値化比較しない

```js
"5" == 5   // 実 JS: true   jsmini (全エンジン): false
```

- Equal/NotEqual は「両辺 JSString なら内容比較、片方だけ JSString なら false」
  という実装で、JS 仕様 7.2.14 の ToNumber 段が無い。
- 修正自体は小さいが、`==` はベンチ/テスト全域で使われるため影響範囲の
  確認込みで独立フェーズ推奨。

### 3-2. ユーザー定義 valueOf/toString が host ビルトイン経由で呼ばれない

```js
var o = { toString: function() { return "hi"; } };
String(o)    // 実 JS: "hi"   jsmini: "[object Object]"
o - 0        // これは 42 になる (演算子経路の toPrimitive はユーザー定義を呼ぶ)
```

- 演算子 (`+` `-` 比較) の ToPrimitive はユーザー定義 valueOf/toString を呼ぶが、
  String()/Number()/isNaN()/Math.* などビルトインの引数前処理 (numArg/strConv) は
  「プレーンオブジェクト → "[object Object]"/NaN 固定」の近似。
- 背景: jsmini のオブジェクトは host prototype が null で、host の ToString/
  ToNumber に渡すと throw するため前処理が必要になった (Phase 35-1/35-5)。
  正しくは前処理で VM の toPrimitive 相当を呼ぶべきだが、index.ts のビルトイン
  層から VM インスタンスの toPrimitive を呼ぶ配線が要る。

### 3-3. TW の `+=` が host string を生む

```js
var x = 1; x += [2];   // 実 JS: "12"
```

- 結果の見た目は "12" で一致するが、TW は host の string、VM は JSString を作る。
  内部表現の不整合で、以後の JSString 前提の処理 (intern 比較等) から漏れる。
  TW の複合代入 `+=` を evalBinaryExpression の Add と同じ経路に寄せれば解消。

## 4. 実行モデルの構造差 (仕様の範囲内 / ファザは判定不能として除外)

- **ホストスタックオーバーフロー**: TW は host 再帰で評価するため、深い再帰は
  RangeError (host) になる。VM は自前フレームなのでステップ上限に当たる。
  FUZZING.md の通り「判定不能」扱い。
- **ステップ上限**: VM/JIT は maxSteps で停止するが TW には無い。無限ループは
  タイムアウト検出のみ。

## 5. 検証方法

```bash
npm run fuzz -- --iterations 10000 --seed 1613533855 --isolate   # 再現 seed 固定
npm run fuzz -- --repro <gen seed>                               # 1 件の詳細
npx tsx --test src/vm/strict-semantics.test.ts                   # 回帰 51 ケース
```

修正の際は「正 = node (strict)」で確認し、TW/VM/JIT の 3 エンジンを同時に
直して収束させること (片方だけ直すと divergence が増える)。
