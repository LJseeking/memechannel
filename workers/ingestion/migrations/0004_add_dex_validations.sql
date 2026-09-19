-- DexScreener results are kept as evidence, not automatic contract verification.
CREATE TABLE IF NOT EXISTS dex_validations (
  id TEXT PRIMARY KEY,
  narrative_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  status TEXT NOT NULL,
  queried_at TEXT NOT NULL,
  chain_id TEXT,
  dex_id TEXT,
  pair_address TEXT,
  token_address TEXT,
  token_symbol TEXT,
  liquidity_usd REAL,
  volume_h24_usd REAL,
  market_cap_usd REAL,
  pair_created_at TEXT,
  source_url TEXT,
  raw_json TEXT,
  FOREIGN KEY (narrative_id) REFERENCES narratives(id),
  FOREIGN KEY (scan_id) REFERENCES scan_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_dex_validations_narrative
  ON dex_validations(narrative_id, queried_at DESC);

CREATE INDEX IF NOT EXISTS idx_dex_validations_scan
  ON dex_validations(scan_id);
