-- 録音Retention本番導入前後の読み取り確認。
-- このファイルはSELECTだけを含み、DDL・DML・GRANTは実行しない。

-- Migration Runnerが認識している適用履歴。
SELECT name, applied_at
FROM public.schema_migrations
ORDER BY name;

-- 0018適用後の監査テーブルと、Retention列の存在確認。
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('audit_events', 'access_audit_events', 'security_audit_events', 'recording_consent_events')
ORDER BY table_name;

-- 録音開始前の同意イベントを必須にする最新スキーマの確認。
SELECT table_name, column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'recordings' AND column_name = 'consent_event_id')
    OR (table_name = 'recording_consent_events' AND column_name IN ('id', 'event_type', 'occurred_at'))
  )
ORDER BY table_name, ordinal_position;

SELECT trigger_name, event_object_table, action_timing, event_manipulation
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND trigger_name = 'recording_consent_events_guard'
ORDER BY event_manipulation;

SELECT table_name, column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'audit_events' AND column_name IN ('occurred_at', 'outcome', 'request_id', 'correlation_id', 'trace_id', 'source', 'route', 'schema_version'))
    OR (table_name = 'recordings' AND column_name IN ('source_expires_at', 'source_purge_expected_at', 'intermediate_expires_at', 'intermediate_delete_status', 'intermediate_deleted_at', 'intermediate_delete_attempts', 'source_generation', 'retention_hold', 'retention_hold_target', 'retention_hold_sync_status', 'retention_hold_until', 'retention_hold_sync_last_error_code', 'source_delete_status'))
  )
ORDER BY table_name, ordinal_position;

-- Lifecycle有効化前に0であるべき不整合件数。
SELECT
  count(*) FILTER (WHERE source_deleted_at IS NULL AND source_expires_at IS NULL) AS missing_expiry,
  count(*) FILTER (WHERE source_deleted_at IS NOT NULL AND source_purge_expected_at IS NULL) AS missing_purge_expectation,
  count(*) FILTER (WHERE source_deleted_at IS NULL AND status = 'uploaded' AND source_generation IS NULL) AS missing_generation,
  count(*) FILTER (WHERE source_deleted_at IS NULL AND retention_hold_sync_status = 'legacy') AS legacy_hold_sync,
  count(*) FILTER (WHERE source_deleted_at IS NULL AND retention_hold_sync_status <> 'synced'
    AND (retention_hold OR retention_hold_target)) AS unsynced_holds,
  count(*) FILTER (WHERE source_deleted_at IS NULL AND retention_hold_sync_escalated_at IS NOT NULL) AS escalated_holds,
  count(*) FILTER (WHERE source_deleted_at IS NULL AND source_delete_status = 'failed') AS failed_deletions,
  count(*) FILTER (WHERE source_deleted_at IS NULL AND source_delete_status = 'deleting'
    AND source_delete_claimed_at <= now() - interval '15 minutes') AS stuck_deletions,
  count(*) FILTER (WHERE source_deleted_at IS NULL AND retention_hold_target AND retention_hold_until <= now()) AS expired_active_holds,
  count(*) FILTER (WHERE source_deleted_at IS NULL AND status IN ('uploading', 'abandoning')
    AND upload_started_at IS NOT NULL AND upload_started_at <= now() - interval '7 days') AS stale_uploads,
  count(*) FILTER (WHERE intermediate_expires_at IS NULL) AS intermediate_missing_expiry,
  count(*) FILTER (WHERE intermediate_delete_status = 'failed') AS intermediate_failed_deletions,
  count(*) FILTER (WHERE intermediate_delete_status = 'deleting'
    AND intermediate_delete_claimed_at <= now() - interval '15 minutes') AS intermediate_stuck_deletions,
  count(*) FILTER (WHERE intermediate_delete_status = 'deleted' AND intermediate_deleted_at IS NULL) AS intermediate_deleted_state_mismatch,
  count(*) FILTER (WHERE intermediate_deleted_at IS NULL AND intermediate_expires_at <= now()
    AND NOT retention_hold AND NOT retention_hold_target
    AND intermediate_delete_status IN ('pending', 'failed')
    AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.recording_id = recordings.id AND j.status IN ('queued', 'processing'))) AS intermediate_overdue
FROM public.recordings;

-- Cleanup専用ロールとIAM DBユーザーの所属確認。
SELECT member.rolname AS member_role, parent.rolname AS granted_role, membership.admin_option
FROM pg_auth_members AS membership
JOIN pg_roles AS member ON member.oid = membership.member
JOIN pg_roles AS parent ON parent.oid = membership.roleid
WHERE parent.rolname = 'recording_cleanup'
ORDER BY member.rolname;

-- Cleanup専用ロールに必要な権限の確認。
SELECT
  has_schema_privilege('recording_cleanup', 'public', 'USAGE') AS schema_usage,
  has_table_privilege('recording_cleanup', 'public.recordings', 'SELECT') AS recordings_select,
  has_table_privilege('recording_cleanup', 'public.recordings', 'UPDATE') AS recordings_update,
  has_table_privilege('recording_cleanup', 'public.jobs', 'SELECT') AS jobs_select,
  has_table_privilege('recording_cleanup', 'public.transcripts', 'SELECT') AS transcripts_select,
  has_table_privilege('recording_cleanup', 'public.transcripts', 'DELETE') AS transcripts_delete,
  has_table_privilege('recording_cleanup', 'public.recording_summaries', 'SELECT') AS summaries_select,
  has_table_privilege('recording_cleanup', 'public.recording_summaries', 'DELETE') AS summaries_delete,
  has_table_privilege('recording_cleanup', 'public.care_record_drafts', 'SELECT') AS care_record_drafts_select,
  has_table_privilege('recording_cleanup', 'public.care_record_drafts', 'UPDATE') AS care_record_drafts_update,
  (
    SELECT bool_and(has_column_privilege('recording_cleanup', 'public.audit_events', required.column_name, 'INSERT'))
    FROM (VALUES
      ('office_id'), ('staff_id'), ('client_id'), ('document_id'), ('action'),
      ('outcome'), ('request_id'), ('correlation_id'), ('trace_id'), ('source'),
      ('route'), ('schema_version'), ('detail')
    ) AS required(column_name)
  ) AS audit_insert,
  has_sequence_privilege('recording_cleanup', 'public.audit_events_id_seq', 'USAGE') AS audit_sequence_usage,
  has_sequence_privilege('recording_cleanup', 'public.audit_events_id_seq', 'SELECT') AS audit_sequence_select;
