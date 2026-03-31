# 仕様準拠で学んだこと

Phase 11 のクロージャ実装後、test262 の準拠率が 225 → 161 に下がっていることに気づき、
原因調査と修正を行う中で得た知見をまとめる。

---

## 1. 独自表現を導入すると「暗黙の変換」が全部壊れる

Phase 9 で JSString (ConsString/SeqString) を導入したとき、文字列リテラルが
ネイティブ `string` から JSString オブジェクトに変わった。
これにより **JS の暗黙的な型変換が全て壊れた**:

| 壊れた箇所 | 原因 |
|------------|------|
| `if ("")` が true | JSString はオブジェクトなので常に truthy |
| `typeof x === "undefined"` が false | 片方 JSString、片方ネイティブ string |
| `!""` が false | `!` がオブジェクトに対して false を返す |
| `"" \|\| "fallback"` が `""` | 空文字列が truthy で短絡評価が壊れる |

**学び**: V8 が内部的に `Oddball` (true/false/undefined/null) や `Smi` (小整数) を
特別扱いするのは、こういう暗黙の変換を **型タグで高速に判定する** ため。
jsmini のように独自型を導入すると、真偽判定・比較・型変換の全箇所に
`isJSString()` チェックを入れる必要がある。

修正: `isTruthy()` ヘルパーを TW/VM 両方に追加し、
`if`/`while`/`for`/`!`/`&&`/`||`/`JumpIfFalse`/`JumpIfTrue`/`LogicalNot` の
全箇所で使うようにした。

---

## 2. ToPrimitive は「エンジンの境界」で必要になる

`+` 演算子でオブジェクトが来たとき、`valueOf()` → `toString()` の順で
プリミティブに変換する ToPrimitive を実装していなかった。

TW は `(left as number) + (right as number)` で V8 の `+` にそのまま委譲していたので、
V8 が ToPrimitive を勝手にやってくれていた。しかし:

- **jsmini の JSObject** (Hidden Class + `__slots__`) は V8 から見ると
  valueOf/toString を持たない普通のオブジェクトなので `Cannot convert object to primitive value`
- **JSFunction** (BytecodeFunction) も同様

**学び**: 独自のオブジェクト表現を導入したら、ホストエンジンの暗黙的な型変換に
頼れなくなる。ToPrimitive、ToNumber、ToBoolean、ToString を全て自前で実装する必要がある。
V8 が Object::ToPrimitive を持っているのは、まさにこの理由。

---

## 3. VM の throw は「フレーム境界」を意識する必要がある

VM で関数内の throw → 呼び出し元の catch に到達させる `unwindToHandler` を実装したが、
callInternal (ToPrimitive 用の内部関数呼び出し) を挟むと問題が起きた:

```
外側の run(0)
  └─ Add 命令
       └─ toPrimitive(obj)
            └─ callInternal(valueOf)
                 └─ run(1)        ← valueOf 関数を実行
                      └─ Throw    ← valueOf 内で throw
```

**問題**: Throw → unwindToHandler が callInternal の境界を超えて外側の catch に
ジャンプしてしまい、callInternal が「例外が起きた」ことを検知できない。

**解決**: `_runBaseFrameCount` で各 run() のフレーム下限を追跡し、
Throw の unwindToHandler を現在の run() スコープ内に制限した。
スコープ外のハンドラが必要な場合は `{ __thrown: true, value }` として
JS 例外に変換し、callInternal の catch で処理する。

**学び**: V8 が C++ と JS の境界で「例外は常に C++ の try-catch で包む」のは、
こういうフレーム境界の問題を防ぐため。jsmini でも callInternal (C++ 相当の内部呼び出し)
では try-catch で包んでフレーム境界を明示する必要があった。

---

## 4. let/const のブロックスコープは「コンパイラの責任」

TW は Environment チェーンでスコープを管理しているので、
`{ let x = 2; }` のブロックを抜ければ自然に x は見えなくなる。

VM はローカルスロットで管理しているため、コンパイラが明示的に:
1. ブロック開始時に locals の Map をスナップショット (scopeStack.push)
2. let/const の変数を新しいスロットに割り当て
3. ブロック終了時に locals を復元 (scopeStack.pop)

する必要がある。

**見つかったバグ**:
- トップレベルの let/const が全部 StaGlobal に行っていた (ブロックスコープなし)
- for (let ...) の変数がループ外に漏れていた
- 分割代入 (`let [x]`, `let {x}`) の変数が事前 declare されていなかった

**学び**: V8 の BytecodeGenerator が `BlockDeclarationInstantiation` で
ブロックスコープの変数を明示的に管理しているのは、まさにこの問題のため。
TW の Environment チェーンは暗黙的にスコープを管理するが、
VM のコンパイラは全てのスコープ境界を明示的にコードに落とす必要がある。

---

## 5. test262 runner のタイムアウトは必須

test262 には `while ("")` のようなテストがあり、JSString 導入後は空文字列が
truthy になって無限ループが発生した。onStep / maxSteps でステップ数を制限して
無限ループを検出する仕組みを入れたら、実行時間が数分→2秒になった。

---

## 6. ビルトインの欠如は準拠率に直結する

test262 のテストは `NaN`, `Infinity`, `ReferenceError`, `TypeError` 等の
グローバルを当然のように使う。これらを1つ追加するだけで数件〜十数件 pass が増える。

| 追加したもの | pass 増加 |
|-------------|----------|
| NaN, Infinity | +3 |
| ReferenceError, TypeError, SyntaxError, RangeError | +12 |
| instanceof ネイティブコンストラクタ対応 | +12 (上記と合わせて) |

**学び**: エンジンの仕様準拠は「構文」だけでなく「ビルトインオブジェクト」の
充実度に大きく依存する。V8 の bootstrapper.cc が数千行あるのはこのため。

---

## 数値まとめ

```
Phase 9 直後 (JSString 導入):  TW 161/841 (壊れた状態)
修正後:
  TW: 245/841 (30.0%)
  VM: 244/841 (29.9%)

元の水準 (Phase 4): 225/816 (27.6%)
→ 修正 + ビルトイン追加で 245/841 (30.0%) に改善
```

残り TW/VM 差:
- JSObject に Object.prototype (toString 等) がない → 1件
- for-head の let 変数に対するクロージャキャプチャ → 2件
