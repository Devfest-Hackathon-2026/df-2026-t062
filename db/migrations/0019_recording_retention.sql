ALTER TABLE recordings
  ADD COLUMN source_expires_at timestamptz,
  ADD COLUMN source_deleted_at timestamptz,
  ADD COLUMN source_delete_status text NOT NULL DEFAULT 'pending'
    CHECK (source_delete_status IN ('pending', 'eligible', 'requested', 'deleting', 'deleted', 'failed')),
  ADD COLUMN retention_policy_version text NOT NULL DEFAULT 'recording-retention-v1',
  ADD COLUMN retention_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN retention_hold_until timestamptz,
  ADD COLUMN retention_hold_reason_code text,
  ADD COLUMN retention_hold_set_at timestamptz,
  ADD COLUMN retention_hold_set_by uuid REFERENCES staff(id),
  ADD CONSTRAINT recordings_retention_hold_fields_check CHECK (
    NOT retention_hold
    OR (retention_hold_until IS NOT NULL AND retention_hold_reason_code IS NOT NULL AND retention_hold_set_at IS NOT NULL)
  );

UPDATE recordings
SET source_expires_at = recorded_at + interval '7 days',
    source_delete_status = CASE
      WHEN recorded_at + interval '7 days' <= now() THEN 'eligible'
      ELSE 'pending'
    END
WHERE source_expires_at IS NULL;

ALTER TABLE recordings
  ALTER COLUMN source_expires_at SET NOT NULL;

CREATE INDEX recordings_source_delete_candidates
  ON recordings (source_delete_status, source_expires_at)
  WHERE source_delete_status IN ('pending', 'eligible')
    AND source_deleted_at IS NULL;

CREATE INDEX recordings_retention_holds
  ON recordings (retention_hold, retention_hold_until)
  WHERE retention_hold;
