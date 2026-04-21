# TODO Phase 25 — Object メタ + Promise.withResolvers

## 動機

Phase 24 で async JIT (JSPI) が完了し、言語機能としては一通り揃った。
次は **test262 通過率** の底上げ。現状の Promise テスト 320/652 (49.1%) を
押さえているのは built-in 不足、特に test262 のハーネス `propertyHelper.js`
が `Object.defineProperty` 等に依存していて、そこでコケると対象テスト以前に
ハーネスがロードできない。

PLAN-v6 の Phase 25 に該当:

- Object.defineProperty / getOwnPropertyDescriptor
- Object.getPrototypeOf / setPrototypeOf
- Object.getOwnPropertyNames / getOwnPropertySymbols
- Promise.withResolvers
- test262 再計測

## 検証したいこと

1. propertyHelper.js が load できる状態にする (= 最低限の defineProperty が動く)
2. prototype チェーン検査系テスト (getPrototypeOf / setPrototypeOf) の挙動
3. Promise.withResolvers の 6 テストが通ること
4. Phase 25 後の test262 通過率がどれだけ動くか

## ステップ

### 25-1: Object.defineProperty / getOwnPropertyDescriptor

- [x] 25-1a: HiddenClass にプロパティ属性 (writable / enumerable / configurable) を
      持たせるか、最小実装 (属性無視、常に true) で済ますかを決める。
      → **最小実装を採用**。propertyHelper.js の assertion で落ちたら都度追加。
- [x] 25-1b: VM (`src/vm/index.ts`): `ObjectWrapper.defineProperty(obj, key, desc)`
      を実装。`jsObjSet` を経由して value を書き込む。accessor (get/set) は TypeError。
- [x] 25-1c: VM: `ObjectWrapper.getOwnPropertyDescriptor(obj, key)` を実装。
      `{value, writable, enumerable, configurable}` を返す。
- [x] 25-1d: TW (`src/interpreter/evaluator.ts`): 同等のものを `twObjectWrapper` に追加
- [x] 25-1e: テスト: 両モードで `Object.defineProperty({}, "x", {value: 1})` が動く
- [x] 25-1f: テスト: `Object.getOwnPropertyDescriptor({x:1}, "x").value === 1`

### 25-2: Object.getPrototypeOf / setPrototypeOf

- [x] 25-2a: VM: `getPrototypeOf` = `jsObjGet(obj, "__proto__")` ラッパー
- [x] 25-2b: VM: `setPrototypeOf(obj, proto)` = `jsObjSet(obj, "__proto__", proto)`
- [x] 25-2c: TW 側も同じ API で追加
- [x] 25-2d: テスト: setPrototypeOf → getPrototypeOf ラウンドトリップ + メソッド呼び出し

### 25-3: Object.getOwnPropertyNames / getOwnPropertySymbols

- [x] 25-3a: VM: `getOwnPropertyNames` = HiddenClass の properties から
      `__proto__` / `@@` 始まりの symbol キーを除外して返す
- [x] 25-3b: VM: `getOwnPropertySymbols` = 空配列を返す最小実装
      (JSSymbol の逆引きレジストリが無いため。必要になったら追加)
- [x] 25-3c: TW 側も同等実装
- [x] 25-3d: テスト: length 比較 (JSString 等価性は別問題)

### 25-4: Promise.withResolvers

- [x] 25-4a: VM: `PromiseConstructor.withResolvers = () => { ... }`
      で `{promise, resolve, reject}` を返す (VM 側は JSObjectInternal で返す)
- [x] 25-4b: TW 側も同等に追加 (TW はプレーン object)
- [x] 25-4c: テスト: resolve / reject / await 経由のラウンドトリップ

### 25-5: test262 再計測

- [ ] 25-5a: 計測前の baseline を記録 (現行 runner で全体と Promise の通過率)
- [ ] 25-5b: Phase 25 実装後に再計測 (同条件)
- [ ] 25-5c: propertyHelper.js 依存で前は落ちていたテスト群の内訳を追う
- [ ] 25-5d: Promise.withResolvers 関連テスト 6 本の通過を確認
- [ ] 25-5e: LEARN-Phase25.md に結果と学びをまとめる

## 期待される効果

| 項目 | 期待 |
|---|---|
| Object.defineProperty | propertyHelper.js が load できる → Object 系テストが解禁 |
| getPrototypeOf / setPrototypeOf | prototype チェーン検査系テストが解禁 |
| getOwnPropertyNames | プロパティ列挙系テストが解禁 |
| Promise.withResolvers | test262 の 6 テストが通る |

PLAN-v6 の想定通り、Phase 25 は "propertyHelper.js が動く → 多数のテストが unblock"
が本丸。個別 API の厳密な spec 準拠より、まずハーネスが load できる状態を優先する。

## 技術メモ

### Object.defineProperty の最小実装

```ts
ObjectWrapper.defineProperty = (obj: unknown, key: unknown, desc: any) => {
  const k = isJSString(key) ? jsStringToString(key) : String(key);
  if ("value" in desc) {
    jsObjSet(obj as any, k, desc.value);
  } else if ("get" in desc || "set" in desc) {
    // accessor descriptor: 後続フェーズで対応。今はエラーにする
    throw new TypeError("accessor descriptors not yet supported");
  }
  return obj;
};
```

writable / enumerable / configurable はまず **無視** する方針。
propertyHelper.js の assertion が具体的に何を見るかに応じて後から詰める。

### getOwnPropertyDescriptor

```ts
ObjectWrapper.getOwnPropertyDescriptor = (obj: unknown, key: unknown) => {
  const k = isJSString(key) ? jsStringToString(key) : String(key);
  const props = getHiddenClass(obj).properties;
  if (!props.has(k)) return undefined;
  return {
    value: jsObjGet(obj as any, k),
    writable: true,
    enumerable: true,
    configurable: true,
  };
};
```

### Promise.withResolvers

```ts
PromiseConstructor.withResolvers = () => {
  let resolve!: (v: unknown) => void;
  let reject!: (r: unknown) => void;
  const promise = new JSPromise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
```

### 範囲外 (Phase 25 ではやらない)

- accessor descriptor (get/set) の本格対応 → Phase 25 では TypeError
- 属性フラグ (writable/enumerable/configurable) の厳密な spec 準拠
- Object.defineProperties (複数プロパティ一括) → 必要なら追加
- Reflect.defineProperty 等の Reflect 版 → Phase 29 (P3)
