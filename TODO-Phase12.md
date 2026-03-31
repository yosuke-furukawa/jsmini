# TODO Phase 12 — プロトタイプチェーン

## 動機

VM の JSObject は `__hc__` + `__slots__` しか持たず、プロトタイプチェーンがない。
`obj.toString()`, `obj.hasOwnProperty()`, `Foo.prototype.method` が全部動かない。
TW は V8 のネイティブプロトタイプチェーンにタダ乗りしてるので動く。

## 現状

```
OK: arr.push, arr.indexOf, arr.length, str.length (個別実装済み)
NG: obj.toString(), obj.hasOwnProperty(), obj.valueOf()
NG: arr.map, arr.filter, arr.forEach
NG: str.charAt, str.indexOf, str.slice
NG: Foo.prototype.method = function() {}
NG: Object.keys, Object.create
```

## ステップ

- [ ] 12-0: JSObject に `__proto__` を追加、getProperty でプロトタイプチェーンを辿る
- [ ] 12-1: Object.prototype (toString, hasOwnProperty, valueOf)
- [ ] 12-2: Foo.prototype.method パターン (new で __proto__ を設定)
- [ ] 12-3: Array.prototype (push, map, filter, forEach, indexOf, join, slice, concat)
- [ ] 12-4: String.prototype (charAt, indexOf, slice, trim, toUpperCase, toLowerCase)
- [ ] 12-5: Object.keys, Object.create, Object.assign
- [ ] 12-6: test262 準拠率確認 + compat テスト追加
