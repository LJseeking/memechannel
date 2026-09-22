-- Outcome snapshots are evidence, not investment recommendations. One 24-hour
-- and one 7-day observation are scheduled for every attributed contract.
CREATE TABLE IF NOT EXISTS outcome_snapshots (
  id TEXT PRIMARY KEY,
  narrative_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  token_address TEXT,
  horizon_hours INTEGER NOT NULL,
  baseline_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  baseline_price_usd REAL NOT NULL,
  baseline_liquidity_usd REAL,
  baseline_market_cap_usd REAL,
  observed_at TEXT,
  observed_price_usd REAL,
  observed_liquidity_usd REAL,
  observed_market_cap_usd REAL,
  price_change_pct REAL,
  liquidity_change_pct REAL,
  outcome_status TEXT NOT NULL DEFAULT 'pending',
  outcome_note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (narrative_id) REFERENCES narratives(id),
  UNIQUE(narrative_id, horizon_hours)
);

CREATE INDEX IF NOT EXISTS idx_outcome_snapshots_due
  ON outcome_snapshots(outcome_status, due_at);
