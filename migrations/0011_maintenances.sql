CREATE TABLE IF NOT EXISTS maintenances (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  targets_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_maintenances_window
  ON maintenances (ends_at, starts_at);
