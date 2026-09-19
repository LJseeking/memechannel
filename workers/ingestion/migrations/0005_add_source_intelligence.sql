-- Public-source reputation ledger. Accuracy remains NULL until an outcome is
-- explicitly resolved; this prevents premature "expert" rankings.
CREATE TABLE IF NOT EXISTS source_profiles (
  author_handle TEXT PRIMARY KEY,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  total_signals INTEGER NOT NULL DEFAULT 0,
  discovery_signals INTEGER NOT NULL DEFAULT 0,
  prediction_signals INTEGER NOT NULL DEFAULT 0,
  resolved_outcomes INTEGER NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  risk_outcome_count INTEGER NOT NULL DEFAULT 0,
  accuracy REAL,
  average_lead_hours REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_signals (
  id TEXT PRIMARY KEY,
  author_handle TEXT NOT NULL,
  narrative_id TEXT NOT NULL,
  tweet_id TEXT NOT NULL UNIQUE,
  scan_id TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  is_first_observed INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL,
  outcome_status TEXT NOT NULL DEFAULT 'pending',
  outcome_recorded_at TEXT,
  outcome_note TEXT,
  FOREIGN KEY (author_handle) REFERENCES source_profiles(author_handle),
  FOREIGN KEY (narrative_id) REFERENCES narratives(id),
  FOREIGN KEY (tweet_id) REFERENCES raw_posts(tweet_id),
  FOREIGN KEY (scan_id) REFERENCES scan_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_source_signals_author
  ON source_signals(author_handle, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_source_signals_narrative
  ON source_signals(narrative_id, observed_at ASC);
