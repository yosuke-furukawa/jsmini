# LEARN-Phase25.md — Object メタ + Promise.withResolvers

## やったこと

PLAN-v6 の P0 built-in を VM と TW の両方に追加:

- `Object.defineProperty` / `getOwnPropertyDescriptor`
- `Object.getPrototypeOf` / `setPrototypeOf`
- `Object.getOwnPropertyNames` / `getOwnPropertySymbols`
- `Promise.withResolvers`

方針は **最小実装**。属性フラグ (writable / enumerable / configurable) は
ignore、accessor descriptor (get/set) は TypeError、getOwnPropertySymbols は
空配列。propertyHelper.js が load できるだけの gaps を埋めるのが目的。

## test262 への効果

tree-walking モード、`test/built-ins/Promise` を TEST_DIRS に追加した状態で計測:

| バージョン | Pass | Fail | Skip | Total | Pass rate |
|---|---|---|---|---|---|
| Phase 24 | 5112 | 4128 | 2109 | 11349 | 55.3% |
| Phase 25 | 5133 | 4107 | 2109 | 11349 | 55.5% |

**+21 テスト通過**。Promise 失敗数は 215 で変動なし。
Promise.withResolvers テスト (6 本) の大半が通るようになった。

## 途中で起きた小 regression と修正

最初に `PromiseConstructor.withResolvers` をアロー関数で実装したら、
`Promise.withResolvers.call(eval)` が TypeError を投げずに通ってしまい、
以下 2 テストが PASS → FAIL に退化した:

- `Promise/withResolvers/ctx-non-ctor.js`
- `Promise/withResolvers/ctx-non-object.js`

原因: アロー関数は `this` binding を取らないので `.call(eval)` が素通り。
修正: `function(this: unknown) { if (this !== PromiseConstructor) throw TypeError ... }`
として `this` 検査を追加。これで before と同じ 215 Promise fail に戻り、
前述の +21 が純粋な gain になった。

## 教訓

### 1. 「undefined.method()」は偶然 spec 準拠に見える

Phase 24 時点で `Promise.withResolvers` は `undefined` だった。
test262 の `Promise.withResolvers.call(eval)` は undefined の `.call` アクセスで
TypeError を投げていた。これは **spec が期待する挙動と偶然一致** してテストが
PASS 扱いだった。

built-in を追加すると、未実装で "偶然通っていた" テストが暴かれる。
ベースラインと diff を取って、どのテストが新規に落ちたかを確認する運用が要る。

### 2. 属性フラグを ignore しても propertyHelper.js はとりあえず動く

HiddenClass に writable/enumerable/configurable を持たせる検討をしたが、
最小実装 (常に true 扱い) で propertyHelper.js の assert を通過できた。
厳密な spec 準拠が必要になってから HiddenClass を拡張すれば良い。
**premature な抽象化を避ける**の良い例。

### 3. 静的メソッドの `this` 検査は arrow でなく function で

```ts
// NG: アロー関数 → this binding が外側に固定
PromiseConstructor.withResolvers = () => { ... };

// OK: 関数式 → this が呼び出し時の receiver
PromiseConstructor.withResolvers = function(this: unknown) {
  if (this !== PromiseConstructor) throw new TypeError(...);
  ...
};
```

ES2024 の `Promise.withResolvers` spec では receiver チェック (`IsConstructor(C)`) が
入るので、最小実装でも `this === PromiseConstructor` だけはチェックしたほうがいい。

### 4. worktree で before/after の test262 diff を取る

`git worktree add -d /tmp/jsmini-pre25 <commit>` で別ディレクトリに
pre-Phase25 のツリーを展開、`ln -s` で `node_modules` と `test262` を共有、
その状態で runner を回すことで Phase 25 commits 抜きの test262 結果を取得できた。
機能追加の net gain を数値で示すのに有効。

## 範囲外にしたもの

- **accessor descriptor** (`{get, set}`): TypeError を投げる最小実装のみ。
  本格対応は Phase 26 以降。
- **属性フラグの厳密対応** (writable/enumerable/configurable): HiddenClass に
  attribute bits を持たせる必要がある。現状は全て true 扱い。
- **getOwnPropertySymbols**: 空配列を返すだけ。JSSymbol の逆引きレジストリを
  作る必要があるが、要件が出るまで保留。
- **Object.defineProperties** は実装したが test262 で特にカバーされていない。
- **Reflect.\***: Phase 29 (P3) に回す。

## 次フェーズ (Phase 26) 予告

PLAN-v6 によると:

- Math 三角関数 (sin, cos, tan, atan2, exp, log2, log10, hypot, cbrt)
- Date (コンストラクタ, Date.now, getTime, getFullYear, ...)
- SunSpider math/date ベンチ試行

Phase 25 と違って built-in ラッパーではなくネイティブ Math/Date を
そのまま delegate できる (日付の interning だけ注意)。小さく済むはず。
