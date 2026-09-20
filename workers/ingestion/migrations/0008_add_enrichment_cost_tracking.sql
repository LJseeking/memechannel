-- Keep the targeted attribution-search budget visible and auditable per scan.
ALTER TABLE scan_runs ADD COLUMN enrichment_query_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN enrichment_post_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN enrichment_estimated_cost_usd REAL NOT NULL DEFAULT 0;
