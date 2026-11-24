-- Explicit display ordering for nodes and monitors (shared by admin and public views).
ALTER TABLE nodes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitors ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
