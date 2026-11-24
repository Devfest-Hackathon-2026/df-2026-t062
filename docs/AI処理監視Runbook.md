# AI処理監視Runbook

## 目的

非同期AI処理の失敗、リトライ、滞留、処理時間、推定費用を確認するための手順です。ログには音声、文字起こし、プロンプト、AI出力、利用者情報を記録しません。

## 監視項目

- `ai.job`: ジョブの開始、成功、部分成功、リトライ、最終失敗、リース切れ
- `ai.queue`: queued件数、processing件数、最古ジョブの滞留時間
- 処理時間: `duration_ms` の分布
- 費用: `estimated_cost_yen`。実請求額ではなく、モデル単価による推定値

## アラート発生時

1. Cloud Monitoringでアラート名、発生時刻、`job_type`を確認する
2. Cloud Run WorkerとCloud Tasksの実行状態を確認する
3. Cloud SQLで対象ジョブの状態、試行回数、`error_kind`、`lease_until`を確認する
4. ログでは`error_code`、`phase`、処理時間だけを確認する
5. 音声本文、文字起こし、プロンプト、AI出力をログ検索しない
6. retry可能ならキュー再配信を待ち、最終失敗なら原因を修正してから再実行する

## 判断基準

- 失敗アラート: 直近1時間に最終失敗が3件以上
- 滞留アラート: 最古のqueuedジョブが初期値15分を超過
- processing滞留: processing状態の最古ジョブが初期値30分を超過
- 費用急増: 24時間の推定値が設定閾値を超過。Cloud Billingの請求額を正とする

## ログ安全性

監視イベントには識別・集計に必要な最小限のジョブIDと相関IDだけを含めます。個人情報やAI入出力を追加する場合は、実装前に監査・セキュリティ設計を見直してください。

## 閾値変更

Terraformの`ai_job_backlog_age_threshold_seconds`と`ai_job_cost_alert_yen`で変更します。初回は7日間の実績を観測し、誤警報と検知漏れを確認してから変更します。
