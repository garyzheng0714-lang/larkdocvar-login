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
    .sort((a, b) => a.version.localeCompare(b.version));
}

export async function runMigrations(pool: pg.Pool): Promise<void> {
  await pool.query(MIGRATION_TABLE_SQL);
  const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.version));
  const migrations = await listMigrationFiles();

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const sql = await readFile(migration.filePath, 'utf8');
    const client = await pool.connect();
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
    } finally {
      client.release();
    }
  }
}
