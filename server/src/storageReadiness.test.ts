import assert from 'node:assert/strict';
import test from 'node:test';

import { __test__ } from './storage';

function fakeDatabase(existingTables: string[]) {
  return {
    async query() {
      return {
        rows: existingTables.map((tableName) => ({ table_name: tableName })),
      };
    },
  } as any;
}

test('database readiness reports missing auth tables', async () => {
  const readiness = await __test__.queryDatabaseReadiness(fakeDatabase(['users']));

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missingTables, ['auth_sessions', 'saved_configs', 'render_jobs', 'schema_migrations']);
});

test('database readiness passes when all required tables exist', async () => {
  const readiness = await __test__.queryDatabaseReadiness(fakeDatabase([...__test__.REQUIRED_TABLES, 'extra_table']));

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.missingTables, []);
});
