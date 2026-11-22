ALTER TABLE recordings
  DROP CONSTRAINT recordings_retention_hold_fields_check,
  DROP CONSTRAINT recordings_source_deleted_state_check;

ALTER TABLE recordings
  ADD CONSTRAINT recordings_source_delete_attempts_check
    CHECK (source_delete_attempts >= 0),
  ADD CONSTRAINT recordings_hold_sync_attempts_check
    CHECK (retention_hold_sync_attempts >= 0),
  ADD CONSTRAINT recordings_upload_cancel_attempts_check
    CHECK (upload_cancel_attempts >= 0),
  ADD CONSTRAINT recordings_hold_sync_status_check
    CHECK (retention_hold_sync_status IN ('legacy', 'synced', 'applying', 'releasing', 'failed')),
  ADD CONSTRAINT recordings_hold_target_state_check CHECK (
    (retention_hold_sync_status = 'legacy')
    OR (retention_hold_sync_status = 'synced' AND retention_hold = retention_hold_target)
    OR (retention_hold_sync_status = 'applying' AND retention_hold_target)
    OR (retention_hold_sync_status = 'releasing' AND NOT retention_hold_target)
    OR (retention_hold_sync_status = 'failed')
  ),
  ADD CONSTRAINT recordings_retention_hold_fields_check CHECK (
    (NOT retention_hold AND NOT retention_hold_target
      AND retention_hold_until IS NULL
      AND retention_hold_reason_code IS NULL
      AND retention_hold_set_at IS NULL
      AND retention_hold_set_by IS NULL)
    OR ((retention_hold OR retention_hold_target)
      AND retention_hold_until IS NOT NULL
      AND retention_hold_reason_code IS NOT NULL
      AND retention_hold_set_at IS NOT NULL
      AND retention_hold_until > retention_hold_set_at
      AND retention_hold_until <= retention_hold_set_at + interval '90 days')
    OR retention_hold_sync_status = 'legacy'
  ),
  ADD CONSTRAINT recordings_source_deleted_state_check CHECK (
    (source_delete_status = 'deleted') = (source_deleted_at IS NOT NULL)
    AND (source_soft_delete_retention_seconds IS NULL OR source_delete_status = 'deleted')
    AND (source_purge_expected_at IS NULL OR source_delete_status = 'deleted')
  ),
  ADD CONSTRAINT recordings_source_delete_claim_check CHECK (
    (source_delete_status = 'deleting') =
      (source_delete_claim_token IS NOT NULL AND source_delete_claimed_at IS NOT NULL)
  ),
  ADD CONSTRAINT recordings_hold_sync_claim_check CHECK (
    (retention_hold_sync_claim_token IS NULL AND retention_hold_sync_claimed_at IS NULL)
    OR (retention_hold_sync_claim_token IS NOT NULL AND retention_hold_sync_claimed_at IS NOT NULL)
  ),
  ADD CONSTRAINT recordings_upload_cancel_claim_check CHECK (
    (status = 'abandoning') =
      (upload_cancel_claim_token IS NOT NULL AND upload_cancel_claimed_at IS NOT NULL)
  );
