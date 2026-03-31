# TODO Phase 12 — プロトタイプチェーン

## 動機

VM の JSObject は `__hc__` + `__slots__` だけでプロパティを管理している。
オブジェクト自身に定義されたプロパティは見えるが、それ以外は見えない。

JS では全てのオブジェクトが **プロトタイプチェーン** を持つ:

```
var o = {};
o.toString();  // o 自身には toString がない
               // → o.__proto__ (= Object.prototype) を探す
               // → Object.prototype.toString が見つかる → 呼べる
```

TW は V8 のランタイム全体（プロパティ解決、演算子、型変換）にタダ乗りしているので
プロトタイプチェーンが自然に動く。VM は JSObject を独自表現にしたため、
V8 のランタイムから切り離されており、自前で実装する必要がある。

### なぜ `__proto__` が必要か

JS の仕様上、プロパティアクセス `obj.x` は以下の手順で解決される:

1. `obj` 自身のプロパティに `x` があればそれを返す
2. なければ `obj.__proto__` (= `obj.[[Prototype]]`) を見る
3. そこにもなければ `obj.__proto__.__proto__` を見る
4. `null` に到達したら `undefined`

これは「メソッドの共有」を実現する仕組み:

```
function Point(x, y) { this.x = x; this.y = y; }
Point.prototype.dist = function() { return Math.sqrt(this.x * this.x + this.y * this.y); };

var p1 = new Point(3, 4);
var p2 = new Point(0, 1);
// p1, p2 は自身に dist を持たないが、Point.prototype 経由で共有できる
// p1.dist() → p1 になし → p1.__proto__ (= Point.prototype) → dist 発見
```

1000 個の Point を作っても `dist` 関数のコピーは 1 つだけ。
`__proto__` がないと各オブジェクトに `dist` をコピーする必要がある。

また、ビルトインメソッド (`toString`, `hasOwnProperty`, `push`, `charAt` 等) も
全てプロトタイプ経由で提供される:

```
Object.prototype   → toString, hasOwnProperty, valueOf
Array.prototype    → push, map, filter, forEach, indexOf, ...
String.prototype   → charAt, indexOf, slice, trim, ...
Function.prototype → call, apply, bind
```

プロトタイプチェーンがないと、これらが一切使えない。

## 現状

```
OK: arr.push, arr.indexOf, arr.length, str.length (VM に個別ハードコード済み)
NG: obj.toString(), obj.hasOwnProperty(), obj.valueOf()
NG: arr.map, arr.filter, arr.forEach
NG: str.charAt, str.indexOf, str.slice
NG: Foo.prototype.method = function() {}
NG: Object.keys, Object.create
```

## ステップ

- [ ] 12-0: JSObject に `__proto__` を追加、getProperty でプロトタイプチェーンを辿る
- [ ] 12-1: Object.prototype (toString, hasOwnProperty, valueOf)
- [ ] 12-2: Foo.prototype.method パターン (new で __proto__ を Foo.prototype に設定)
- [ ] 12-3: Array.prototype (push, map, filter, forEach, indexOf, join, slice, concat)
- [ ] 12-4: String.prototype (charAt, indexOf, slice, trim, toUpperCase, toLowerCase)
- [ ] 12-5: Object.keys, Object.create, Object.assign
- [ ] 12-6: test262 準拠率確認 + compat テスト追加
