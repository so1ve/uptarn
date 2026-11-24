-- Track agent-managed node visibility, node-declared HTTP monitors, and optional public monitor links.
ALTER TABLE nodes ADD COLUMN public_managed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitors ADD COLUMN managed_by_node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE;
ALTER TABLE monitors ADD COLUMN public_url TEXT;
CREATE INDEX IF NOT EXISTS idx_monitors_managed_by_node ON monitors(managed_by_node_id);
