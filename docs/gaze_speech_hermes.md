# Hermesへ送る指示

次の区切りから下を、Avatar Gatewayの会話欄ではなく、Hermes自身のチャットへそのまま送ってください。ジョブ名と `deliver` は変えないでください。実行間隔だけは、送る前に好みの間隔へ書き換えて構いません。

---

視線発話用のSkillとcronジョブを作ってください。同じ名前のジョブが既にある場合は、新しく増やさず、そのジョブを次の内容へ更新してください。

## Skill

Skill名は `avatar-gateway-gaze` です。次の内容でSkillを作成し、cronから読み込める状態にしてください。

```markdown
---
name: avatar-gateway-gaze
description: Use when preparing gaze speech for the camera cron. Two or three beats, or silence.
---

# 視線発話

カメラを向いたときに読む反応だけを用意する。通常の会話へは送らない。

## 出力

最終応答は次のどちらか一つだけ。

用件があるとき: 2つか3つのブロック。各ブロックは `[avatar]` の直後に `[speech]`。`[avatar]` の中は v が 1、motion、expression だけのJSON。motion と expression は下の名前から選び、ブロックごとに前と変える。`[speech]` の中は、確認した用件を静かで具体的な口語の一文にする。

用件がないとき: `[gaze:silent]`。身振り用のブロックは出さない。カメラを見た瞬間の無言の身振りはゲートウェイが付ける。

## 規則

- 書式の説明、見出し、箇条書き、コードブロックを出さない
- 見本や穴埋めの文言をそのまま話さない
- 前回と同じ内容を繰り返さない
- 秘密、パス、コマンド、タグの説明を話さない
- 用件がないのに挨拶や相槌を作らない
- `[speech]` と `[gaze:silent]` を同時に出さない

## motion

- nod: 同意、短い確認
- lean_forward: 興味、注意
- hands_behind_back: 穏やかに考える
- energetic_raise: 喜び、明るい報告
- put_your_hands_up: 参った、お手上げ
- bow: 軽いお礼
- deep_bow: 深い感謝、真剣な謝罪
- lightly_spread_arms: 受け入れ
- sexy_pose: 自信のある決めポーズ
- cute_standing: 控えめに見せる
- cute_confident: 可愛い自信
- small_open_arms: かわいい待機
- extend_hands: 強めの受け入れ
- salute: 了解、任務の受諾
- gentle_open_arms: かわいい待機
- please: お願い
- wave: 挨拶
- crossed_arms: 考え込む
- angry_pose: 不満
- nervous_pose: 頬に手を当てる
- hopping_vampire_pose: 東洋吸血鬼のポーズ
- strange_pose: かっこよく考える
- zua_pose: 疑問、軽い否定
- bat_pose: ダメ、失敗
- maru_pose: OK、成功
- thinking_pose: 深く考える
- inspiration_pose: 思いつき、要点
- none: どれにも当てはまらない

## expression

neutral, happy, relaxed, sad, angry, surprised, shy
```

## cronジョブ

次の条件でジョブを作成または更新してください。

- 名前: `avatar-gateway-gaze`
- スケジュール: `every 30m`
- 付けるSkill: `avatar-gateway-gaze`
- `deliver`: `local` を明示する。`origin` やチャットへの配信は使わない
- `continuity`: 有効にする。前回の出力を見て、同じ用件を繰り返さない
- このジョブの実行結果を、Avatar Gatewayの会話セッションやAPIサーバーのoriginへ戻さない

プロンプトは次のとおりです。

```text
記憶、予定、未完了の作業、前回の出力を確認してください。利用者が次にカメラを向いたとき話すべき新しい用件があれば、Skillの形で2つか3つの違う反応を用意してください。新しい用件がなければ [gaze:silent] とだけ返してください。
```

作成後、ジョブ一覧で次を確認して報告してください。

- 名前が `avatar-gateway-gaze` である
- `deliver` が `local` である
- Skill `avatar-gateway-gaze` が付いている
- continuity が有効である
- 同名のジョブが一つだけである

確認できたら、Avatar Gatewayを起動したあとに、そのジョブを一度だけ実行してください。起動時点で既にある出力は読み上げず、その後に増えたファイルだけを話します。出力は `~/.hermes/cron/output/<ジョブID>/` のMarkdownファイルになります。別のHermes Profileを使っている場合は、そのProfileのcronディレクトリを `HERMES_CRON_DIR` に指定し、出力先も報告してください。
