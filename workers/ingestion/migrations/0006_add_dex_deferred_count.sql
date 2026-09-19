-- A rate-limited Dex lookup is deferred, not treated as a failed social scan.
ALTER TABLE scan_runs ADD COLUMN dex_deferred_count INTEGER NOT NULL DEFAULT 0;
