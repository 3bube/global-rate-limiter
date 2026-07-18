CREATE TABLE IF NOT EXISTS request_log (
  id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL,
  allowed BOOLEAN NOT NULL,
  check_latency_ms DOUBLE PRECISION NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);

-- The dashboard's main query pattern is "usage for client X over the last
-- N days", so index on exactly that.
CREATE INDEX IF NOT EXISTS idx_request_log_client_time
  ON request_log (client_id, occurred_at DESC);
