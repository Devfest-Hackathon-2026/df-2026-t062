-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS recordings_source_delete_candidates
  ON recordings (source_delete_status, source_expires_at)
  WHERE source_delete_status IN ('pending', 'eligible', 'requested')
    AND source_deleted_at IS NULL;
