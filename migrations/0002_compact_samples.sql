-- Embed rolling 48 monitor samples directly in monitors.samples_json
-- to eliminate per-minute monitor_samples inserts and hourly prune deletes.
ALTER TABLE monitors ADD COLUMN samples_json TEXT NOT NULL DEFAULT '[]';

UPDATE monitors
SET samples_json = COALESCE(
  (
    SELECT json_group_array(json_array(s.ts, s.ok, s.latency_ms))
    FROM monitor_samples s
    WHERE s.monitor_id = monitors.id
      AND s.ts >= COALESCE(
        (
          SELECT s2.ts
          FROM monitor_samples s2
          WHERE s2.monitor_id = monitors.id
          ORDER BY s2.ts DESC
          LIMIT 1 OFFSET 47
        ),
        0
      )
  ),
  '[]'
);

DROP TABLE IF EXISTS monitor_samples;

-- Store all numeric series for one node at one timestamp in a single row
-- instead of one row per metric key, reducing D1 rows_written by ~80%.
CREATE TABLE IF NOT EXISTS node_samples (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  values_json TEXT NOT NULL,
  PRIMARY KEY (node_id, ts)
) WITHOUT ROWID;

INSERT OR REPLACE INTO node_samples (node_id, ts, values_json)
SELECT
  node_id,
  ts,
  json_group_object(
    series_key,
    CASE
      WHEN aux_value IS NOT NULL THEN json_array(value, aux_value)
      ELSE value
    END
  )
FROM series_samples
GROUP BY node_id, ts;

DROP TABLE IF EXISTS series_samples;
