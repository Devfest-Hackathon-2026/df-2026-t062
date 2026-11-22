-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS recordings_cleanup_retry
  ON recordings (source_delete_next_retry_at, id)
  WHERE source_delete_status IN ('requested', 'failed') AND source_deleted_at IS NULL;

