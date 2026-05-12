import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';

import {
  buildFeishuImportAuthFailureReport,
  cleanupMilestoneReports,
  milestoneEnv,
  parseFeishuImportAuthCheck,
  runPreflightTasks,
  withoutDocumentRenderRuntimeEnv,
  withoutOssStorageEnv,
} from './scripts/verifyDocumentRenderMilestone1Full';

function buildConfig(dir = '/tmp') {
  return {
    port: 19090,
    baseUrl: 'http://127.0.0.1:19090',
    outputPath: join(dir, 'generated.docx'),
    verifyReportPath: join(dir, 'api.json'),
    ossReportPath: join(dir, 'oss.json'),
    secretReportPath: join(dir, 'secrets.json'),
    clientReportPath: join(dir, 'client.json'),
    feishuReportPath: join(dir, 'feishu.json'),
    auditReportPath: join(dir, 'audit.json'),
    runId: 'run-full',
  };
}

test('一键里程碑验收脚本显式传递最终审计报告路径', () => {
  const env = milestoneEnv(buildConfig());

  assert.equal(env.DOCUMENT_RENDER_AUDIT_REPORT_PATH, '/tmp/audit.json');
  assert.equal(env.DOCUMENT_RENDER_SECRET_REPORT_PATH, '/tmp/secrets.json');
  assert.equal(env.DOCUMENT_RENDER_MILESTONE1_RUN_ID, 'run-full');
  assert.equal(env.DOCUMENT_RENDER_VERIFY_EXPECT_STORAGE, 'oss');
  assert.equal(env.DOCUMENT_RENDER_FEISHU_IMPORT_EXECUTE, undefined);
});

test('一键里程碑验收脚本只在飞书导入步骤开启 execute', () => {
  const env = milestoneEnv(buildConfig(), { feishuExecute: true });

  assert.equal(env.DOCUMENT_RENDER_FEISHU_IMPORT_EXECUTE, 'true');
});

test('一键里程碑验收脚本支持前置失败时记录 local 降级证据', () => {
  const env = milestoneEnv(buildConfig(), { expectedStorage: 'local' });

  assert.equal(env.DOCUMENT_RENDER_VERIFY_EXPECT_STORAGE, 'local');
  assert.equal(env.DOCUMENT_RENDER_MILESTONE1_RUN_ID, 'run-full');
});

test('一键里程碑验收脚本显式 TOS 存储时默认校验 TOS 下载链路', () => {
  const previous = process.env.DOCUMENT_RENDER_STORAGE_PROVIDER;
  process.env.DOCUMENT_RENDER_STORAGE_PROVIDER = 'tos';

  try {
    const env = milestoneEnv(buildConfig());
    assert.equal(env.DOCUMENT_RENDER_VERIFY_EXPECT_STORAGE, 'tos');
  } finally {
    if (previous === undefined) {
      delete process.env.DOCUMENT_RENDER_STORAGE_PROVIDER;
    } else {
      process.env.DOCUMENT_RENDER_STORAGE_PROVIDER = previous;
    }
  }
});

test('一键里程碑验收脚本 local 降级证据不会继承 OSS 存储配置', () => {
  const env = withoutOssStorageEnv({
    DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: 'ak',
    DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: 'secret',
    DOCUMENT_RENDER_OSS_BUCKET: 'bucket',
    DOCUMENT_RENDER_OSS_REGION: 'cn-beijing',
    DOCUMENT_RENDER_OSS_PREFIX: 'document-renders',
    DOCUMENT_RENDER_OSS_REPORT_PATH: '/tmp/oss.json',
    ALIYUN_OSS_ACCESS_KEY_ID: 'ak',
    ALIYUN_OSS_ACCESS_KEY_SECRET: 'secret',
    ALIYUN_OSS_BUCKET: 'bucket',
    ALIYUN_OSS_REGION: 'cn-beijing',
    OSS_ACCESS_KEY_ID: 'ak',
    OSS_ACCESS_KEY_SECRET: 'secret',
    OSS_BUCKET: 'bucket',
    OSS_REGION: 'cn-beijing',
    OSS_REGION_ID: 'cn-beijing',
    TOS_ACCESS_KEY: 'tos-ak',
    TOS_SECRET_KEY: 'tos-secret',
    TOS_BUCKET: 'tos-bucket',
    TOS_REGION: 'cn-beijing',
    TOS_ENDPOINT: 'tos-cn-beijing.volces.com',
    DOCUMENT_RENDER_TOS_PREFIX: 'document-renders',
    DOCUMENT_RENDER_STORAGE_PROVIDER: 'tos',
    DOCUMENT_RENDER_OBJECT_STORAGE_PROVIDER: 'tos',
    KEEP_ME: 'yes',
  });

  for (const name of [
    'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID',
    'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET',
    'DOCUMENT_RENDER_OSS_BUCKET',
    'DOCUMENT_RENDER_OSS_REGION',
    'DOCUMENT_RENDER_OSS_PREFIX',
    'ALIYUN_OSS_ACCESS_KEY_ID',
    'ALIYUN_OSS_ACCESS_KEY_SECRET',
    'ALIYUN_OSS_BUCKET',
    'ALIYUN_OSS_REGION',
    'OSS_ACCESS_KEY_ID',
    'OSS_ACCESS_KEY_SECRET',
    'OSS_BUCKET',
    'OSS_REGION',
    'OSS_REGION_ID',
    'TOS_ACCESS_KEY',
    'TOS_SECRET_KEY',
    'TOS_BUCKET',
    'TOS_REGION',
    'TOS_ENDPOINT',
    'DOCUMENT_RENDER_TOS_PREFIX',
    'DOCUMENT_RENDER_STORAGE_PROVIDER',
    'DOCUMENT_RENDER_OBJECT_STORAGE_PROVIDER',
  ]) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(env.DOCUMENT_RENDER_OSS_REPORT_PATH, '/tmp/oss.json');
  assert.equal(env.KEEP_ME, 'yes');
});

test('一键里程碑验收脚本跑单元测试时不继承本地运行时配置', () => {
  const env = withoutDocumentRenderRuntimeEnv({
    DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: 'ak',
    DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: 'secret',
    DOCUMENT_RENDER_OSS_BUCKET: 'bucket',
    DOCUMENT_RENDER_OSS_REGION: 'cn-beijing',
    DOCUMENT_RENDER_DOWNLOAD_TTL_SECONDS: '3600',
    DOCUMENT_RENDER_DOWNLOAD_TTL_MS: '3600000',
    DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS: 'true',
    DOCUMENT_RENDER_PUBLIC_BASE_URL: 'https://api.example.com',
    DOCUMENT_RENDER_MAX_FILES: '1',
    TOS_ACCESS_KEY: 'tos-ak',
    TOS_BUCKET: 'tos-bucket',
    DOCUMENT_RENDER_STORAGE_PROVIDER: 'tos',
    DOCUMENT_RENDER_OBJECT_STORAGE_PROVIDER: 'tos',
    KEEP_ME: 'yes',
  });

  for (const name of [
    'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID',
    'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET',
    'DOCUMENT_RENDER_OSS_BUCKET',
    'DOCUMENT_RENDER_OSS_REGION',
    'DOCUMENT_RENDER_DOWNLOAD_TTL_SECONDS',
    'DOCUMENT_RENDER_DOWNLOAD_TTL_MS',
    'DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS',
    'DOCUMENT_RENDER_PUBLIC_BASE_URL',
    'DOCUMENT_RENDER_MAX_FILES',
    'TOS_ACCESS_KEY',
    'TOS_BUCKET',
    'DOCUMENT_RENDER_STORAGE_PROVIDER',
    'DOCUMENT_RENDER_OBJECT_STORAGE_PROVIDER',
  ]) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(env.KEEP_ME, 'yes');
});

test('一键里程碑验收脚本 local 证据服务会跳过本地私有 env', () => {
  const env = withoutDocumentRenderRuntimeEnv({
    DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: 'ak',
    DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: 'secret',
    DOCUMENT_RENDER_OSS_BUCKET: 'bucket',
    DOCUMENT_RENDER_OSS_REGION: 'cn-beijing',
    DOCUMENT_RENDER_SKIP_PROJECT_ENV: 'true',
  });

  assert.equal(env.DOCUMENT_RENDER_OSS_ACCESS_KEY_ID, undefined);
  assert.equal(env.DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET, undefined);
  assert.equal(env.DOCUMENT_RENDER_OSS_BUCKET, undefined);
  assert.equal(env.DOCUMENT_RENDER_OSS_REGION, undefined);
  assert.equal(env.DOCUMENT_RENDER_SKIP_PROJECT_ENV, 'true');
});

test('一键里程碑验收脚本能解析飞书导入授权检查结果', () => {
  assert.deepEqual(
    parseFeishuImportAuthCheck('notice\n{"ok":true}\n'),
    { ok: true, evidence: 'docs:document:import 授权可用' },
  );
  assert.deepEqual(
    parseFeishuImportAuthCheck('{"ok":false,"error":"no_token","missing":["docs:document:import"]}'),
    { ok: false, evidence: 'error=no_token；missing=docs:document:import' },
  );
  assert.deepEqual(
    parseFeishuImportAuthCheck('not json'),
    { ok: false, evidence: 'lark-cli auth check 没有返回 JSON' },
  );
});

test('一键里程碑验收脚本的飞书授权失败报告不包含敏感授权值', () => {
  const report = buildFeishuImportAuthFailureReport(
    buildConfig('/tmp/run-feishu-auth'),
    'error=no_token；missing=docs:document:import',
  );

  assert.equal(report.milestoneRunId, 'run-full');
  assert.equal(report.ok, false);
  assert.equal(report.mode, 'execute');
  assert.equal(report.identity, 'user');
  assert.match(String(report.error), /no_token/);
  assert.match(String((report.diagnostics as Record<string, unknown>).nextStep), /lark-cli auth login/);
  assert.doesNotMatch(JSON.stringify(report), /access_token|ou_[A-Za-z0-9]+/);
});

test('一键里程碑验收脚本会执行全部外部 preflight 后再汇总失败', async () => {
  const executed: string[] = [];

  await assert.rejects(
    runPreflightTasks([
      {
        name: 'OSS 预检',
        run: async () => {
          executed.push('oss');
          throw new Error('oss failed');
        },
      },
      {
        name: '飞书导入授权',
        run: async () => {
          executed.push('feishu');
          throw new Error('feishu failed');
        },
      },
    ]),
    /OSS 预检: oss failed；飞书导入授权: feishu failed/,
  );
  assert.deepEqual(executed, ['oss', 'feishu']);
});

test('一键里程碑验收脚本启动前清理旧报告', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'larkdocvar-full-verify-'));
  const config = buildConfig(dir);
  const reports = [
    config.verifyReportPath,
    config.ossReportPath,
    config.secretReportPath,
    config.clientReportPath,
    config.feishuReportPath,
    config.auditReportPath,
  ];
  await Promise.all(reports.map((reportPath) => writeFile(reportPath, '{}\n')));

  await cleanupMilestoneReports(config);

  await Promise.all(reports.map(async (reportPath) => {
    await assert.rejects(access(reportPath));
  }));
});

test('一键里程碑验收脚本会自动执行受跟踪密钥扫描', async () => {
  const source = await readFile('server/src/scripts/verifyDocumentRenderMilestone1Full.ts', 'utf8');

  assert.match(source, /npm', \['run', 'verify:secrets'\]/);
  assert.match(source, /await runSecretScan\(config\)/);
  assert.match(source, /await cleanupMilestoneReports\(config\);\n\s+await runSecretScan\(config\);/);
});
