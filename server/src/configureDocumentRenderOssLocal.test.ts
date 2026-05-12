import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildDocumentRenderOssEnvValues,
  parseDocumentRenderOssLocalConfig,
  upsertEnvContent,
} from './scripts/configureDocumentRenderOssLocal';

test('OSS 本地配置脚本解析 dotenv 输入并输出标准环境变量', () => {
  const config = parseDocumentRenderOssLocalConfig(`
DOCUMENT_RENDER_OSS_ACCESS_KEY_ID=ak-id
DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET="secret#with-hash"
DOCUMENT_RENDER_OSS_BUCKET=example-bucket
DOCUMENT_RENDER_OSS_REGION=cn-beijing
`, {});

  assert.deepEqual(buildDocumentRenderOssEnvValues(config), {
    DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: 'ak-id',
    DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: 'secret#with-hash',
    DOCUMENT_RENDER_OSS_BUCKET: 'example-bucket',
    DOCUMENT_RENDER_OSS_REGION: 'cn-beijing',
    DOCUMENT_RENDER_OSS_PREFIX: 'document-renders',
    DOCUMENT_RENDER_DOWNLOAD_TTL_SECONDS: '3600',
  });
});

test('OSS 本地配置脚本更新已有 .env.local 且不保留重复键', () => {
  const output = upsertEnvContent(`FOO=bar
DOCUMENT_RENDER_OSS_BUCKET=old-bucket
DOCUMENT_RENDER_OSS_BUCKET=duplicate-bucket
`, {
    DOCUMENT_RENDER_OSS_BUCKET: 'new-bucket',
    DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: 'secret#value',
  });

  assert.match(output, /FOO=bar/);
  assert.match(output, /DOCUMENT_RENDER_OSS_BUCKET="new-bucket"/);
  assert.match(output, /DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET="secret#value"/);
  assert.equal((output.match(/DOCUMENT_RENDER_OSS_BUCKET/g) || []).length, 1);
});

test('OSS 本地配置脚本写入私有 .env.local 且输出不包含密钥值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-render-oss-local-'));
  try {
    const envPath = join(dir, '.env.local');
    const secret = 'secret-value-not-in-stdout';
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'server/src/scripts/configureDocumentRenderOssLocal.ts',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: JSON.stringify({
        accessKeyId: 'ak-id',
        accessKeySecret: secret,
        bucket: 'example-bucket',
        region: 'cn-beijing',
      }),
      env: {
        ...process.env,
        DOCUMENT_RENDER_LOCAL_ENV_PATH: envPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /secret-value-not-in-stdout/);
    const file = readFileSync(envPath, 'utf8');
    assert.match(file, /DOCUMENT_RENDER_OSS_ACCESS_KEY_ID="ak-id"/);
    assert.match(file, /DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET="secret-value-not-in-stdout"/);
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OSS 本地配置脚本优先使用标准输入而不是已有环境变量', () => {
  const config = parseDocumentRenderOssLocalConfig(JSON.stringify({
    accessKeyId: 'stdin-ak',
    accessKeySecret: 'stdin-secret',
    bucket: 'stdin-bucket',
    region: 'cn-shanghai',
  }), {
    DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: 'env-ak',
    DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: 'env-secret',
    DOCUMENT_RENDER_OSS_BUCKET: 'env-bucket',
    DOCUMENT_RENDER_OSS_REGION: 'cn-beijing',
  });

  assert.deepEqual(buildDocumentRenderOssEnvValues(config), {
    DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: 'stdin-ak',
    DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: 'stdin-secret',
    DOCUMENT_RENDER_OSS_BUCKET: 'stdin-bucket',
    DOCUMENT_RENDER_OSS_REGION: 'cn-shanghai',
    DOCUMENT_RENDER_OSS_PREFIX: 'document-renders',
    DOCUMENT_RENDER_DOWNLOAD_TTL_SECONDS: '3600',
  });
});
