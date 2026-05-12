import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadProjectEnv, PROJECT_ENV_PATHS } from './env';

test('项目环境变量加载 .env.local 后再加载 .env，且不覆盖现有环境变量', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'larkdocvar-env-'));
  const env = {
    EXISTING_VALUE: 'from-process',
  } as NodeJS.ProcessEnv;
  const localPath = join(dir, '.env.local');
  const basePath = join(dir, '.env');
  await writeFile(localPath, 'SHARED_VALUE=from-local\nLOCAL_ONLY=local\nEXISTING_VALUE=from-local\n');
  await writeFile(basePath, 'SHARED_VALUE=from-env\nBASE_ONLY=base\nEXISTING_VALUE=from-env\n');

  loadProjectEnv({ paths: [localPath, basePath], processEnv: env });

  assert.deepEqual(PROJECT_ENV_PATHS, ['.env.local', '.env']);
  assert.equal(env.SHARED_VALUE, 'from-local');
  assert.equal(env.LOCAL_ONLY, 'local');
  assert.equal(env.BASE_ONLY, 'base');
  assert.equal(env.EXISTING_VALUE, 'from-process');
});
