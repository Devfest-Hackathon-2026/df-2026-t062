-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS recordings_cleanup_lease
  ON recordings (source_delete_claimed_at, id)
  WHERE source_delete_status = 'deleting';

