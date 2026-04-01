# TODO Phase 13 — 構文拡大

## 動機

test262 準拠率 30.9% (252/841)。未対応構文が多く、テストの大半がパーサーエラーで落ちる。
基本的な JS 構文を一通り対応して、「教育用エンジンとして一通りのコードが動く」状態にする。

## 現状の対応/未対応

### 対応済み
- var/let/const, function, class (constructor, method, extends)
- if/else, for, while, for...of, break, continue
- +, -, *, /, %, ==, ===, !=, !==, <, >, <=, >=, &&, ||, !
- ++, --, +=, -=, *=, /=
- arrow function, template literal, destructuring, spread
- typeof, instanceof, in, throw/try/catch/finally
- new, this, return
- SequenceExpression (comma)

### 未対応 (パーサー/レキサーレベル)

| 構文 | 優先度 | 理由 |
|------|--------|------|
| **ternary `?:`** | 高 | 非常に頻出。test262 ハーネスも使う |
| **switch** | 高 | 基本構文。test262 テスト多数 |
| **do-while** | 高 | 基本ループ。実装コスト低い |
| **for-in** | 高 | オブジェクト列挙。test262 で頻出 |
| **bitwise `& \| ^ ~`** | 中 | 整数演算。test262 の数値テストで使われる |
| **shift `<< >> >>>`** | 中 | 整数演算 |
| **optional chaining `?.`** | 中 | test262 ハーネスが使用 |
| **nullish coalescing `??`** | 中 | モダン JS で頻出 |
| **exponent `**`** | 中 | ES2016 |
| **0x/0b/0o リテラル** | 中 | 数値リテラル。test262 で使われる |
| **regex `/pattern/`** | 低 | レキサーの大きな変更が必要 |
| **labeled statement** | 低 | 使用頻度低い |
| **getter/setter** | 低 | パーサー + evaluator/VM 対応 |

## ステップ

- [x] 13-0: ternary `? :` (ConditionalExpression)
- [x] 13-1: switch/case/default
- [x] 13-2: do-while
- [ ] 13-3: for-in
- [ ] 13-4: bitwise operators (`&`, `|`, `^`, `~`) + shift (`<<`, `>>`, `>>>`)
- [ ] 13-5: 0x/0b/0o 数値リテラル + `**` 演算子
- [ ] 13-6: optional chaining `?.` + nullish coalescing `??`
- [ ] 13-7: test262 準拠率確認
