import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { __test__ } from './scripts/verifyOssStorage';

const OSS_ENV_NAMES = [
  'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID',
  'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET',
  'DOCUMENT_RENDER_OSS_BUCKET',
  'DOCUMENT_RENDER_OSS_REGION',
  'ALIYUN_OSS_ACCESS_KEY_ID',
  'ALIYUN_OSS_ACCESS_KEY_SECRET',
  'ALIYUN_OSS_BUCKET',
  'ALIYUN_OSS_REGION',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'OSS_BUCKET',
  'OSS_REGION',
  'OSS_REGION_ID',
  'DOCUMENT_RENDER_OSS_PREFIX',
  'TOS_ACCESS_KEY',
  'TOS_SECRET_KEY',
  'TOS_BUCKET',
  'TOS_REGION',
  'TOS_ENDPOINT',
  'DOCUMENT_RENDER_TOS_PREFIX',
  'DOCUMENT_RENDER_STORAGE_PROVIDER',
  'DOCUMENT_RENDER_OBJECT_STORAGE_PROVIDER',
];

function withCleanOssEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const name of OSS_ENV_NAMES) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(values)) {
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test('OSS 预检配置缺失时也写出失败报告', () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-render-oss-verify-'));
  try {
    const reportPath = join(dir, 'oss-report.json');
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'server/src/scripts/verifyOssStorage.ts',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DOCUMENT_RENDER_MILESTONE1_RUN_ID: 'run-oss-missing',
        DOCUMENT_RENDER_OSS_REPORT_PATH: reportPath,
        DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: '',
        DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: '',
        DOCUMENT_RENDER_OSS_BUCKET: '',
        DOCUMENT_RENDER_OSS_REGION: '',
        ALIYUN_OSS_ACCESS_KEY_ID: '',
        ALIYUN_OSS_ACCESS_KEY_SECRET: '',
        ALIYUN_OSS_BUCKET: '',
        ALIYUN_OSS_REGION: '',
        OSS_ACCESS_KEY_ID: '',
        OSS_ACCESS_KEY_SECRET: '',
        OSS_BUCKET: '',
        OSS_REGION: '',
        OSS_REGION_ID: '',
      },
    });

    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.ok, false);
    assert.equal(report.milestoneRunId, 'run-oss-missing');
    assert.equal(report.reportFile, reportPath);
    assert.match(report.error.message, /OSS 配置不完整/);
    assert.match(report.diagnostics.hint, /DOCUMENT_RENDER_OSS_ACCESS_KEY_ID/);
    assert.match(report.diagnostics.hint, /npm run verify:oss/);
    assert.doesNotMatch(JSON.stringify(report), /AccessKey Secret|ak-secret-value/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OSS 预检脚本会把可见 bucket 查询错误合并进 hint', () => {
  const source = readFileSync('server/src/scripts/verifyOssStorage.ts', 'utf8');

  assert.match(source, /visibleBucketsError = toErrorSummary\(listError\)/);
  assert.match(source, /可见 bucket 查询失败/);
  assert.match(source, /getHint\(visibleBucketsError\)/);
});

test('OSS 预检失败诊断只记录配置来源和规范化结果，不记录密钥值', () => {
  const restore = withCleanOssEnv({
    ALIYUN_OSS_ACCESS_KEY_ID: 'ak-id-secret-value',
    OSS_ACCESS_KEY_SECRET: 'ak-secret-value',
    DOCUMENT_RENDER_OSS_BUCKET: 'private-bucket-value',
    OSS_REGION_ID: 'cn-beijing',
    DOCUMENT_RENDER_OSS_PREFIX: '../diagnostics',
  });

  try {
    const config = __test__.getConfig();
    const diagnostics = __test__.createConfigDiagnostics(config);

    assert.deepEqual(diagnostics, {
      accessKeyIdEnv: 'ALIYUN_OSS_ACCESS_KEY_ID',
      accessKeySecretEnv: 'OSS_ACCESS_KEY_SECRET',
      bucketEnv: 'DOCUMENT_RENDER_OSS_BUCKET',
      regionEnv: 'OSS_REGION_ID',
      normalizedRegion: 'oss-cn-beijing',
      prefix: 'diagnostics/',
    });
    assert.doesNotMatch(JSON.stringify(diagnostics), /ak-id-secret-value|ak-secret-value|private-bucket-value/);
  } finally {
    restore();
  }
});

test('对象存储预检支持显式选择 TOS 配置且诊断脱敏', () => {
  const restore = withCleanOssEnv({
    DOCUMENT_RENDER_STORAGE_PROVIDER: 'tos',
    TOS_ACCESS_KEY: 'tos-ak-secret-value',
    TOS_SECRET_KEY: 'tos-secret-value',
    TOS_BUCKET: 'tos-private-bucket-value',
    TOS_REGION: 'cn-beijing',
    TOS_ENDPOINT: 'https://tos-cn-beijing.volces.com/',
    DOCUMENT_RENDER_TOS_PREFIX: '../tos\\diagnostics',
  });

  try {
    assert.equal(__test__.getConfiguredProvider(), 'tos');
    const config = __test__.getTosConfig();

    assert.equal(config.accessKeyId, 'tos-ak-secret-value');
    assert.equal(config.accessKeySecret, 'tos-secret-value');
    assert.equal(config.bucket, 'tos-private-bucket-value');
    assert.equal(config.region, 'cn-beijing');
    assert.equal(config.endpoint, 'tos-cn-beijing.volces.com');
    assert.equal(config.prefix, 'tos/diagnostics/');
    assert.doesNotMatch(JSON.stringify({
      accessKeyIdEnv: config.envNames.accessKeyId,
      accessKeySecretEnv: config.envNames.accessKeySecret,
      bucketEnv: config.envNames.bucket,
      regionEnv: config.envNames.region,
      endpointEnv: config.envNames.endpoint,
      normalizedEndpoint: config.endpoint,
      prefix: config.prefix,
    }), /tos-ak-secret-value|tos-secret-value|tos-private-bucket-value/);
  } finally {
    restore();
  }
});

test('OSS 预检报告不会写出 bucket 配置值', () => {
  const source = readFileSync('server/src/scripts/verifyOssStorage.ts', 'utf8');
  const reportBlocks = Array.from(source.matchAll(/writeReport\(\{[\s\S]*?\n\s*\}\);/g)).map((match) => match[0]);
  const reportSource = reportBlocks.join('\n');

  assert.notEqual(reportBlocks.length, 0);
  assert.doesNotMatch(reportSource, /\bbucket:\s*config\.bucket/);
  assert.match(reportSource, /bucketEnv:\s*config\.envNames\.bucket/);
  assert.match(reportSource, /provider:\s*'oss'/);
  assert.match(reportSource, /provider:\s*'tos'/);
});

test('OSS 预检可见 bucket 诊断只输出数量和地域分布', () => {
  const summary = __test__.summarizeVisibleBuckets({
    buckets: [
      { name: 'private-bucket-one', region: 'oss-cn-beijing', creationDate: '2026-01-01' },
      { name: 'private-bucket-two', region: 'oss-cn-shanghai', creationDate: '2026-01-02' },
      { name: 'private-bucket-three', region: 'oss-cn-beijing', creationDate: '2026-01-03' },
    ],
    isTruncated: true,
  });

  assert.deepEqual(summary, {
    count: 3,
    regions: ['oss-cn-beijing', 'oss-cn-shanghai'],
    truncated: true,
  });
  assert.doesNotMatch(JSON.stringify(summary), /private-bucket/);
});

test('OSS 预检 bucket endpoint 诊断给出脱敏结论', () => {
  assert.equal(
    __test__.extractOssXmlErrorCode('<Error><Code>NoSuchBucket</Code><BucketName>private-bucket</BucketName></Error>'),
    'NoSuchBucket',
  );
  assert.equal(
    __test__.classifyBucketEndpointProbe(404, 'NoSuchBucket'),
    'bucket-not-found-in-configured-region',
  );
  assert.equal(
    __test__.classifyBucketEndpointProbe(403, 'AccessDenied'),
    'bucket-endpoint-reachable',
  );

  const notFound = __test__.summarizeBucketEndpointProbe({
    status: 404,
    code: 'NoSuchBucket',
    outcome: 'bucket-not-found-in-configured-region',
  });
  const reachable = __test__.summarizeBucketEndpointProbe({
    status: 403,
    code: 'AccessDenied',
    outcome: 'bucket-endpoint-reachable',
  });

  assert.match(notFound, /bucket 名称和地域/);
  assert.match(reachable, /AccessKey 状态/);
  assert.doesNotMatch(`${notFound}${reachable}`, /private-bucket/);
});

test('OSS 预检跨 region 诊断只输出地域结论', () => {
  const candidates = __test__.buildRegionProbeCandidates('oss-cn-beijing');
  assert.equal(candidates[0], 'oss-cn-beijing');
  assert.equal(new Set(candidates).size, candidates.length);

  const reachable = __test__.summarizeBucketRegionProbe({
    checkedRegions: ['oss-cn-beijing', 'oss-cn-shanghai'],
    reachableRegions: ['oss-cn-shanghai'],
    notFoundCount: 1,
    inconclusiveRegions: [],
    outcome: 'bucket-endpoint-reachable-in-checked-regions',
  });
  const notFound = __test__.summarizeBucketRegionProbe({
    checkedRegions: ['oss-cn-beijing', 'oss-cn-shanghai'],
    reachableRegions: [],
    notFoundCount: 2,
    inconclusiveRegions: [],
    outcome: 'bucket-not-found-in-checked-regions',
  });
  const inconclusive = __test__.summarizeBucketRegionProbe({
    checkedRegions: ['oss-cn-beijing', 'oss-cn-shanghai'],
    reachableRegions: [],
    notFoundCount: 1,
    inconclusiveRegions: ['oss-cn-shanghai'],
    outcome: 'inconclusive',
  });

  assert.match(reachable, /oss-cn-shanghai/);
  assert.match(notFound, /2 个常见 OSS region/);
  assert.match(inconclusive, /1 个 region 结果不确定/);
  assert.doesNotMatch(`${reachable}${notFound}${inconclusive}`, /private-bucket/);
});
