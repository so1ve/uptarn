-- Track whether an agent explicitly manages monitor visibility (matching nodes.public_managed).
ALTER TABLE monitors ADD COLUMN public_managed INTEGER NOT NULL DEFAULT 0;
