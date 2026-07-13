# FUZZING — jsmini 差分ファザ (Fuzzilli 流)

jsmini の 3 つの実行エンジンにランダムな JS を食わせ、**結果の食い違い
(divergence)** をバグ候補として自動検出する差分ファザです。

- Tree-Walking Interpreter (`evaluate`)
- Bytecode VM (`vmEvaluate`)
- Bytecode VM + JIT (`vmEvaluate({ jit: true })`)

同じプログラムなら 3 エンジンは同じ結果 (完了値・throw・`console.log` の副作用)
になるはず。1 つでも食い違えば、いずれかのエンジンにバグがあります。

これは [Fuzzilli](https://github.com/googleprojectzero/fuzzilli) と同じ
「差分ファジング」の考え方です。本家 Fuzzilli は Swift 製でカバレッジ計装と
REPRL プロトコルを要求し、Node 上の TypeScript エンジンへ直結するには
ネイティブアドオンが必要なため、ここでは jsmini が **複数エンジンを内蔵する**
利点を活かして、同等の「エラー検出」を Node だけで完結させています。本家
Fuzzilli が生成した `.js` コーパスの再生にも対応します (`--corpus`)。

## 使い方

```bash
npm run fuzz                          # 既定: 2000 件生成して差分検出
npm run fuzz -- --iterations 50000    # 件数指定
npm run fuzz -- --seed 12345          # ベース seed 固定 (完全再現)
npm run fuzz -- --isolate             # 子プロセス隔離 (hang/クラッシュ耐性)
npm run fuzz -- --timeout 3000        # hang とみなすまでの ms (既定 2000)

# 本家 Fuzzilli の出力コーパスを再生 (任意の JS。常に子プロセス隔離)
npm run fuzz -- --corpus ./corpus

# 見つかった 1 件を詳細表示 (生値・エラーメッセージ込み)
npm run fuzz -- --repro 33286975      # 生成 seed (レポートの gen= の値)
npm run fuzz -- --repro fuzz-findings/cluster01.js
```

差分が 1 件でもあれば **exit code 1** で終了するので、CI に組み込めます。

## 出力

`fuzz-findings/` に、差分の**シグネチャでクラスタリング**した最小化済みの
再現コードが書き出されます (`clusterNN.js` と `SUMMARY.md`)。シグネチャは
`TW=... VM=... JIT=...` の形で、どのエンジンがどう食い違ったか (value /
throw:種別) を表します。`(logs差)` は完了値は同じだが `console.log` の
副作用だけ食い違うケースです。

## 判定の考え方

- **divergence**: 2 つ以上のエンジンで正規化結果が割れた → バグ候補。
- **timeout**: いずれかのエンジンが停止しない (無限ループ / JIT の誤コンパイル)。
- **crash**: 子プロセスがレスポンス前に落ちた (エンジン自体のクラッシュ)。
- ステップ上限超過・host スタックオーバーフローは実行モデルの構造差
  (TW は host 再帰) なので **判定不能** として除外し、ノイズにしない。

throw の比較は**エラー種別** (`TypeError` / `ReferenceError` 等) で行い、
message の文言差はノイズなので無視します。

## 構成

| ファイル | 役割 |
|---|---|
| `prng.ts` | seed 決定的な mulberry32 PRNG |
| `generator.ts` | jsmini 対応サブセットの有界・非再帰 JS 生成 |
| `normalize.ts` | エンジン横断で比較可能な canonical 表現へ正規化 |
| `runner.ts` | 3 エンジン実行 + divergence 判定 (in-process) |
| `child.ts` / `pool.ts` | REPRL 風の常駐子プロセス + タイムアウト再起動 |
| `minimize.ts` | 差分を保ったままソースを行単位で最小化 |
| `fuzz.ts` | CLI (生成 / コーパス再生 / 再現) |

## 制約 (今後の拡張余地)

- 生成器は「両エンジンが対応する共通サブセット」を狙う。単項 `+` など
  parser 未対応の構文は生成しない。対応構文が増えたら生成器も広げる。
- 差分ベースなので、**全エンジンが同じ間違いをする**バグは検出できない
  (本家 Fuzzilli のカバレッジガイドや、V8 等リファレンスエンジンとの
  差分を足せば拾える)。
- カバレッジガイドは未実装 (ランダム生成)。コーパス最小化・変異は
  `--corpus` に本家 Fuzzilli の出力を渡すことで補える。
