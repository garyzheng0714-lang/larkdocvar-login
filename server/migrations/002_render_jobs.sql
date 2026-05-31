CREATE TABLE IF NOT EXISTS render_jobs (
  job_id        TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'pending',
  template_json TEXT NOT NULL,
  output_json   TEXT,
  total         INTEGER NOT NULL DEFAULT 0,
  processed     INTEGER NOT NULL DEFAULT 0,
  succeeded     INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  records_json  TEXT NOT NULL DEFAULT '[]',
  results_json  TEXT NOT NULL DEFAULT '[]',
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status);
CREATE INDEX IF NOT EXISTS idx_render_jobs_expires_at ON render_jobs(expires_at);
CREATE INDEX IF NOT EXISTS idx_render_jobs_created_at ON render_jobs(created_at DESC);
