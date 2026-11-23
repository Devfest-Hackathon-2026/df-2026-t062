-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS recordings_generation_backfill
  ON recordings (id)
  WHERE status = 'uploaded' AND source_generation IS NULL;

