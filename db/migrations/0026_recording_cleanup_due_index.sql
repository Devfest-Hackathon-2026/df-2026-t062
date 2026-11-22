-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS recordings_cleanup_due
  ON recordings (source_expires_at, id)
  WHERE source_delete_status IN ('pending', 'eligible') AND source_deleted_at IS NULL;

