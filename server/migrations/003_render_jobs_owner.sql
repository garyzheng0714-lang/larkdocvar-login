ALTER TABLE render_jobs
  ADD COLUMN IF NOT EXISTS owner_key TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE render_jobs
  ADD COLUMN IF NOT EXISTS lease_owner TEXT;

ALTER TABLE render_jobs
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes');

CREATE INDEX IF NOT EXISTS idx_render_jobs_owner_job ON render_jobs(owner_key, job_id);
CREATE INDEX IF NOT EXISTS idx_render_jobs_lease ON render_jobs(status, lease_expires_at);
