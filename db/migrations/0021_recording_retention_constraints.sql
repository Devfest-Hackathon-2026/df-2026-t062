ALTER TABLE recordings
  ADD CONSTRAINT recordings_source_expires_not_null CHECK (source_expires_at IS NOT NULL) NOT VALID;

ALTER TABLE recordings
  VALIDATE CONSTRAINT recordings_source_expires_not_null;

ALTER TABLE recordings
  ALTER COLUMN source_expires_at SET NOT NULL;

ALTER TABLE recordings
  DROP CONSTRAINT recordings_source_expires_not_null;

DROP PROCEDURE backfill_recording_source_expiry();
