-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS recordings_upload_cleanup
  ON recordings (upload_started_at, id)
  WHERE status = 'uploading' AND upload_url IS NOT NULL;

