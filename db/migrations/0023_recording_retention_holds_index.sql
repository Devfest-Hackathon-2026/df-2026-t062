-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS recordings_retention_holds
  ON recordings (retention_hold_until)
  WHERE retention_hold;
