CREATE TABLE IF NOT EXISTS incident_reports (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'investigating',
  impact TEXT NOT NULL DEFAULT 'minor',
  is_public INTEGER NOT NULL DEFAULT 1,
  targets_json TEXT NOT NULL DEFAULT '[]',
  updates_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_incident_reports_updated
  ON incident_reports (resolved_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS incident_notes (
  id TEXT PRIMARY KEY,
  incident_key TEXT NOT NULL,
  status TEXT,
  message TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incident_notes_key_time
  ON incident_notes (incident_key, created_at DESC);
