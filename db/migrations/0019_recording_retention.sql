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
    (NOT retention_hold
      AND retention_hold_until IS NULL
      AND retention_hold_reason_code IS NULL
      AND retention_hold_set_at IS NULL
      AND retention_hold_set_by IS NULL)
    OR (retention_hold
      AND source_delete_status = 'pending'
      AND retention_hold_until IS NOT NULL
      AND retention_hold_reason_code IS NOT NULL
      AND retention_hold_set_at IS NOT NULL
      AND retention_hold_until > retention_hold_set_at)
  ),
  ADD CONSTRAINT recordings_source_deleted_state_check CHECK (
    (source_delete_status = 'deleted') = (source_deleted_at IS NOT NULL)
  );

ALTER TABLE recordings
  ALTER COLUMN source_expires_at SET DEFAULT (now() + interval '7 days');

CREATE PROCEDURE backfill_recording_source_expiry() LANGUAGE plpgsql AS $$
DECLARE
  changed integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id FROM recordings
      WHERE source_expires_at IS NULL
      ORDER BY id
      LIMIT 500
      FOR UPDATE SKIP LOCKED
    )
    UPDATE recordings r
    SET source_expires_at = r.recorded_at + interval '7 days',
        source_delete_status = CASE
          WHEN r.recorded_at + interval '7 days' <= now() THEN 'eligible'
          ELSE 'pending'
        END
    FROM batch
    WHERE r.id = batch.id;

    GET DIAGNOSTICS changed = ROW_COUNT;
    COMMIT;
    EXIT WHEN changed = 0;
  END LOOP;
END
$$;
