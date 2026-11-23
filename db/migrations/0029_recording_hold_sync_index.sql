-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS recordings_hold_sync
  ON recordings (retention_hold_sync_status, retention_hold_sync_next_retry_at, id)
  WHERE retention_hold_sync_status <> 'synced';

