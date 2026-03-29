# CLAUDE.md — jsmini の開発ルール

## ブランチとマージのルール

- **TODO が全部終わってから main にマージ**。途中の状態でマージしない
- 作業はブランチで行い、全 TODO 完了後に PR を作成
- **マージはユーザーの確認を取ってから**。勝手にマージしない
- 途中コミットはブランチに push するだけ

フロー:
1. ブランチ作成 (`phase8-extra-xxx` 等)
2. TODO を 1-2 個実施してコミット → ブランチに push
3. **draft PR を出す** (進捗の可視化)
4. 残りの TODO を進めてコミット → push
5. **全 TODO 完了** → draft を外す (Ready for review)
6. **ユーザーの確認** → マージ

## コーディング規約

- enum は使わない。TypeScript でシンプルに JS に変換できないものは不要
- テストはコロケーション (同じフォルダに `.test.ts`)
- コミットは 1 TODO = 1 コミット

## テスト

- `npm test` が全パスしていることを確認してからコミット
- 新機能には必ずテストを追加

## ベンチマーク

- `npm run bench` は `--noopt --no-sparkplug --no-maglev` (V8-JIT 無効) で実行
- V8-JIT あり結果も `npx tsx src/bench.ts` で計測
