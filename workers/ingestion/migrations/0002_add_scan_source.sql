-- Keep the database schema aligned with the versioned ingestion Worker.
-- Existing historical runs remain labeled as legacy; new runs store manual or cron.
ALTER TABLE scan_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy';
