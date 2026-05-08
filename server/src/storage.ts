import pg from 'pg';

interface UserRow {
  open_id: string;
  name: string;
  en_name: string | null;
  email: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

interface AuthSessionRow {
  token: string;
  open_id: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: string;
  refresh_expires_at: string;
  created_at: string;
  updated_at: string;
}

interface SavedConfigRow {
  id: string;
  open_id: string;
  config_name: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

const SCHEMA_SQL = `
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
  open_id             TEXT NOT NULL REFERENCES users(open_id) ON DELETE CASCADE,
  access_token        TEXT NOT NULL,
  refresh_token       TEXT NOT NULL DEFAULT '',
  token_type          TEXT NOT NULL DEFAULT 'Bearer',
  expires_at          TIMESTAMPTZ NOT NULL,
  refresh_expires_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
`;

let pool: pg.Pool | null = null;
let initPromise: Promise<pg.Pool> | null = null;

function toIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (typeof value === 'number') {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function mapUserRow(row: Record<string, unknown>): UserRow {
  return {
    open_id: String(row.open_id || ''),
    name: String(row.name || ''),
    en_name: row.en_name === null || row.en_name === undefined ? null : String(row.en_name),
    email: row.email === null || row.email === undefined ? null : String(row.email),
    avatar_url: row.avatar_url === null || row.avatar_url === undefined ? null : String(row.avatar_url),
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
  };
}

function mapSessionRow(row: Record<string, unknown>): AuthSessionRow {
  return {
    token: String(row.token || ''),
    open_id: String(row.open_id || ''),
    access_token: String(row.access_token || ''),
    refresh_token: String(row.refresh_token || ''),
    token_type: String(row.token_type || 'Bearer'),
    expires_at: toIsoString(row.expires_at),
    refresh_expires_at: row.refresh_expires_at ? toIsoString(row.refresh_expires_at) : '',
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
  };
}

function mapConfigRow(row: Record<string, unknown>): SavedConfigRow {
  return {
    id: String(row.id || ''),
    open_id: String(row.open_id || ''),
    config_name: String(row.config_name || ''),
    payload_json: String(row.payload_json || '{}'),
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
  };
}

async function initDatabase(): Promise<pg.Pool> {
  if (initPromise) {
    return initPromise;
  }

  const connectionString = (process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL 未配置，无法连接 PostgreSQL。');
  }

  pool = new pg.Pool({ connectionString });

  initPromise = (async () => {
    const database = pool as pg.Pool;
    await database.query('SELECT 1');
    await database.query(SCHEMA_SQL);
    return database;
  })().catch(async (error) => {
    initPromise = null;
    if (pool) {
      await pool.end().catch(() => undefined);
      pool = null;
    }
    throw error;
  });

  return initPromise;
}

async function upsertUser(user: {
  openId: string;
  name: string;
  enName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}): Promise<UserRow> {
  const db = await initDatabase();
  const { rows } = await db.query(
    `INSERT INTO users (open_id, name, en_name, email, avatar_url, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT(open_id) DO UPDATE SET
       name       = EXCLUDED.name,
       en_name    = EXCLUDED.en_name,
       email      = EXCLUDED.email,
       avatar_url = EXCLUDED.avatar_url,
       updated_at = NOW()
     RETURNING *`,
    [user.openId, user.name, user.enName ?? null, user.email ?? null, user.avatarUrl ?? null],
  );
  return mapUserRow(rows[0] as Record<string, unknown>);
}

async function getUserByOpenId(openId: string): Promise<UserRow | undefined> {
  const db = await initDatabase();
  const { rows } = await db.query('SELECT * FROM users WHERE open_id = $1', [openId]);
  if (!rows[0]) {
    return undefined;
  }
  return mapUserRow(rows[0] as Record<string, unknown>);
}

async function upsertSession(session: {
  token: string;
  openId: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt: string;
  refreshExpiresAt?: string;
}): Promise<AuthSessionRow> {
  const db = await initDatabase();
  const { rows } = await db.query(
    `INSERT INTO auth_sessions
       (token, open_id, access_token, refresh_token, token_type, expires_at, refresh_expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, '')::timestamptz, NOW())
     ON CONFLICT(token) DO UPDATE SET
       access_token       = EXCLUDED.access_token,
       refresh_token      = EXCLUDED.refresh_token,
       token_type         = EXCLUDED.token_type,
       expires_at         = EXCLUDED.expires_at,
       refresh_expires_at = EXCLUDED.refresh_expires_at,
       updated_at         = NOW()
     RETURNING *`,
    [
      session.token,
      session.openId,
      session.accessToken,
      session.refreshToken ?? '',
      session.tokenType ?? 'Bearer',
      session.expiresAt,
      session.refreshExpiresAt ?? '',
    ],
  );
  return mapSessionRow(rows[0] as Record<string, unknown>);
}

async function getSessionByToken(token: string): Promise<AuthSessionRow | undefined> {
  const db = await initDatabase();
  const { rows } = await db.query('SELECT * FROM auth_sessions WHERE token = $1', [token]);
  if (!rows[0]) {
    return undefined;
  }
  return mapSessionRow(rows[0] as Record<string, unknown>);
}

async function updateSessionTokens(session: {
  token: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  refreshExpiresAt: string;
}): Promise<AuthSessionRow | undefined> {
  const db = await initDatabase();
  const { rows } = await db.query(
    `UPDATE auth_sessions
     SET access_token = $2,
         refresh_token = $3,
         expires_at = $4,
         refresh_expires_at = NULLIF($5, '')::timestamptz,
         updated_at = NOW()
     WHERE token = $1
     RETURNING *`,
    [session.token, session.accessToken, session.refreshToken, session.expiresAt, session.refreshExpiresAt],
  );

  if (!rows[0]) {
    return undefined;
  }
  return mapSessionRow(rows[0] as Record<string, unknown>);
}

async function deleteSessionByToken(token: string): Promise<boolean> {
  const db = await initDatabase();
  const result = await db.query('DELETE FROM auth_sessions WHERE token = $1', [token]);
  return (result.rowCount ?? 0) > 0;
}

async function listSavedConfigs(openId: string): Promise<SavedConfigRow[]> {
  const db = await initDatabase();
  const { rows } = await db.query(
    'SELECT * FROM saved_configs WHERE open_id = $1 ORDER BY updated_at DESC, id DESC',
    [openId],
  );
  return rows.map((row) => mapConfigRow(row as Record<string, unknown>));
}

async function getSavedConfig(openId: string, configId: string): Promise<SavedConfigRow | undefined> {
  const db = await initDatabase();
  const { rows } = await db.query(
    'SELECT * FROM saved_configs WHERE id = $1::bigint AND open_id = $2',
    [configId, openId],
  );
  if (!rows[0]) {
    return undefined;
  }
  return mapConfigRow(rows[0] as Record<string, unknown>);
}

async function getSavedConfigByName(openId: string, configName: string): Promise<SavedConfigRow | undefined> {
  const db = await initDatabase();
  const { rows } = await db.query(
    'SELECT * FROM saved_configs WHERE open_id = $1 AND config_name = $2',
    [openId, configName],
  );
  if (!rows[0]) {
    return undefined;
  }
  return mapConfigRow(rows[0] as Record<string, unknown>);
}

async function saveOrUpdateConfig(config: {
  openId: string;
  configName: string;
  payloadJson: string;
}): Promise<SavedConfigRow> {
  const db = await initDatabase();
  const { rows } = await db.query(
    `INSERT INTO saved_configs (open_id, config_name, payload_json, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT(open_id, config_name) DO UPDATE SET
       payload_json = EXCLUDED.payload_json,
       updated_at = NOW()
     RETURNING *`,
    [config.openId, config.configName, config.payloadJson],
  );
  return mapConfigRow(rows[0] as Record<string, unknown>);
}

async function deleteSavedConfig(openId: string, configId: string): Promise<boolean> {
  const db = await initDatabase();
  const result = await db.query(
    'DELETE FROM saved_configs WHERE id = $1::bigint AND open_id = $2',
    [configId, openId],
  );
  return (result.rowCount ?? 0) > 0;
}

export {
  initDatabase,
  upsertUser,
  getUserByOpenId,
  upsertSession,
  getSessionByToken,
  updateSessionTokens,
  deleteSessionByToken,
  listSavedConfigs,
  getSavedConfig,
  getSavedConfigByName,
  saveOrUpdateConfig,
  deleteSavedConfig,
};

export type { UserRow, AuthSessionRow, SavedConfigRow };
