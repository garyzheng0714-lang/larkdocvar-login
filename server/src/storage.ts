import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  id: number;
  open_id: string;
  config_name: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  open_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  en_name     TEXT,
  email       TEXT,
  avatar_url  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token               TEXT PRIMARY KEY,
  open_id             TEXT NOT NULL,
  access_token        TEXT NOT NULL,
  refresh_token       TEXT NOT NULL DEFAULT '',
  token_type          TEXT NOT NULL DEFAULT 'Bearer',
  expires_at          TEXT NOT NULL,
  refresh_expires_at  TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (open_id) REFERENCES users(open_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_open_id ON auth_sessions(open_id);

CREATE TABLE IF NOT EXISTS saved_configs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id       TEXT NOT NULL,
  config_name   TEXT NOT NULL,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (open_id) REFERENCES users(open_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_configs_open_id ON saved_configs(open_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_configs_user_name ON saved_configs(open_id, config_name);
`;

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;

function getDefaultDbPath(): string {
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(serverDir, '../../data/app.db');
}

/**
 * Initialise (or return existing) SQLite database.
 * Safe to call multiple times – only the first call creates the file and runs
 * schema migrations.
 */
function initDatabase(dbPath?: string): Database.Database {
  if (db) {
    return db;
  }

  const resolvedPath = dbPath ?? getDefaultDbPath();
  mkdirSync(path.dirname(resolvedPath), { recursive: true });

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  return db;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function upsertUser(user: {
  openId: string;
  name: string;
  enName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}): UserRow {
  const database = initDatabase();
  const stmt = database.prepare(`
    INSERT INTO users (open_id, name, en_name, email, avatar_url, updated_at)
    VALUES (@open_id, @name, @en_name, @email, @avatar_url, datetime('now'))
    ON CONFLICT(open_id) DO UPDATE SET
      name       = excluded.name,
      en_name    = excluded.en_name,
      email      = excluded.email,
      avatar_url = excluded.avatar_url,
      updated_at = datetime('now')
    RETURNING *
  `);
  return stmt.get({
    open_id: user.openId,
    name: user.name,
    en_name: user.enName ?? null,
    email: user.email ?? null,
    avatar_url: user.avatarUrl ?? null,
  }) as UserRow;
}

function getUserByOpenId(openId: string): UserRow | undefined {
  const database = initDatabase();
  const stmt = database.prepare('SELECT * FROM users WHERE open_id = ?');
  return stmt.get(openId) as UserRow | undefined;
}

// ---------------------------------------------------------------------------
// Auth sessions
// ---------------------------------------------------------------------------

function upsertSession(session: {
  token: string;
  openId: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt: string;
  refreshExpiresAt?: string;
}): AuthSessionRow {
  const database = initDatabase();
  const stmt = database.prepare(`
    INSERT INTO auth_sessions (token, open_id, access_token, refresh_token, token_type, expires_at, refresh_expires_at, updated_at)
    VALUES (@token, @open_id, @access_token, @refresh_token, @token_type, @expires_at, @refresh_expires_at, datetime('now'))
    ON CONFLICT(token) DO UPDATE SET
      access_token       = excluded.access_token,
      refresh_token      = excluded.refresh_token,
      token_type         = excluded.token_type,
      expires_at         = excluded.expires_at,
      refresh_expires_at = excluded.refresh_expires_at,
      updated_at         = datetime('now')
    RETURNING *
  `);
  return stmt.get({
    token: session.token,
    open_id: session.openId,
    access_token: session.accessToken,
    refresh_token: session.refreshToken ?? '',
    token_type: session.tokenType ?? 'Bearer',
    expires_at: session.expiresAt,
    refresh_expires_at: session.refreshExpiresAt ?? '',
  }) as AuthSessionRow;
}

function getSessionByToken(token: string): AuthSessionRow | undefined {
  const database = initDatabase();
  const stmt = database.prepare('SELECT * FROM auth_sessions WHERE token = ?');
  return stmt.get(token) as AuthSessionRow | undefined;
}

function updateSessionTokens(session: {
  token: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  refreshExpiresAt: string;
}): void {
  const database = initDatabase();
  const stmt = database.prepare(`
    UPDATE auth_sessions
    SET access_token = @access_token,
        refresh_token = @refresh_token,
        expires_at = @expires_at,
        refresh_expires_at = @refresh_expires_at,
        updated_at = datetime('now')
    WHERE token = @token
  `);
  stmt.run({
    token: session.token,
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expires_at: session.expiresAt,
    refresh_expires_at: session.refreshExpiresAt,
  });
}

// ---------------------------------------------------------------------------
// Saved configs
// ---------------------------------------------------------------------------

function listSavedConfigs(openId: string): SavedConfigRow[] {
  const database = initDatabase();
  const stmt = database.prepare(
    'SELECT * FROM saved_configs WHERE open_id = ? ORDER BY updated_at DESC'
  );
  return stmt.all(openId) as SavedConfigRow[];
}

function getSavedConfig(openId: string, configId: number): SavedConfigRow | undefined {
  const database = initDatabase();
  const stmt = database.prepare(
    'SELECT * FROM saved_configs WHERE id = ? AND open_id = ?'
  );
  return stmt.get(configId, openId) as SavedConfigRow | undefined;
}

function saveOrUpdateConfig(config: {
  openId: string;
  configName: string;
  payloadJson: string;
}): SavedConfigRow {
  const database = initDatabase();
  const stmt = database.prepare(`
    INSERT INTO saved_configs (open_id, config_name, payload_json, updated_at)
    VALUES (@open_id, @config_name, @payload_json, datetime('now'))
    ON CONFLICT(open_id, config_name) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at   = datetime('now')
    RETURNING *
  `);
  return stmt.get({
    open_id: config.openId,
    config_name: config.configName,
    payload_json: config.payloadJson,
  }) as SavedConfigRow;
}

function deleteSavedConfig(openId: string, configId: number): boolean {
  const database = initDatabase();
  const stmt = database.prepare(
    'DELETE FROM saved_configs WHERE id = ? AND open_id = ?'
  );
  const result = stmt.run(configId, openId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  initDatabase,
  upsertUser,
  getUserByOpenId,
  upsertSession,
  getSessionByToken,
  updateSessionTokens,
  listSavedConfigs,
  getSavedConfig,
  saveOrUpdateConfig,
  deleteSavedConfig,
};

export type { UserRow, AuthSessionRow, SavedConfigRow };
