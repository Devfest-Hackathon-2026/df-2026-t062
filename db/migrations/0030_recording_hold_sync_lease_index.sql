-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS recordings_hold_sync_lease
  ON recordings (retention_hold_sync_claimed_at, id)
  WHERE retention_hold_sync_claim_token IS NOT NULL;

