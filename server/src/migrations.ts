import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type MigrationFile = {
  version: string;
  name: string;
  filePath: string;
};

const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

function migrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
}

function parseMigrationFile(fileName: string): MigrationFile | null {
  if (!/^\d+_[A-Za-z0-9_-]+\.sql$/.test(fileName)) return null;
  const version = fileName.split('_')[0];
  return {
    version,
    name: fileName.replace(/\.sql$/, ''),
    filePath: path.join(migrationsDir(), fileName),
  };
}

async function listMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => parseMigrationFile(entry.name))
    .filter((entry): entry is MigrationFile => Boolean(entry))
    // 按版本号数值排序，而非字典序：字典序会把 10_xxx 排到 2_xxx 前面，未来迁移到两位数时乱序执行。
    .sort((a, b) => Number(a.version) - Number(b.version));
}

// 迁移流程的 advisory lock key（任意固定常量，仅此处使用）。
const MIGRATION_ADVISORY_LOCK_KEY = 49770614;

export async function runMigrations(pool: pg.Pool): Promise<void> {
  // 跨实例互斥：多实例同时冷启动 / 同时应用新迁移时，并发 DDL（含 CREATE TABLE IF NOT EXISTS）会触发
  // PostgreSQL 已知的 pg_type 唯一约束竞态抛错，使 bootstrap 崩溃进入重启循环。用会话级 advisory lock
  // 串行化整个迁移：先抢到锁的实例执行，其余实例阻塞等待；拿到锁时迁移已应用、直接跳过。进程崩溃时
  // 连接断开，PostgreSQL 自动释放该锁，不会留下死锁。
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    await client.query(MIGRATION_TABLE_SQL);
    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.version));
    const migrations = await listMigrationFiles();

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      const sql = await readFile(migration.filePath, 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT(version) DO NOTHING',
          [migration.version, migration.name],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
