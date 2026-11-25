-- Store monitor probe config in probe_json + probe_from so non-HTTP agent monitors
-- do not carry dummy HTTP columns.
CREATE TABLE monitors_v2 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  probe_from TEXT NOT NULL,
  probe_json TEXT NOT NULL,
  public_url TEXT,
  interval_secs INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_public INTEGER NOT NULL DEFAULT 1,
  managed_by_node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  last_status TEXT,
  last_http_status INTEGER,
  last_latency_ms REAL,
  last_error TEXT,
  samples_json TEXT NOT NULL DEFAULT '[]',
  rollup_json TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO monitors_v2 (
  id, name, probe_from, probe_json, public_url, interval_secs,
  enabled, is_public, managed_by_node_id, sort_order, muted_until, created_at,
  last_checked_at, last_status, last_http_status, last_latency_ms, last_error,
  samples_json, rollup_json
)
SELECT
  id,
  name,
  'hub',
  json_object(
    'from', 'hub',
    'type', 'http',
    'url', url,
    'method', method,
    'expected_status_min', expected_status_min,
    'expected_status_max', expected_status_max,
    'expected_body', expected_body,
    'timeout_ms', timeout_ms
  ),
  public_url,
  interval_secs,
  enabled,
  is_public,
  managed_by_node_id,
  sort_order,
  muted_until,
  created_at,
  last_checked_at,
  last_status,
  last_http_status,
  last_latency_ms,
  last_error,
  samples_json,
  rollup_json
FROM monitors;

DROP TABLE monitors;
ALTER TABLE monitors_v2 RENAME TO monitors;

CREATE INDEX idx_monitors_name ON monitors (name ASC);
CREATE INDEX idx_monitors_public_name ON monitors (name ASC) WHERE is_public = 1;
CREATE INDEX idx_monitors_managed_by_node ON monitors (managed_by_node_id);
