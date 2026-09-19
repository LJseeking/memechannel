-- One evidence row represents one unique social post supporting a narrative.
-- A post may only support one ticker narrative, which prevents repeated search
-- results from falsely inflating cross-scan evidence.
CREATE TABLE IF NOT EXISTS narrative_evidence (
  narrative_id TEXT NOT NULL,
  tweet_id TEXT NOT NULL UNIQUE,
  scan_id TEXT NOT NULL,
  author_handle TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (narrative_id, tweet_id),
  FOREIGN KEY (narrative_id) REFERENCES narratives(id),
  FOREIGN KEY (tweet_id) REFERENCES raw_posts(tweet_id),
  FOREIGN KEY (scan_id) REFERENCES scan_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_narrative_evidence_narrative
  ON narrative_evidence(narrative_id);

CREATE INDEX IF NOT EXISTS idx_narrative_evidence_scan
  ON narrative_evidence(scan_id);
