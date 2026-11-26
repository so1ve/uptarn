-- First-class declarative jobs: agent collector-managed jobs + hub push ping jobs.
CREATE TABLE jobs_v2 (
  key TEXT PRIMARY KEY,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  managed_by_node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  ping_token_hash TEXT,
  label TEXT NOT NULL,
  interval_secs INTEGER NOT NULL,
  grace_secs INTEGER NOT NULL DEFAULT 3600,
  muted_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  last_run_at INTEGER,
  next_run_at INTEGER,
  last_status TEXT NOT NULL DEFAULT 'pending',
  last_duration_ms INTEGER,
  last_summary TEXT,
  last_detail TEXT
);

INSERT INTO jobs_v2 (
  key, node_id, managed_by_node_id, ping_token_hash, label,
  interval_secs, grace_secs, muted_until, created_at,
  started_at, last_run_at, next_run_at, last_status,
  last_duration_ms, last_summary, last_detail
)
SELECT
  key, node_id, NULL, NULL, label,
  interval_secs, grace_secs, muted_until, created_at,
  NULL, last_run_at, NULL, last_status,
  last_duration_ms, last_summary, last_detail
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v2 RENAME TO jobs;

CREATE INDEX idx_jobs_node_id
  ON jobs (node_id) WHERE node_id IS NOT NULL;
CREATE INDEX idx_jobs_managed_by_node
  ON jobs (managed_by_node_id) WHERE managed_by_node_id IS NOT NULL;
CREATE UNIQUE INDEX idx_jobs_ping_token_hash
  ON jobs (ping_token_hash) WHERE ping_token_hash IS NOT NULL;
