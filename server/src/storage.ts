import pg from 'pg';
import { runMigrations } from './migrations';

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
  oauth_app_key: string;
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

let pool: pg.Pool | null = null;
let initPromise: Promise<pg.Pool> | null = null;

const REQUIRED_TABLES = ['users', 'auth_sessions', 'saved_configs', 'render_jobs', 'schema_migrations'] as const;

type DatabaseReadiness = {
  ready: boolean;
  missingTables: string[];
};

interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

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
    oauth_app_key: String(row.oauth_app_key || 'fbif'),
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

  // 显式限制连接池，避免批量任务高并发 + 每请求清理时把数据库连接耗尽导致整体 5xx
  pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX) > 0 ? Number(process.env.PG_POOL_MAX) : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  initPromise = (async () => {
    const database = pool as pg.Pool;
    await database.query('SELECT 1');
    await runMigrations(database);
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

async function queryDatabaseReadiness(db: Queryable): Promise<DatabaseReadiness> {
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [[...REQUIRED_TABLES]],
  );
  const existing = new Set(rows.map((row) => row.table_name));
  const missingTables = REQUIRED_TABLES.filter((table) => !existing.has(table));
  return {
    ready: missingTables.length === 0,
    missingTables,
  };
}

async function checkDatabaseReady(): Promise<DatabaseReadiness> {
  const db = await initDatabase();
  return queryDatabaseReadiness(db);
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
  oauthAppKey?: string;
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
       (token, oauth_app_key, open_id, access_token, refresh_token, token_type, expires_at, refresh_expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8, '')::timestamptz, NOW())
     ON CONFLICT(token) DO UPDATE SET
       oauth_app_key      = EXCLUDED.oauth_app_key,
       access_token       = EXCLUDED.access_token,
       refresh_token      = EXCLUDED.refresh_token,
       token_type         = EXCLUDED.token_type,
       expires_at         = EXCLUDED.expires_at,
       refresh_expires_at = EXCLUDED.refresh_expires_at,
       updated_at         = NOW()
     RETURNING *`,
    [
      session.token,
      session.oauthAppKey ?? 'fbif',
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

async function listSavedConfigsByPrefix(configNamePrefix: string): Promise<SavedConfigRow[]> {
  const db = await initDatabase();
  const { rows } = await db.query(
    'SELECT * FROM saved_configs WHERE config_name LIKE $1 ORDER BY updated_at DESC, id DESC',
    [`${configNamePrefix}%`],
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

async function getLatestSavedConfigByName(configName: string): Promise<SavedConfigRow | undefined> {
  const db = await initDatabase();
  const { rows } = await db.query(
    'SELECT * FROM saved_configs WHERE config_name = $1 ORDER BY updated_at DESC, id DESC LIMIT 1',
    [configName],
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

// ---------------------------------------------------------------------------
// Render Jobs
// ---------------------------------------------------------------------------

interface RenderJobRow {
  jobId: string;
  ownerKey: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  status: string;
  templateJson: string;
  outputJson: string | null;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  recordsJson: string;
  resultsJson: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

function mapRenderJobRow(row: Record<string, unknown>): RenderJobRow {
  return {
    jobId: String(row.job_id),
    ownerKey: String(row.owner_key ?? 'legacy'),
    leaseOwner: row.lease_owner != null ? String(row.lease_owner) : null,
    leaseExpiresAt: row.lease_expires_at != null ? toIsoString(row.lease_expires_at) : null,
    status: String(row.status),
    templateJson: String(row.template_json),
    outputJson: row.output_json != null ? String(row.output_json) : null,
    total: Number(row.total),
    processed: Number(row.processed),
    succeeded: Number(row.succeeded),
    failed: Number(row.failed),
    recordsJson: String(row.records_json),
    resultsJson: String(row.results_json),
    error: row.error != null ? String(row.error) : null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    expiresAt: toIsoString(row.expires_at),
  };
}

async function insertRenderJob(job: {
  jobId: string;
  ownerKey: string;
  leaseOwner: string;
  leaseExpiresAt: string;
  status: string;
  templateJson: string;
  outputJson?: string;
  total: number;
  recordsJson: string;
  expiresAt: string;
}): Promise<RenderJobRow> {
  const db = await initDatabase();
  const { rows } = await db.query(
    `INSERT INTO render_jobs (job_id, owner_key, lease_owner, lease_expires_at, status, template_json, output_json, total, records_json, expires_at)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6, NULLIF($7, ''), $8, $9, $10::timestamptz)
     RETURNING *`,
    [job.jobId, job.ownerKey, job.leaseOwner, job.leaseExpiresAt, job.status, job.templateJson, job.outputJson ?? '', job.total, job.recordsJson, job.expiresAt],
  );
  return mapRenderJobRow(rows[0] as Record<string, unknown>);
}

async function getRenderJob(jobId: string, ownerKey: string): Promise<RenderJobRow | undefined> {
  const db = await initDatabase();
  const { rows } = await db.query('SELECT * FROM render_jobs WHERE job_id = $1 AND owner_key = $2', [jobId, ownerKey]);
  if (!rows[0]) return undefined;
  return mapRenderJobRow(rows[0] as Record<string, unknown>);
}

async function updateRenderJob(jobId: string, updates: {
  status?: string;
  processed?: number;
  succeeded?: number;
  failed?: number;
  resultsJson?: string;
  error?: string;
  expiresAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
}): Promise<RenderJobRow | undefined> {
  const db = await initDatabase();
  const setClauses: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [jobId];
  let paramIndex = 2;

  if (updates.status !== undefined) {
    setClauses.push(`status = $${paramIndex++}`);
    values.push(updates.status);
  }
  if (updates.processed !== undefined) {
    setClauses.push(`processed = $${paramIndex++}`);
    values.push(updates.processed);
  }
  if (updates.succeeded !== undefined) {
    setClauses.push(`succeeded = $${paramIndex++}`);
    values.push(updates.succeeded);
  }
  if (updates.failed !== undefined) {
    setClauses.push(`failed = $${paramIndex++}`);
    values.push(updates.failed);
  }
  if (updates.resultsJson !== undefined) {
    setClauses.push(`results_json = $${paramIndex++}`);
    values.push(updates.resultsJson);
  }
  if (updates.error !== undefined) {
    setClauses.push(`error = $${paramIndex++}`);
    values.push(updates.error);
  }
  if (updates.expiresAt !== undefined) {
    setClauses.push(`expires_at = $${paramIndex++}::timestamptz`);
    values.push(updates.expiresAt);
  }
  if (updates.leaseOwner !== undefined) {
    setClauses.push(`lease_owner = $${paramIndex++}`);
    values.push(updates.leaseOwner);
  }
  if (updates.leaseExpiresAt !== undefined) {
    setClauses.push(`lease_expires_at = $${paramIndex++}::timestamptz`);
    values.push(updates.leaseExpiresAt);
  }

  const { rows } = await db.query(
    `UPDATE render_jobs SET ${setClauses.join(', ')} WHERE job_id = $1 RETURNING *`,
    values,
  );
  if (!rows[0]) return undefined;
  return mapRenderJobRow(rows[0] as Record<string, unknown>);
}

async function cleanupExpiredRenderJobs(): Promise<number> {
  const db = await initDatabase();
  const result = await db.query(
    "DELETE FROM render_jobs WHERE expires_at < NOW() AND status IN ('completed', 'failed', 'partial_failed')",
  );
  return result.rowCount ?? 0;
}

async function markStaleRenderJobsAsFailed(): Promise<number> {
  const db = await initDatabase();
  const result = await db.query(
    "UPDATE render_jobs SET status = 'failed', error = '服务重启，任务中断', updated_at = NOW() WHERE status IN ('pending', 'running') AND lease_expires_at <= NOW()",
  );
  return result.rowCount ?? 0;
}

export {
  initDatabase,
  checkDatabaseReady,
  upsertUser,
  getUserByOpenId,
  upsertSession,
  getSessionByToken,
  updateSessionTokens,
  deleteSessionByToken,
  listSavedConfigs,
  listSavedConfigsByPrefix,
  getSavedConfig,
  getSavedConfigByName,
  getLatestSavedConfigByName,
  saveOrUpdateConfig,
  deleteSavedConfig,
  insertRenderJob,
  getRenderJob,
  updateRenderJob,
  cleanupExpiredRenderJobs,
  markStaleRenderJobsAsFailed,
};

export type { UserRow, AuthSessionRow, SavedConfigRow };

export const __test__ = {
  REQUIRED_TABLES,
  queryDatabaseReadiness,
};
