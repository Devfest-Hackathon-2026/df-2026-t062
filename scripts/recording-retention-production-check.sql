-- 録音Retention本番Smoke Check。
-- psql -v ON_ERROR_STOP=1 で実行し、異常があれば非0終了する。
-- 個人情報・音声本文・オブジェクトパスは読み取らない。

\set ON_ERROR_STOP on

DO $$
DECLARE
  missing_migrations text;
  missing_tables text;
  missing_columns text;
  trigger_count integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations is missing';
  END IF;

  SELECT string_agg(required_name, ', ' ORDER BY required_name)
    INTO missing_migrations
  FROM unnest(ARRAY[
    '0018_audit_events.sql',
    '0019_recording_retention.sql',
    '0020_recording_retention_backfill.sql',
    '0021_recording_retention_constraints.sql',
    '0022_recording_delete_candidates_index.sql',
    '0023_recording_retention_holds_index.sql',
    '0024_recording_source_cleanup.sql',
    '0025_recording_source_cleanup_constraints.sql',
    '0026_recording_cleanup_due_index.sql',
    '0027_recording_cleanup_retry_index.sql',
    '0028_recording_cleanup_lease_index.sql',
    '0029_recording_hold_sync_index.sql',
    '0030_recording_hold_sync_lease_index.sql',
    '0031_recording_upload_cleanup_index.sql',
    '0032_recording_upload_cleanup_lease_index.sql',
    '0033_recording_generation_backfill_index.sql',
    '0036_recording_retention_14_days.sql',
    '0037_recording_intermediate_retention.sql',
    '0039_recording_consent.sql',
    '0040_recording_consent_integrity.sql'
  ]) AS required(required_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.schema_migrations applied
    WHERE applied.name = required.required_name
  );

  IF missing_migrations IS NOT NULL THEN
    RAISE EXCEPTION 'required migrations are missing: %', missing_migrations;
  END IF;

  SELECT string_agg(required_name, ', ' ORDER BY required_name)
    INTO missing_tables
  FROM unnest(ARRAY[
    'audit_events',
    'access_audit_events',
    'security_audit_events',
    'recordings',
    'recording_consent_events',
    'jobs',
    'transcripts',
    'recording_summaries',
    'care_record_drafts'
  ]) AS required(required_name)
  WHERE to_regclass('public.' || required.required_name) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'required tables are missing: %', missing_tables;
  END IF;

  SELECT string_agg(required_name, ', ' ORDER BY required_name)
    INTO missing_columns
  FROM (
    VALUES
      ('recordings.source_expires_at'),
      ('recordings.source_deleted_at'),
      ('recordings.source_purge_expected_at'),
      ('recordings.source_generation'),
      ('recordings.source_delete_status'),
      ('recordings.source_delete_claimed_at'),
      ('recordings.retention_hold'),
      ('recordings.retention_hold_target'),
      ('recordings.retention_hold_sync_status'),
      ('recordings.retention_hold_until'),
      ('recordings.retention_hold_sync_escalated_at'),
      ('recordings.intermediate_expires_at'),
      ('recordings.intermediate_delete_status'),
      ('recordings.intermediate_deleted_at'),
      ('recordings.intermediate_delete_claimed_at'),
      ('recordings.upload_started_at'),
      ('recordings.upload_completed_at'),
      ('recordings.consent_event_id'),
      ('audit_events.occurred_at'),
      ('audit_events.outcome'),
      ('audit_events.request_id'),
      ('audit_events.correlation_id'),
      ('audit_events.trace_id'),
      ('audit_events.source'),
      ('audit_events.route'),
      ('audit_events.schema_version'),
      ('access_audit_events.occurred_at'),
      ('access_audit_events.actor_staff_id'),
      ('access_audit_events.client_id'),
      ('access_audit_events.resource_type'),
      ('access_audit_events.resource_id'),
      ('access_audit_events.access_mode'),
      ('access_audit_events.action'),
      ('access_audit_events.outcome'),
      ('access_audit_events.request_id'),
      ('access_audit_events.correlation_id'),
      ('access_audit_events.trace_id'),
      ('access_audit_events.source'),
      ('access_audit_events.route'),
      ('access_audit_events.schema_version'),
      ('access_audit_events.result_count'),
      ('access_audit_events.detail'),
      ('security_audit_events.occurred_at'),
      ('security_audit_events.actor_staff_id'),
      ('security_audit_events.target_staff_id'),
      ('security_audit_events.action'),
      ('security_audit_events.outcome'),
      ('security_audit_events.request_id'),
      ('security_audit_events.correlation_id'),
      ('security_audit_events.trace_id'),
      ('security_audit_events.source'),
      ('security_audit_events.route'),
      ('security_audit_events.schema_version'),
      ('security_audit_events.reason_code'),
      ('security_audit_events.auth_method'),
      ('security_audit_events.permission'),
      ('security_audit_events.detail'),
      ('recording_consent_events.id'),
      ('recording_consent_events.office_id'),
      ('recording_consent_events.client_id'),
      ('recording_consent_events.event_type'),
      ('recording_consent_events.scope'),
      ('recording_consent_events.policy_version'),
      ('recording_consent_events.method'),
      ('recording_consent_events.actor_staff_id'),
      ('recording_consent_events.occurred_at'),
      ('recording_consent_events.created_at')
  ) AS required(required_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns column_info
    WHERE column_info.table_schema = 'public'
      AND column_info.table_name = split_part(required.required_name, '.', 1)
      AND column_info.column_name = split_part(required.required_name, '.', 2)
  );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'required columns are missing: %', missing_columns;
  END IF;

  SELECT count(*)
    INTO trigger_count
  FROM information_schema.triggers
  WHERE trigger_schema = 'public'
    AND trigger_name = 'recording_consent_events_guard'
    AND event_object_table = 'recording_consent_events';

  IF trigger_count <> 3 THEN
    RAISE EXCEPTION 'recording_consent_events_guard must cover INSERT, UPDATE and DELETE; found % trigger events', trigger_count;
  END IF;
END
$$;

DO $$
DECLARE
  invalid_count bigint;
BEGIN
  SELECT count(*)
    INTO invalid_count
  FROM public.recordings
  WHERE (source_deleted_at IS NULL AND source_expires_at IS NULL)
     OR (source_deleted_at IS NOT NULL AND source_purge_expected_at IS NULL)
     OR (source_deleted_at IS NULL AND status = 'uploaded' AND source_generation IS NULL)
     OR (source_deleted_at IS NULL AND retention_hold_sync_status = 'legacy')
     OR (source_deleted_at IS NULL
         AND retention_hold_sync_status <> 'synced'
         AND (retention_hold OR retention_hold_target))
     OR (source_deleted_at IS NULL AND retention_hold_sync_escalated_at IS NOT NULL)
     OR (source_deleted_at IS NULL AND source_delete_status = 'failed')
     OR (source_deleted_at IS NULL
         AND source_delete_status = 'deleting'
         AND source_delete_claimed_at <= now() - interval '15 minutes')
     OR (source_deleted_at IS NULL
         AND retention_hold_target
         AND retention_hold_until <= now())
     OR (source_deleted_at IS NULL
         AND status IN ('uploading', 'abandoning')
         AND upload_started_at IS NOT NULL
         AND upload_started_at <= now() - interval '7 days')
     OR intermediate_expires_at IS NULL
     OR intermediate_delete_status = 'failed'
     OR (intermediate_delete_status = 'deleting'
         AND intermediate_delete_claimed_at <= now() - interval '15 minutes')
     OR (intermediate_delete_status = 'deleted' AND intermediate_deleted_at IS NULL)
     OR (intermediate_deleted_at IS NULL
         AND intermediate_expires_at <= now()
         AND NOT retention_hold
         AND NOT retention_hold_target
         AND intermediate_delete_status IN ('pending', 'failed')
         AND NOT EXISTS (
           SELECT 1
           FROM public.jobs
           WHERE jobs.recording_id = recordings.id
             AND jobs.status IN ('queued', 'processing')
         ));

  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'recording retention smoke check found % invalid rows', invalid_count;
  END IF;
END
$$;

DO $$
DECLARE
  invalid_privilege boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recording_cleanup') THEN
    RAISE EXCEPTION 'recording_cleanup role is missing';
  END IF;

  SELECT NOT (
    has_schema_privilege('recording_cleanup', 'public', 'USAGE')
    AND has_table_privilege('recording_cleanup', 'public.recordings', 'SELECT')
    AND has_table_privilege('recording_cleanup', 'public.recordings', 'UPDATE')
    AND has_table_privilege('recording_cleanup', 'public.jobs', 'SELECT')
    AND has_table_privilege('recording_cleanup', 'public.transcripts', 'SELECT')
    AND has_table_privilege('recording_cleanup', 'public.transcripts', 'DELETE')
    AND has_table_privilege('recording_cleanup', 'public.recording_summaries', 'SELECT')
    AND has_table_privilege('recording_cleanup', 'public.recording_summaries', 'DELETE')
    AND has_table_privilege('recording_cleanup', 'public.care_record_drafts', 'SELECT')
    AND has_table_privilege('recording_cleanup', 'public.care_record_drafts', 'UPDATE')
    AND has_table_privilege('recording_cleanup', 'public.audit_events', 'INSERT')
    AND has_sequence_privilege('recording_cleanup', 'public.audit_events_id_seq', 'USAGE')
    AND has_sequence_privilege('recording_cleanup', 'public.audit_events_id_seq', 'SELECT')
  )
    INTO invalid_privilege;

  IF invalid_privilege THEN
    RAISE EXCEPTION 'recording_cleanup role does not have the required least-privilege grants';
  END IF;

  SELECT (
    has_schema_privilege('recording_cleanup', 'public', 'CREATE')
    OR has_table_privilege('recording_cleanup', 'public.recordings', 'INSERT')
    OR has_table_privilege('recording_cleanup', 'public.recordings', 'DELETE')
    OR has_table_privilege('recording_cleanup', 'public.audit_events', 'SELECT')
    OR has_table_privilege('recording_cleanup', 'public.audit_events', 'UPDATE')
    OR has_table_privilege('recording_cleanup', 'public.audit_events', 'DELETE')
    OR has_table_privilege('recording_cleanup', 'public.access_audit_events', 'SELECT')
    OR has_table_privilege('recording_cleanup', 'public.access_audit_events', 'INSERT')
    OR has_table_privilege('recording_cleanup', 'public.access_audit_events', 'UPDATE')
    OR has_table_privilege('recording_cleanup', 'public.access_audit_events', 'DELETE')
    OR has_table_privilege('recording_cleanup', 'public.security_audit_events', 'SELECT')
    OR has_table_privilege('recording_cleanup', 'public.security_audit_events', 'INSERT')
    OR has_table_privilege('recording_cleanup', 'public.security_audit_events', 'UPDATE')
    OR has_table_privilege('recording_cleanup', 'public.security_audit_events', 'DELETE')
    OR has_table_privilege('recording_cleanup', 'public.jobs', 'INSERT')
    OR has_table_privilege('recording_cleanup', 'public.jobs', 'UPDATE')
    OR has_table_privilege('recording_cleanup', 'public.jobs', 'DELETE')
    OR has_table_privilege('recording_cleanup', 'public.transcripts', 'INSERT')
    OR has_table_privilege('recording_cleanup', 'public.transcripts', 'UPDATE')
    OR has_table_privilege('recording_cleanup', 'public.recording_summaries', 'INSERT')
    OR has_table_privilege('recording_cleanup', 'public.recording_summaries', 'UPDATE')
    OR has_table_privilege('recording_cleanup', 'public.care_record_drafts', 'INSERT')
    OR has_table_privilege('recording_cleanup', 'public.care_record_drafts', 'DELETE')
    OR has_table_privilege('recording_cleanup', 'public.recording_consent_events', 'SELECT')
    OR has_table_privilege('recording_cleanup', 'public.recording_consent_events', 'INSERT')
    OR has_table_privilege('recording_cleanup', 'public.recording_consent_events', 'UPDATE')
    OR has_table_privilege('recording_cleanup', 'public.recording_consent_events', 'DELETE')
  )
    INTO invalid_privilege;

  IF invalid_privilege THEN
    RAISE EXCEPTION 'recording_cleanup role has an unexpected privilege';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'recording_cleanup'
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolcanlogin OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'recording_cleanup role has unsafe role attributes';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles parent ON parent.oid = membership.roleid
    WHERE parent.rolname = 'recording_cleanup'
      AND membership.admin_option
  ) THEN
    RAISE EXCEPTION 'recording_cleanup membership grants admin option';
  END IF;
END
$$;

SELECT 'recording-retention-production-check: OK' AS result;
