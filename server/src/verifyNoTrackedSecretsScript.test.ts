import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectSecretCandidates,
  findTrackedSecretMatches,
  parseSecretEnvValues,
} from './scripts/verifyNoTrackedSecrets';

test('受跟踪密钥检查会解析对象存储敏感配置且忽略普通配置', () => {
  const candidates = parseSecretEnvValues(`
DOCUMENT_RENDER_OSS_ACCESS_KEY_ID=ak-id
DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET="secret#value"
DOCUMENT_RENDER_OSS_BUCKET='private-bucket'
DOCUMENT_RENDER_OSS_REGION=cn-beijing
TOS_ACCESS_KEY=tos-ak
TOS_SECRET_KEY="tos-secret#value"
TOS_BUCKET='tos-private-bucket'
TOS_REGION=cn-beijing
`);

  assert.deepEqual(candidates, [
    { key: 'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID', value: 'ak-id' },
    { key: 'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET', value: 'secret#value' },
    { key: 'DOCUMENT_RENDER_OSS_BUCKET', value: 'private-bucket' },
    { key: 'TOS_ACCESS_KEY', value: 'tos-ak' },
    { key: 'TOS_SECRET_KEY', value: 'tos-secret#value' },
    { key: 'TOS_BUCKET', value: 'tos-private-bucket' },
  ]);
});

test('受跟踪密钥检查会合并环境变量和 env 文件并去重', () => {
  const candidates = collectSecretCandidates({
    DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: 'ak-id',
    DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: 'secret',
  }, [
    'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID=ak-id\nDOCUMENT_RENDER_OSS_BUCKET=bucket',
  ]);

  assert.deepEqual(candidates, [
    { key: 'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID', value: 'ak-id' },
    { key: 'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET', value: 'secret' },
    { key: 'DOCUMENT_RENDER_OSS_BUCKET', value: 'bucket' },
  ]);
});

test('受跟踪密钥检查只报告变量名和文件路径，不报告密钥值', () => {
  const matches = findTrackedSecretMatches([
    { key: 'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET', value: 'secret-value' },
  ], (value) => {
    assert.equal(value, 'secret-value');
    return ['README.md'];
  });

  assert.deepEqual(matches, [
    { key: 'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET', files: ['README.md'] },
  ]);
  assert.doesNotMatch(JSON.stringify(matches), /secret-value/);
});

test('受跟踪密钥检查会写出同次运行报告且不输出密钥值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkdocvar-secret-scan-'));
  try {
    const envPath = join(dir, '.env.local');
    const reportPath = join(dir, 'secrets.json');
    const accessKeyId = ['fake-ak-id', 'for-report'].join('-');
    const accessKeySecret = ['fake-secret-value', 'for-report'].join('-');
    const bucket = ['fake-bucket', 'for-report'].join('-');
    const tosAccessKey = ['fake-tos-ak', 'for-report'].join('-');
    const tosSecret = ['fake-tos-secret', 'for-report'].join('-');
    const tosBucket = ['fake-tos-bucket', 'for-report'].join('-');
    writeFileSync(envPath, [
      `DOCUMENT_RENDER_OSS_ACCESS_KEY_ID=${accessKeyId}`,
      `DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET=${accessKeySecret}`,
      `DOCUMENT_RENDER_OSS_BUCKET=${bucket}`,
      `TOS_ACCESS_KEY=${tosAccessKey}`,
      `TOS_SECRET_KEY=${tosSecret}`,
      `TOS_BUCKET=${tosBucket}`,
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'server/src/scripts/verifyNoTrackedSecrets.ts',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DOCUMENT_RENDER_SKIP_PROJECT_ENV: 'true',
        DOCUMENT_RENDER_LOCAL_ENV_PATH: envPath,
        DOCUMENT_RENDER_SECRET_REPORT_PATH: reportPath,
        DOCUMENT_RENDER_MILESTONE1_RUN_ID: 'run-secrets',
        DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: '',
        DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: '',
        DOCUMENT_RENDER_OSS_BUCKET: '',
        ALIYUN_OSS_ACCESS_KEY_ID: '',
        ALIYUN_OSS_ACCESS_KEY_SECRET: '',
        ALIYUN_OSS_BUCKET: '',
        OSS_ACCESS_KEY_ID: '',
        OSS_ACCESS_KEY_SECRET: '',
        OSS_BUCKET: '',
        TOS_ACCESS_KEY: '',
        TOS_SECRET_KEY: '',
        TOS_BUCKET: '',
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.ok, true);
    assert.equal(report.milestoneRunId, 'run-secrets');
    assert.equal(report.reportFile, reportPath);
    assert.deepEqual(report.matches, []);
    assert.match(JSON.stringify(report.checkedKeys), /DOCUMENT_RENDER_OSS_ACCESS_KEY_ID/);
    assert.match(JSON.stringify(report.checkedKeys), /TOS_ACCESS_KEY/);
    const combinedOutput = result.stdout + readFileSync(reportPath, 'utf8');
    assert.equal(combinedOutput.includes(accessKeyId), false);
    assert.equal(combinedOutput.includes(accessKeySecret), false);
    assert.equal(combinedOutput.includes(bucket), false);
    assert.equal(combinedOutput.includes(tosAccessKey), false);
    assert.equal(combinedOutput.includes(tosSecret), false);
    assert.equal(combinedOutput.includes(tosBucket), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
