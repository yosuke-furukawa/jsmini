# LEARN-Phase30.md — Octane 互換: 実アプリ型パターンが炙り出した 5 つの穴

## やったこと

Octane 4 本 (richards / deltablue / splay / navier-stokes) を導入し、
smoke test 時点で 12 セル中 1 セルしか動かなかった状態から
**4 本 × TW/VM/JIT = 12 セル全完走** まで持っていった。
修正したのは 5 つの独立バグ。SunSpider (関数単位のマイクロ) では
踏まなかった「素の prototype OO」「名前空間」「深いクロージャ」の
パターンが全部地雷原だった。

| ベンチ | TW | VM | JIT |
|---|---|---|---|
| richards | 201ms | 122ms | 128ms |
| deltablue | 192ms | 164ms | 192ms |
| splay | 2765ms | 2549ms | 2663ms |
| navier-stokes | 3313ms | 2165ms | 2308ms |

(参考: V8 なら各数十 ms。JIT ≈ VM なのは後述の通り Phase 31 のテーマ)

## 修正した 5 バグ

### 1. parser: `new T.Node(5)` が `(new T).Node(5)` に誤解析 (B2 → splay)

parseNewExpression の callee が Primary のみで member チェーンを
消費していなかった。JS の優先順位では new の callee は `.x`/`[k]` を
含み、**最初の `(` が new の引数**。splay の `new SplayTree.Node(k, v)`
(関数を名前空間にするパターン) が「代入も読み出しも正常なのに new だけ
死ぬ」という不思議な症状になっていた。教訓: **「関数プロパティが壊れてる」
ように見えて parser が真因**のことがある。二分解 (代入/読み/呼び出し/new
を個別にテスト) が効いた。

### 2. VM compiler: member への ++/-- が「何も emit しない」(B1 → richards)

UpdateExpression が Identifier 引数しか処理せず、`++this.currentMark` や
`this.count++` では **無音で何も emit しなかった**。式なのに値が積まれず、
ExpressionStatement の Pop が別の値を壊す = スタック破壊。

richards の 2 分+ 無限ループの真因はこれ。`this.holdCount++` 等で
スタックがずれ、scheduler のループ条件が永遠に成立しなくなっていた。
「無限ループ」という派手な症状の根が「silent no-emit + Pop」という
静かなバグだった。**compiler の switch に default で「何もしない」を
置くのは禁忌** — 最低でも throw か LdaUndefined でスタック整合を守る。

### 3. オブジェクト同士の `==` が ToPrimitive されて true (→ deltablue)

`==` が両辺オブジェクトでも無条件に ToPrimitive していたため、
別オブジェクト同士が `"[object Object]" == "[object Object]"` で true。
JS 仕様 (7.2.14) では**両辺オブジェクトは参照比較**で、ToPrimitive は
片辺が primitive のときだけ。

deltablue は `this.strength == Strength.REQUIRED` が全 Strength で true
になり、弱い制約の一時的な不満足でも REQUIRED 扱いで alert が誤爆。
切り分けが面白かった: **chooseMethod の全トレースを host と突き合わせて
完全一致**なのに alert 数だけ違う → 差は分岐条件の比較演算子側にしか
ありえない、と絞れた。

### 4. VM compiler: var hoisting が無い (B4 → navier-stokes)

クロージャがソース上で後方の `var` を参照すると、compile 時点で locals
に無く global 参照になっていた:

```js
function FluidField() {
  this.update = function() { ... dens_prev ... };  // ← ここで capture
  var dens_prev;                                    // ← 宣言は後
}
```

Phase 29 で function 宣言の hoist は入れたが var が抜けていた。
hoistVarNames() で本体内 (ネスト関数除く) の var 束縛名を再帰収集して
事前 declareLocal。**TW には hoistVarDeclarations があるのに VM compiler
に無い**という TW/VM 非対称の典型例 (Phase 28 の教訓の再演)。

### 5. JIT: this の非数値スロットを黙って 0 化 (→ JIT 3 本全滅)

executeWasm の hasThis パスが this のスロットを linear memory にコピー
する際、`typeof v === "number" ? v : 0` で**オブジェクト/null を 0 に**
していた。Phase 12 の設計時は Point{x,y} のような全数値オブジェクトしか
想定していなかった。

- splay: `this.root_` (木) が 0 → "Not a function"
- deltablue: コレクション参照が 0 → "reading 'size'"
- richards: scheduler の連結リストが 0 → **JIT でだけ無限ループが再発**

修正は「非数値スロットを見つけたら deopt して VM」。1 つのガードで
3 本の JIT が同時に直った。

V8 との対比: V8 はオブジェクトのスロットを **tagged pointer** で持つので
参照も数値も同じスロットモデルに乗る。jsmini の linear memory this-model
は「数値専用」(asm.js 的) なので、参照を持つオブジェクトはモデルの外。
Phase 31 で参照スロットをどう表現するかが本丸になる。

## JIT 棚卸し (Phase 31 の入力)

tier trace の集計:

| ベンチ | compiled | deopt (非数値 this) | polymorphic | 備考 |
|---|---|---|---|---|
| richards | 10 | 5 | 4 | ホットな TCB メソッドが deopt 側 |
| deltablue | 29 | 7 | 3 | 同上 (OrderedCollection/Constraint) |
| splay | 4 | 1 | — | ほぼ VM。GC バウンド |
| navier-stokes | **0** | — | 1 | **数値カーネルが 1 本も JIT されない** |

- **JIT ≈ VM (どこも効いていない)** が正直な現状。互換性は取れたが
  性能はこれから
- richards/deltablue: OO ホットパス (this に参照スロットを持つメソッド)
  が全部 deopt → **参照スロット対応の object JIT** が最大テーマ
- navier-stokes: カーネルが FluidField の**内部クロージャ** (upvalue +
  配列引数 + 相互呼び出し) で、compileIRToWasm が "unknown call" で
  reject → **複数関数の同時コンパイル + クロージャ upvalue** が必要
- splay: 割り当てバウンド。JIT より **GC (世代別/割り当て高速化)** の領域

## その他の学び

- **ベンチ加工は stub 注入が最小**: `alert`/`performance.now` は呼び出し
  書き換えでなく先頭で `var alert = function(){...}` を注入する方が
  diff が小さい
- **実行時計測フックのコスト**: octane-bench に入れた onStep ハング検出は
  それ自体が 10 倍級のオーバーヘッド。計測時はデフォルト無効にして
  OCTANE_STEP_LIMIT=1 でオプトイン
- **JIT_SKIP=name1,name2** (関数単位で JIT 無効化) を入れたら犯人の
  二分探索が一瞬で終わった。deopt 系バグの標準ツールにする
- Octane 導入の本体は「ファイルを置く」ことではなく「動かない原因を
  潰す」こと、という PLAN-v7 の読みは正しかった。バグ 5 つは全部
  Octane 以外の実世界コードでも踏む汎用バグ

## 残課題 (Phase 31 へ)

- object JIT: this の参照スロット対応 (tagged 表現 or HC ベースの
  スロット型追跡)、polymorphic IC
- navier-stokes カーネルの JIT: クロージャ upvalue + 配列 + 相互呼び出し
  の同時コンパイル
- splay: GC のプロファイルと改善 (世代別 or 割り当て削減)
- crypto / raytrace の追加 (raytrace は arguments/apply の完成度が試される)
