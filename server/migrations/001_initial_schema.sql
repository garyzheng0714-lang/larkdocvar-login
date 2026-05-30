CREATE TABLE IF NOT EXISTS users (
  open_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  en_name     TEXT,
  email       TEXT,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token               TEXT PRIMARY KEY,
  oauth_app_key       TEXT NOT NULL DEFAULT 'fbif',
  open_id             TEXT NOT NULL REFERENCES users(open_id) ON DELETE CASCADE,
  access_token        TEXT NOT NULL,
  refresh_token       TEXT NOT NULL DEFAULT '',
  token_type          TEXT NOT NULL DEFAULT 'Bearer',
  expires_at          TIMESTAMPTZ NOT NULL,
  refresh_expires_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS oauth_app_key TEXT NOT NULL DEFAULT 'fbif';

CREATE INDEX IF NOT EXISTS idx_auth_sessions_open_id ON auth_sessions(open_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS saved_configs (
  id            BIGSERIAL PRIMARY KEY,
  open_id       TEXT NOT NULL REFERENCES users(open_id) ON DELETE CASCADE,
  config_name   TEXT NOT NULL,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(open_id, config_name)
);

CREATE INDEX IF NOT EXISTS idx_saved_configs_open_id ON saved_configs(open_id);
CREATE INDEX IF NOT EXISTS idx_saved_configs_updated_at ON saved_configs(updated_at DESC);
