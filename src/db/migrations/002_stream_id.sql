-- Carry the Redis stream entry id on every analytics row so that a worker
-- crashing between INSERT and XACK cannot produce duplicate billing rows:
-- redelivered entries hit the unique index and are dropped by
-- ON CONFLICT (stream_id) DO NOTHING.
ALTER TABLE request_log ADD COLUMN IF NOT EXISTS stream_id TEXT;

-- A unique *index* (not constraint) so pre-migration rows with NULL
-- stream_id remain valid -- Postgres unique indexes permit multiple NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_log_stream_id
  ON request_log (stream_id);
