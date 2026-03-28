# TODO — Phase 7: Hidden Class (プロパティレイアウト)

`obj.x` を文字列キーのハッシュ検索からオフセットベースの配列アクセスに変える。
**ゴール**: Vec class ベンチが VM で 2 倍速くなる → **IC (Phase 8) が必要と判明。**

---

## 7-0. HiddenClass 型の定義

- [x] `src/vm/hidden-class.ts` — HiddenClass 型と遷移チェーン
- [x] `getRootHC()` — 空の Hidden Class を作成
- [x] `transition(hc, name)` — プロパティ追加で新 HC に遷移 (既存遷移があれば再利用)
- [x] `lookupOffset(hc, name)` — プロパティのオフセットを返す (-1 なら未定義)
- [x] テスト: 遷移チェーンの共有、同じ順序で同じ HC (5 テスト)

---

## 7-1. JSObject 型の導入

- [x] `src/vm/js-object.ts` — Hidden Class 付きオブジェクト
- [x] `createJSObject()` — 空オブジェクトを HC 付きで生成
- [x] `getProperty(obj, name)` — HC のオフセットで slots から読む + prototype チェーン
- [x] `setProperty(obj, name, value)` — HC を遷移させつつ slots に書く + obj[name] 同期
- [x] テスト: JSObject の生成、プロパティ追加、読み取り、HC 共有 (8 テスト)

---

## 7-2. VM の CreateObject を JSObject 対応

- [x] `CreateObject` → `createJSObject()` に変更
- [x] `SetProperty` → `jsObjSet(obj, name, value)` に変更 (isJSObject ガード付き)
- [x] `SetPropertyAssign` → `jsObjSet` + 値を残す
- [x] `GetProperty` → `jsObjGet(obj, name)` に変更 (prototype チェーン対応)
- [x] `Construct` → new で作るオブジェクトも JSObject に、__proto__ 設定
- [x] テスト: 既存 454 テスト全パス

---

## 7-3. 遷移チェーンの動作確認

- [x] 同じコンストラクタから作られたオブジェクトが同じ HC を共有 (テスト確認済み)
- [x] プロパティ追加順序が異なると別の HC (テスト確認済み)

---

## 7-4. prototype チェーンの対応

- [x] `getProperty` で自身のプロパティがなければ `__proto__` を辿る
- [x] class のメソッド呼び出し (prototype 経由) が正しく動く
- [x] `Construct` で `__proto__` を設定 (JSObject として)
- [x] テスト: class A + get(), Vec class が全パス

---

## 7-5. ベンチマーク + ドキュメント

- [x] ベンチマーク: Vec class TW 10.8ms / VM 21.2ms (0.51x)
  - Hidden Class 導入前 (Phase 5): TW 11ms / VM 19ms (0.58x)
  - **速度改善なし** — HC のオフセット検索 (Map.get) がハッシュ検索と同じコスト
  - **改善には Inline Cache (Phase 8) が必要**: オフセットをバイトコード地点ごとにキャッシュ

---

## 学んだこと

Hidden Class を導入しても **それだけでは速くならない**。
V8 が速い理由は Hidden Class + **Inline Cache** の組み合わせ:

1. Hidden Class: プロパティ名 → オフセットの固定マッピング ✅ (実装済み)
2. Inline Cache: アクセス地点ごとにオフセットをキャッシュ ❌ (未実装)

IC がないと毎回 `Map.get(name)` でオフセットを引くので、通常の `obj[name]` と同じ。
IC があれば「前回と同じ HC → 同じオフセット → 比較 1 回 + 配列アクセス 1 回」で済む。
