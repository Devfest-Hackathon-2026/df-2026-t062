ALTER TABLE recordings
  ALTER COLUMN source_expires_at SET DEFAULT (now() + interval '14 days'),
  ALTER COLUMN retention_policy_version SET DEFAULT 'recording-retention-v2';

WITH updated AS (
  UPDATE recordings
     SET source_expires_at = recorded_at + interval '14 days',
         retention_policy_version = 'recording-retention-v2',
         source_delete_status = CASE
           WHEN source_delete_status IN ('pending', 'eligible')
             AND NOT retention_hold
             AND NOT retention_hold_target
             AND retention_hold_sync_status = 'synced'
             AND recorded_at + interval '14 days' <= now() THEN 'eligible'
           WHEN source_delete_status IN ('pending', 'eligible') THEN 'pending'
           ELSE source_delete_status
         END
   WHERE source_delete_status <> 'deleted'
  RETURNING id, office_id, client_id, document_id, source_expires_at
)
INSERT INTO audit_events (
  office_id, client_id, document_id, action, outcome, source, schema_version, detail
)
SELECT office_id, client_id, document_id, 'recording.retention_policy_migrated', 'success', 'migration', 1,
       jsonb_build_object(
         'recordingId', id,
         'previousPolicyVersion', 'recording-retention-v1',
         'nextPolicyVersion', 'recording-retention-v2',
         'nextExpiresAt', source_expires_at
       )
  FROM updated;
