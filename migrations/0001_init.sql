CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS admin_passkeys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]',
  device_type TEXT NOT NULL DEFAULT 'singleDevice',
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires_at
  ON webauthn_challenges (expires_at);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  interval_secs INTEGER NOT NULL DEFAULT 60,
  grace_secs INTEGER NOT NULL DEFAULT 120,
  muted_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  prev_rx_bytes INTEGER,
  prev_tx_bytes INTEGER,
  prev_net_at INTEGER,
  rx_bps REAL,
  tx_bps REAL,
  system_json TEXT,
  mounts_json TEXT NOT NULL DEFAULT '[]',
  checks_json TEXT NOT NULL DEFAULT '[]',
  series_json TEXT NOT NULL DEFAULT '[]',
  info_json TEXT NOT NULL DEFAULT '[]',
  agent_version TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_token_hash
  ON nodes (token_hash);

CREATE INDEX IF NOT EXISTS idx_nodes_public_label
  ON nodes (label ASC) WHERE is_public = 1;

CREATE TABLE IF NOT EXISTS series_samples (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  series_key TEXT NOT NULL,
  ts INTEGER NOT NULL,
  value REAL NOT NULL,
  aux_value REAL,
  PRIMARY KEY (node_id, series_key, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  expected_status_min INTEGER NOT NULL DEFAULT 200,
  expected_status_max INTEGER NOT NULL DEFAULT 299,
  expected_body TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 8000,
  interval_secs INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_public INTEGER NOT NULL DEFAULT 1,
  muted_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  last_status TEXT,
  last_http_status INTEGER,
  last_latency_ms REAL,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_monitors_name
  ON monitors (name ASC);

CREATE INDEX IF NOT EXISTS idx_monitors_public_name
  ON monitors (name ASC) WHERE is_public = 1;

CREATE TABLE IF NOT EXISTS monitor_samples (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  latency_ms REAL,
  http_status INTEGER,
  PRIMARY KEY (monitor_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS jobs (
  key TEXT PRIMARY KEY,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  interval_secs INTEGER NOT NULL,
  grace_secs INTEGER NOT NULL DEFAULT 3600,
  muted_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_run_at INTEGER NOT NULL,
  last_status TEXT NOT NULL,
  last_duration_ms INTEGER,
  last_summary TEXT,
  last_detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_node_id
  ON jobs (node_id) WHERE node_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS alert_states (
  incident_key TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER,
  notified_open INTEGER NOT NULL DEFAULT 0,
  last_changed_at INTEGER NOT NULL,
  last_summary TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_alert_states_target
  ON alert_states (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_alert_states_state
  ON alert_states (state DESC, last_changed_at DESC);

CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_key TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivery_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_alert_events_created_at
  ON alert_events (created_at DESC);
