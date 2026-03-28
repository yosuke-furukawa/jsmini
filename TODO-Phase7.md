# TODO — Phase 7: Hidden Class (プロパティレイアウト)

`obj.x` を文字列キーのハッシュ検索からオフセットベースの配列アクセスに変える。
**ゴール**: Vec class ベンチが VM で 2 倍速くなる。

---

## 7-0. HiddenClass 型の定義

- [ ] `src/vm/hidden-class.ts` — HiddenClass 型と遷移チェーン
  ```typescript
  type HiddenClass = {
    id: number;
    properties: Map<string, number>;  // name → slot offset
    transitions: Map<string, HiddenClass>;
    protoHC: HiddenClass | null;  // prototype の HC
  };
  ```
- [ ] `createRootHC()` — 空の Hidden Class を作成
- [ ] `transition(hc, name)` — プロパティ追加で新 HC に遷移 (既存遷移があれば再利用)
- [ ] `lookupOffset(hc, name)` — プロパティのオフセットを返す (-1 なら未定義)
- [ ] テスト: 遷移チェーンの共有、同じ順序で同じ HC

---

## 7-1. JSObject 型の導入

- [ ] `src/vm/js-object.ts` — Hidden Class 付きオブジェクト
  ```typescript
  const HIDDEN_CLASS: unique symbol;
  const SLOTS: unique symbol;

  type JSObject = Record<string, unknown> & {
    [HIDDEN_CLASS]: HiddenClass;
    [SLOTS]: unknown[];
  };
  ```
- [ ] `createJSObject()` — 空オブジェクトを HC 付きで生成
- [ ] `getSlot(obj, hc, name)` — HC のオフセットで slots から読む
- [ ] `setSlot(obj, name, value)` — HC を遷移させつつ slots に書く
- [ ] 従来のプロパティアクセスとの互換性:
  - `obj[name]` でも動くようにする (proxy or 同期)
- [ ] テスト: JSObject の生成、プロパティ追加、読み取り

---

## 7-2. VM の CreateObject を JSObject 対応

- [ ] `CreateObject` → `createJSObject()` に変更
- [ ] `SetProperty` → `setSlot(obj, name, value)` に変更
- [ ] `SetPropertyAssign` → `setSlot` + 値を残す
- [ ] `GetProperty` → `getSlot(obj, hc, name)` に変更
- [ ] `Construct` → new で作るオブジェクトも JSObject に
- [ ] テスト: 既存テスト全パス

---

## 7-3. 遷移チェーンの動作確認

- [ ] 同じコンストラクタから作られたオブジェクトが同じ HC を共有
  ```js
  var a = new Vec(1, 2);  // HC: {} → {x:0} → {x:0, y:1}
  var b = new Vec(3, 4);  // 同じ遷移パス → 同じ HC
  // a と b は同じ HiddenClass を持つ
  ```
- [ ] プロパティ追加順序が異なると別の HC
  ```js
  var a = {}; a.x = 1; a.y = 2;  // HC_A: {x:0, y:1}
  var b = {}; b.y = 1; b.x = 2;  // HC_B: {y:0, x:1} — 別の HC
  ```
- [ ] テスト: HC 共有の確認、HC の分岐

---

## 7-4. prototype チェーンの対応

- [ ] `GetProperty` で自身のプロパティがなければ `__proto__` の HC を辿る
- [ ] メソッド呼び出し (`obj.add()`) が prototype 経由で正しく動く
- [ ] `Construct` で `__proto__` を設定
- [ ] テスト: class のメソッド呼び出し、instanceof

---

## 7-5. ベンチマーク + ドキュメント

- [ ] Vec class ベンチで VM の速度改善を確認
- [ ] `BENCHMARK.md` 更新
- [ ] `LEARN-HiddenClass.md` 作成

---

## 実装フロー

```
7-0: HiddenClass 型 (遷移チェーン)
  ↓
7-1: JSObject 型 (HC + slots)
  ↓
7-2: VM の全 opcode を JSObject 対応
  ↓
7-3: 遷移チェーンの動作確認
  ↓
7-4: prototype チェーン対応
  ↓
7-5: ベンチマーク + ドキュメント
```

7-0〜7-1 はデータ構造。7-2 が本体 (VM 変更、テスト全パス必須)。
7-4 は class のメソッド呼び出しに必要。

---

## 注意点

### 互換性の維持

jsmini の既存コードは `obj[name]` でプロパティにアクセスしている箇所が多い:
- TW (evaluator.ts): `obj[name]` で読み書き
- VM (vm.ts): `obj[name]` で読み書き
- テスト: `result.x` で結果確認

JSObject を導入しても `obj[name]` が動くようにする必要がある。
方法:
1. **slots と通常プロパティを同期** — setSlot 時に `obj[name] = value` も実行
2. `getSlot` は slots から読むが、フォールバックで `obj[name]` も試す

パフォーマンスの改善は VM 内部の dispatch ループでのみ効く。外部からは従来通り。

### Dictionary mode への切り替え

Phase 7 では fast mode (HC + slots) のみ実装。
`delete obj.x` や動的プロパティ名は従来通り `obj[name]` にフォールバック。
