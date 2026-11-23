ALTER TABLE recordings
  ALTER COLUMN source_expires_at SET DEFAULT (now() + interval '14 days'),
  ADD COLUMN intermediate_expires_at timestamptz,
  ADD COLUMN intermediate_delete_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN intermediate_deleted_at timestamptz,
  ADD COLUMN intermediate_delete_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN intermediate_delete_claim_token uuid,
  ADD COLUMN intermediate_delete_claimed_at timestamptz,
  ADD COLUMN intermediate_delete_last_attempt_at timestamptz,
  ADD COLUMN intermediate_delete_next_retry_at timestamptz,
  ADD COLUMN intermediate_delete_last_error_code text;

ALTER TABLE recordings
  ALTER COLUMN intermediate_expires_at SET DEFAULT (now() + interval '14 days'),
  ADD CONSTRAINT recordings_intermediate_delete_status_check
    CHECK (intermediate_delete_status IN ('pending', 'deleting', 'deleted', 'failed')),
  ADD CONSTRAINT recordings_intermediate_delete_attempts_check
    CHECK (intermediate_delete_attempts >= 0),
  ADD CONSTRAINT recordings_intermediate_deleted_state_check
    CHECK ((intermediate_delete_status = 'deleted') = (intermediate_deleted_at IS NOT NULL)),
  ADD CONSTRAINT recordings_intermediate_delete_claim_check
    CHECK (
      (intermediate_delete_status = 'deleting') =
        (intermediate_delete_claim_token IS NOT NULL AND intermediate_delete_claimed_at IS NOT NULL)
    );

UPDATE recordings
   SET intermediate_expires_at = recorded_at + interval '14 days'
 WHERE intermediate_expires_at IS NULL;

ALTER TABLE recordings
  ALTER COLUMN intermediate_expires_at SET NOT NULL;

CREATE INDEX recordings_intermediate_cleanup_due
  ON recordings (intermediate_expires_at, id)
  WHERE intermediate_delete_status IN ('pending', 'failed')
    AND intermediate_deleted_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recording_cleanup') THEN
    GRANT SELECT ON jobs TO recording_cleanup;
    GRANT SELECT, DELETE ON transcripts, recording_summaries TO recording_cleanup;
    GRANT SELECT, UPDATE ON care_record_drafts TO recording_cleanup;
  END IF;
END
$$;
