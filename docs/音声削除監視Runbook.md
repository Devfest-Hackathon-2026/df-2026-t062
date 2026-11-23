# 音声削除監視Runbook

## 目的

録音原本とAI処理中間データの保持期限・削除・保全状態を安全に確認するための運用手順。録音原本の保持期限はDBで管理し、GCS Soft Deleteは削除後3日間の復旧用安全措置として扱う。Soft Deleteの3日間は法令上の保存期間ではない。GCS Lifecycleは`recordings/`のLIVEオブジェクトに対する30日後の安全弁であり、DBを正とする通常削除の代替ではない。

## 最初に確認すること

1. Cloud Monitoringの録音削除Dashboardで、保持期限超過数、最終失敗数、保全不一致数、最終成功時刻を確認する。
2. Cloud Run Jobの実行履歴で、Schedulerから起動されたか、Jobが開始・完了したかを確認する。
3. Cloud Loggingで`recording.retention.*`を検索し、`error_code`と件数だけを確認する。音声内容、利用者情報、GCSの完全なオブジェクトパスをログへ追加しない。
4. Lifecycle有効化前のreadiness結果で、保持期限・中間データ期限・GCS世代・保全同期・削除滞留・未完了uploadの件数がすべて0であることを確認する。
5. Lifecycleを有効化する場合は、sourceバケットだけに`recordings/`・LIVE・30日のDelete条件が設定され、output・formsには設定されていないことをTerraform planで確認する。

## 本番運用の有効化

本番のScheduler・通知・Lifecycleは、readiness確認とTerraform planの確認を同じ手順で行う。通知チャネルを指定しない有効化は禁止する。

```bash
GCP_PROJECT_ID="<project-id>" \
GCP_REGION="asia-northeast1" \
CLOUD_RUN_RECORDING_CLEANUP_JOB="t062-recording-cleanup" \
MONITORING_NOTIFICATION_CHANNEL_IDS="projects/<project-id>/notificationChannels/<id>" \
ENABLE_RECORDING_CLEANUP_SCHEDULER=true \
ENABLE_SOURCE_LIFECYCLE=false \
APPLY=false \
bash scripts/enable-recording-retention-production.sh
```

Planの内容を確認した後だけ`APPLY=true`で再実行する。Lifecycleの有効化はScheduler・通知の初回成功を確認した後に、`ENABLE_SOURCE_LIFECYCLE=true`を指定して別途行う。通知は、最終失敗・保全不一致・Scheduler失敗・期限超過・Job無成功のアラートが同じ通知チャネルへ届くことを確認する。

既存の`enable-recording-lifecycle.sh`は互換用の入口であり、単独でTerraform applyは行わず、この手順へ委譲する。新規運用では`enable-recording-retention-production.sh`を使用する。

## Alert別の対応

### 保持期限超過

- Cloud SQLの`source_expires_at`、`source_delete_status`、保全状態の集計を確認する。
- `retention_hold`または`retention_hold_target`が有効なら、音声を削除しない。
- Jobが停止していなければ、次回の定期実行を待つ。停止している場合はJobの失敗原因を確認する。

### 中間データ削除滞留

- `intermediate_overdue_count`、`intermediate_stuck_count`、`intermediate_failed_past_retry_count`を確認する。
- 対象は`transcripts`と`recording_summaries`であり、ケア記録下書きに保存された録音由来の`utterances`も削除時に除去する。正式なケア記録と`audit_events`は削除対象ではない。
- `retention_hold`または`retention_hold_target`が有効な録音の中間データは削除しない。保全解除後にCleanup Jobが再度対象化する。
- 削除監査には本文を保存せず、削除件数と時刻だけを記録する。

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

### Lifecycle readiness失敗

- `missing_expiry_count` または `missing_generation_count` があれば、対象録音のDB値とGCSメタデータを確認する。
- `missing_purge_expectation`、`expired_active_holds`、`intermediate_deleted_state_mismatch` があれば、LifecycleやSchedulerを有効化せず、DBとGCSの状態を確認する。
- `legacy_hold_sync_count`、`unsynced_hold_count`、`escalated_hold_count` があれば、Object Holdの同期完了までLifecycleを有効化しない。
- `failed_deletion_count`、`stuck_deletion_count`、`stale_upload_count` があれば、Cleanup Jobの失敗原因を解消してから再確認する。
- `intermediate_missing_expiry_count`、`intermediate_failure_count`、`intermediate_stuck_count`、`intermediate_failed_past_retry_count`があれば、中間データの期限・削除状態・DB権限を確認してから再確認する。
- LifecycleはDBの`source_expires_at`、保全状態、削除状態を参照しない。30日条件に達しても、通常の削除判定は必ずCleanup JobがDBを確認して行う。

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
