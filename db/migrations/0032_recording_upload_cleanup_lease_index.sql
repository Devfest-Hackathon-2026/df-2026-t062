-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS recordings_upload_cleanup_lease
  ON recordings (upload_cancel_claimed_at, id)
  WHERE status = 'abandoning';

