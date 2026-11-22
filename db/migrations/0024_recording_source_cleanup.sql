ALTER TABLE recordings
  DROP CONSTRAINT recordings_status_check;

ALTER TABLE recordings
  ADD CONSTRAINT recordings_status_check
    CHECK (status IN ('uploading', 'abandoning', 'uploaded', 'failed')),
  ADD COLUMN source_generation numeric(20,0),
  ADD COLUMN source_metageneration numeric(20,0),
  ADD COLUMN source_delete_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN source_delete_claim_token uuid,
  ADD COLUMN source_delete_claimed_at timestamptz,
  ADD COLUMN source_delete_last_attempt_at timestamptz,
  ADD COLUMN source_delete_next_retry_at timestamptz,
  ADD COLUMN source_delete_last_error_code text,
  ADD COLUMN source_soft_delete_retention_seconds integer,
  ADD COLUMN source_purge_expected_at timestamptz,
  ADD COLUMN retention_hold_target boolean NOT NULL DEFAULT false,
  ADD COLUMN retention_hold_sync_status text NOT NULL DEFAULT 'legacy',
  ADD COLUMN retention_hold_operation_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN retention_hold_sync_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN retention_hold_sync_claim_token uuid,
  ADD COLUMN retention_hold_sync_claimed_at timestamptz,
  ADD COLUMN retention_hold_sync_last_attempt_at timestamptz,
  ADD COLUMN retention_hold_sync_next_retry_at timestamptz,
  ADD COLUMN retention_hold_sync_last_error_code text,
  ADD COLUMN retention_hold_sync_escalated_at timestamptz,
  ADD COLUMN upload_started_at timestamptz,
  ADD COLUMN upload_completed_at timestamptz,
  ADD COLUMN upload_cancel_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN upload_cancel_claim_token uuid,
  ADD COLUMN upload_cancel_claimed_at timestamptz,
  ADD COLUMN upload_cancel_last_attempt_at timestamptz,
  ADD COLUMN upload_cancel_next_retry_at timestamptz,
  ADD COLUMN upload_cancel_last_error_code text,
  ADD COLUMN upload_cancel_escalated_at timestamptz;

