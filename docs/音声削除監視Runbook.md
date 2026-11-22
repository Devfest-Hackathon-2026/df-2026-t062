# 音声削除監視Runbook

## 目的

録音原本の保持期限・GCS削除・保全状態を安全に確認するための運用手順。録音原本の保持期限はDBで管理し、GCS Soft Deleteは削除後3日間の復旧用安全措置として扱う。Soft Deleteの3日間は法令上の保存期間ではない。

## 最初に確認すること

1. Cloud Monitoringの録音削除Dashboardで、保持期限超過数、最終失敗数、保全不一致数、最終成功時刻を確認する。
2. Cloud Run Jobの実行履歴で、Schedulerから起動されたか、Jobが開始・完了したかを確認する。
3. Cloud Loggingで`recording.retention.*`を検索し、`error_code`と件数だけを確認する。音声内容、利用者情報、GCSの完全なオブジェクトパスをログへ追加しない。

## Alert別の対応

### 保持期限超過

- Cloud SQLの`source_expires_at`、`source_delete_status`、保全状態の集計を確認する。
- `retention_hold`または`retention_hold_target`が有効なら、音声を削除しない。
- Jobが停止していなければ、次回の定期実行を待つ。停止している場合はJobの失敗原因を確認する。

### 削除最終失敗

- `error_code`、Cloud Run Jobの実行結果、GCS IAM、Cloud SQL接続を確認する。
- 権限・一時障害を解消した後、Cleanup Jobを再実行する。
- DBを直接`deleted`へ変更しない。

### DBとGCSの保全不一致

- DBの保全状態とGCS Object Holdを照合する。
- DBで保全中の場合は、GCSのHoldが確認できるまで削除しない。
- DBだけを先に解除しない。保全解除処理はGCS側の解除成功後にDBを確定する既存フローを使う。

### Job未成功・Scheduler失敗

- Schedulerの実行履歴を確認する。
- Schedulerが成功していてJobが開始されていなければCloud Run Jobの権限・API・実行履歴を確認する。
- Jobが開始されて完了していなければ、Cloud RunのログとCloud SQL接続を確認する。

## 安全な再実行

障害原因を確認してから、対象環境のCleanup Jobを実行する。

```bash
gcloud run jobs execute <cleanup-job-name> \
  --region <region> \
  --project <project-id> \
  --wait
```

再実行後は、成功ログ、DBの状態、GCS Object Hold、Alertの自動解除を確認する。

## 禁止事項

- 保全中の音声をGCSから直接削除しない。
- DBだけを直接`deleted`へ変更しない。
- Object Holdを確認せずに保持設定を解除しない。
- ログやIncident記録へ音声内容・transcript・利用者名・完全なGCSパスを書かない。

## エスカレーション

次の場合は手動操作を止め、責任者またはセキュリティ担当へ連絡する。

- DBとGCSの保全状態が一致しない。
- GCS削除成功後にDB更新が確認できない。
- Soft Deleteの復元が必要になった。
- 同一エラーが再実行後も継続する。
- 法的保全・規制対応の対象である可能性がある。
