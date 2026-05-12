import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  getOssEnvStatus,
  REQUIRED_CHECKS,
  REQUIRED_FEISHU_EXECUTE_CHECKS,
  REQUIRED_OSS_CHECKS,
  selectPrimaryBlockers,
  summarizeFeishuImportReport,
  summarizeOssReport,
  summarizeRunIdStatus,
  summarizeSecretReport,
} from './scripts/auditDocumentRenderMilestone1';

test('OSS 环境变量审计支持别名且不泄露变量值', () => {
  const env = {
    ALIYUN_OSS_ACCESS_KEY_ID: 'ak-id-secret-value',
    OSS_ACCESS_KEY_SECRET: 'ak-secret-value',
    DOCUMENT_RENDER_OSS_BUCKET: 'bucket-secret-value',
    OSS_REGION_ID: 'region-secret-value',
  };

  const status = getOssEnvStatus(env);

  assert.equal(status.ok, true);
  assert.equal(status.missing, '');
  assert.equal(
    status.evidence,
    'ALIYUN_OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, DOCUMENT_RENDER_OSS_BUCKET, OSS_REGION_ID',
  );
  assert.doesNotMatch(status.evidence, /secret-value/);
});

test('OSS 环境变量审计缺项时返回规范字段名', () => {
  const status = getOssEnvStatus({
    DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: 'configured',
    DOCUMENT_RENDER_OSS_BUCKET: 'configured',
  });

  assert.equal(status.ok, false);
  assert.equal(
    status.missing,
    'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET, DOCUMENT_RENDER_OSS_REGION',
  );
});

test('OSS 预检失败摘要保留可读错误但不拼接敏感配置', () => {
  const summary = summarizeOssReport({
    ok: false,
    bucketEnv: 'DOCUMENT_RENDER_OSS_BUCKET',
    region: 'private-region-name',
    error: {
      code: 'NoSuchBucket',
      message: 'bucket does not exist',
    },
    diagnostics: {
      hint: '请确认 Bucket 与地域。',
      config: {
        accessKeyIdEnv: 'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID',
        accessKeySecretEnv: 'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET',
        bucketEnv: 'DOCUMENT_RENDER_OSS_BUCKET',
        regionEnv: 'DOCUMENT_RENDER_OSS_REGION',
        normalizedRegion: 'oss-cn-beijing',
        prefix: 'document-renders/',
      },
      visibleBucketsError: {
        code: 'InvalidAccessKeyId',
        message: 'The OSS Access Key Id you provided is disabled.',
      },
    },
  }, '/tmp/oss-report.json');

  assert.equal(
    summary,
    '/tmp/oss-report.json；code=NoSuchBucket；bucket does not exist；配置来源；accessKeyId=DOCUMENT_RENDER_OSS_ACCESS_KEY_ID；bucket=DOCUMENT_RENDER_OSS_BUCKET；region=DOCUMENT_RENDER_OSS_REGION；normalizedRegion=oss-cn-beijing；可见 bucket 查询失败；code=InvalidAccessKeyId；The OSS Access Key Id you provided is disabled.；下一步：请确认 Bucket 与地域。',
  );
  assert.doesNotMatch(summary, /private-bucket-name|private-region-name/);
  assert.doesNotMatch(summary, /DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET|document-renders/);
});

test('飞书导入失败摘要包含执行模式和用户可理解原因', () => {
  const summary = summarizeFeishuImportReport({
    ok: false,
    mode: 'execute',
    file: '/tmp/generated.docx',
    error: 'App scope not enabled: required scope docs:document:import [99991672]',
    diagnostics: {
      nextStep: '请完成 docs:document:import 授权。',
    },
  }, '/tmp/feishu-import.json');

  assert.equal(
    summary,
    '/tmp/feishu-import.json；mode=execute；App scope not enabled: required scope docs:document:import [99991672]；下一步：请完成 docs:document:import 授权。',
  );
  assert.doesNotMatch(summary, /generated\.docx/);
});

test('密钥扫描摘要只包含变量名和文件路径', () => {
  const summary = summarizeSecretReport({
    ok: false,
    checkedKeys: ['DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET'],
    matches: [
      { key: 'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET', files: ['README.md'] },
    ],
  }, '/tmp/secrets.json');

  assert.equal(summary, '/tmp/secrets.json；DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET=README.md');
  assert.doesNotMatch(summary, /secret-value|AccessKey/);
});

test('里程碑审计要求所有报告来自同一次验证运行', () => {
  const status = summarizeRunIdStatus('run-123', [
    { name: 'api', report: { milestoneRunId: 'run-123' } },
    { name: 'oss', report: { milestoneRunId: 'run-123' } },
    { name: 'client', report: { milestoneRunId: 'old-run' } },
    { name: 'feishu', report: null },
  ]);

  assert.equal(status.ok, false);
  assert.equal(status.evidence, 'expected=run-123；client=old-run；feishu=missing');
});

test('未设置里程碑 run id 时审计可从报告推断同一次运行', () => {
  const status = summarizeRunIdStatus('', [
    { name: 'api', report: { milestoneRunId: 'run-456' } },
    { name: 'oss', report: { milestoneRunId: 'run-456' } },
  ]);

  assert.equal(status.ok, true);
  assert.equal(status.evidence, 'runId=run-456');
});

test('未设置里程碑 run id 且报告缺失 run id 时审计失败', () => {
  const status = summarizeRunIdStatus('', [
    { name: 'api', report: null },
    { name: 'oss', report: { milestoneRunId: '' } },
  ]);

  assert.equal(status.ok, false);
  assert.match(status.evidence, /缺少可推断的同次运行 run id/);
});

test('里程碑审计会从失败门禁中提取主要阻塞项', () => {
  const gates = [
    { name: '本地/接口验收报告存在', status: 'fail' as const, evidence: 'missing api' },
    { name: 'OSS 环境变量已配置', status: 'fail' as const, evidence: 'missing oss env' },
    { name: '真实 OSS 预检通过', status: 'fail' as const, evidence: 'oss failed' },
    { name: 'API 返回 OSS 下载链路', status: 'fail' as const, evidence: 'storage=unknown' },
    { name: '飞书实际导入验证通过', status: 'fail' as const, evidence: 'missing feishu' },
  ];

  assert.deepEqual(
    selectPrimaryBlockers(gates, {
      reportOk: false,
      allOssEnv: false,
      ossReportReady: false,
      storage: undefined,
      feishuReportAvailable: false,
      feishuImportReportReady: false,
      secretReportReady: true,
    }).map((blocker) => blocker.name),
    ['OSS 环境变量已配置', '真实 OSS 预检通过'],
  );
  assert.deepEqual(
    selectPrimaryBlockers(gates, {
      reportOk: true,
      allOssEnv: false,
      ossReportReady: false,
      storage: 'local',
      feishuReportAvailable: false,
      feishuImportReportReady: false,
      secretReportReady: true,
    }).map((blocker) => blocker.name),
    ['OSS 环境变量已配置', '真实 OSS 预检通过', '飞书实际导入验证通过'],
  );
  assert.deepEqual(
    selectPrimaryBlockers(gates, {
      reportOk: true,
      allOssEnv: true,
      ossReportReady: true,
      storage: 'local',
      feishuReportAvailable: false,
      feishuImportReportReady: false,
      secretReportReady: true,
    }).map((blocker) => blocker.name),
    ['API 返回 OSS 下载链路', '飞书实际导入验证通过'],
  );
});

test('里程碑审计会把失败报告纳入同次运行校验', () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-render-audit-failed-same-run-'));
  try {
    const generatedFile = join(dir, 'generated.docx');
    const apiReportPath = join(dir, 'api.json');
    const ossReportPath = join(dir, 'oss.json');
    const secretReportPath = join(dir, 'secrets.json');
    const clientReportPath = join(dir, 'client.json');
    const feishuReportPath = join(dir, 'feishu.json');
    const auditReportPath = join(dir, 'audit.json');
    writeFileSync(generatedFile, 'docx');
    writeFileSync(apiReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-failed-same',
      storage: 'local',
      generatedFile,
      checks: REQUIRED_CHECKS,
      stability: {
        sequential: { total: 500, ok: 500, p95Ms: 10 },
        concurrent: { total: 20, ok: 20, p95Ms: 20 },
      },
    }));
    writeFileSync(ossReportPath, JSON.stringify({
      ok: false,
      milestoneRunId: 'run-failed-same',
      error: { code: 'NoSuchBucket', message: 'bucket does not exist' },
    }));
    writeFileSync(secretReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-failed-same',
      checkedKeys: ['DOCUMENT_RENDER_OSS_ACCESS_KEY_ID'],
      matches: [],
    }));
    writeFileSync(clientReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-failed-same',
      file: generatedFile,
      checks: ['wps-process-visible', 'docx-window-visible', 'no-client-error-dialog'],
    }));
    writeFileSync(feishuReportPath, JSON.stringify({
      ok: false,
      milestoneRunId: 'run-failed-same',
      mode: 'execute',
      file: generatedFile,
      error: '飞书导入授权不可用：error=no_token',
    }));

    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'server/src/scripts/auditDocumentRenderMilestone1.ts',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DOCUMENT_RENDER_MILESTONE1_RUN_ID: 'run-failed-same',
        DOCUMENT_RENDER_MILESTONE1_REPORT_PATH: apiReportPath,
        DOCUMENT_RENDER_OSS_REPORT_PATH: ossReportPath,
        DOCUMENT_RENDER_SECRET_REPORT_PATH: secretReportPath,
        DOCUMENT_RENDER_CLIENT_REPORT_PATH: clientReportPath,
        DOCUMENT_RENDER_FEISHU_IMPORT_REPORT_PATH: feishuReportPath,
        DOCUMENT_RENDER_AUDIT_REPORT_PATH: auditReportPath,
      },
    });

    assert.equal(result.status, 1);
    const auditReport = JSON.parse(readFileSync(auditReportPath, 'utf8'));
    const sameRunGate = auditReport.gates.find((gate: { name: string }) => gate.name === '同次运行报告一致');
    assert.deepEqual(sameRunGate, {
      name: '同次运行报告一致',
      status: 'pass',
      evidence: 'runId=run-failed-same',
    });
    assert.equal(auditReport.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('里程碑审计命令写出机器可读审计报告', () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-render-audit-'));
  try {
    const generatedFile = join(dir, 'generated.docx');
    const apiReportPath = join(dir, 'api.json');
    const ossReportPath = join(dir, 'oss.json');
    const secretReportPath = join(dir, 'secrets.json');
    const clientReportPath = join(dir, 'client.json');
    const feishuReportPath = join(dir, 'feishu.json');
    const auditReportPath = join(dir, 'audit.json');
    writeFileSync(generatedFile, 'docx');
    writeFileSync(apiReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-audit',
      storage: 'oss',
      generatedFile,
      checks: REQUIRED_CHECKS,
      stability: {
        sequential: { total: 500, ok: 500, p95Ms: 10 },
        concurrent: { total: 20, ok: 20, p95Ms: 20 },
      },
    }));
    writeFileSync(ossReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-audit',
      checks: REQUIRED_OSS_CHECKS,
    }));
    writeFileSync(secretReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-audit',
      checkedKeys: ['DOCUMENT_RENDER_OSS_ACCESS_KEY_ID'],
      matches: [],
    }));
    writeFileSync(clientReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-audit',
      file: generatedFile,
      checks: ['word-process-visible', 'docx-window-visible', 'no-client-error-dialog'],
    }));
    writeFileSync(feishuReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-audit',
      mode: 'execute',
      file: generatedFile,
      checks: REQUIRED_FEISHU_EXECUTE_CHECKS,
    }));

    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'server/src/scripts/auditDocumentRenderMilestone1.ts',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DOCUMENT_RENDER_MILESTONE1_RUN_ID: 'run-audit',
        DOCUMENT_RENDER_MILESTONE1_REPORT_PATH: apiReportPath,
        DOCUMENT_RENDER_OSS_REPORT_PATH: ossReportPath,
        DOCUMENT_RENDER_SECRET_REPORT_PATH: secretReportPath,
        DOCUMENT_RENDER_CLIENT_REPORT_PATH: clientReportPath,
        DOCUMENT_RENDER_FEISHU_IMPORT_REPORT_PATH: feishuReportPath,
        DOCUMENT_RENDER_AUDIT_REPORT_PATH: auditReportPath,
        DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: 'configured',
        DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: 'configured',
        DOCUMENT_RENDER_OSS_BUCKET: 'configured',
        DOCUMENT_RENDER_OSS_REGION: 'configured',
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const auditReport = JSON.parse(readFileSync(auditReportPath, 'utf8'));
    assert.equal(auditReport.ok, true);
    assert.equal(auditReport.auditReportPath, auditReportPath);
    assert.deepEqual(auditReport.primaryBlockers, []);
    assert.deepEqual(auditReport.blockers, []);
    assert.equal(auditReport.gates.every((gate: { status: string }) => gate.status === 'pass'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('里程碑审计把拆分变量和样式边界测试纳入格式兼容要求', () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-render-audit-boundary-'));
  try {
    const generatedFile = join(dir, 'generated.docx');
    const apiReportPath = join(dir, 'api.json');
    const ossReportPath = join(dir, 'oss.json');
    const secretReportPath = join(dir, 'secrets.json');
    const clientReportPath = join(dir, 'client.json');
    const feishuReportPath = join(dir, 'feishu.json');
    const auditReportPath = join(dir, 'audit.json');
    const checksWithoutBoundary = REQUIRED_CHECKS
      .filter((check) => check !== 'document-render-boundary-tests-present');
    writeFileSync(generatedFile, 'docx');
    writeFileSync(apiReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-boundary',
      storage: 'oss',
      generatedFile,
      checks: checksWithoutBoundary,
      stability: {
        sequential: { total: 500, ok: 500, p95Ms: 10 },
        concurrent: { total: 20, ok: 20, p95Ms: 20 },
      },
    }));
    writeFileSync(ossReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-boundary',
      checks: REQUIRED_OSS_CHECKS,
    }));
    writeFileSync(secretReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-boundary',
      checkedKeys: ['DOCUMENT_RENDER_OSS_ACCESS_KEY_ID'],
      matches: [],
    }));
    writeFileSync(clientReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-boundary',
      file: generatedFile,
      checks: ['wps-process-visible', 'docx-window-visible', 'no-client-error-dialog'],
    }));
    writeFileSync(feishuReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-boundary',
      mode: 'execute',
      file: generatedFile,
      checks: REQUIRED_FEISHU_EXECUTE_CHECKS,
    }));

    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'server/src/scripts/auditDocumentRenderMilestone1.ts',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DOCUMENT_RENDER_MILESTONE1_RUN_ID: 'run-boundary',
        DOCUMENT_RENDER_MILESTONE1_REPORT_PATH: apiReportPath,
        DOCUMENT_RENDER_OSS_REPORT_PATH: ossReportPath,
        DOCUMENT_RENDER_SECRET_REPORT_PATH: secretReportPath,
        DOCUMENT_RENDER_CLIENT_REPORT_PATH: clientReportPath,
        DOCUMENT_RENDER_FEISHU_IMPORT_REPORT_PATH: feishuReportPath,
        DOCUMENT_RENDER_AUDIT_REPORT_PATH: auditReportPath,
        DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: 'configured',
        DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: 'configured',
        DOCUMENT_RENDER_OSS_BUCKET: 'configured',
        DOCUMENT_RENDER_OSS_REGION: 'configured',
      },
    });

    assert.equal(result.status, 1);
    const auditReport = JSON.parse(readFileSync(auditReportPath, 'utf8'));
    const requirementStatus = (name: string) => auditReport.requirements
      .find((requirement: { name: string }) => requirement.name === name)
      ?.status;
    assert.equal(requirementStatus('支持变量被 Word 拆成多个文本节点'), 'fail');
    assert.equal(requirementStatus('替换后保留基础样式'), 'fail');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('里程碑审计拒绝复用旧的客户端或飞书导入报告', () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-render-audit-stale-'));
  try {
    const generatedFile = join(dir, 'generated.docx');
    const staleFile = join(dir, 'old-generated.docx');
    const apiReportPath = join(dir, 'api.json');
    const ossReportPath = join(dir, 'oss.json');
    const secretReportPath = join(dir, 'secrets.json');
    const clientReportPath = join(dir, 'client.json');
    const feishuReportPath = join(dir, 'feishu.json');
    const auditReportPath = join(dir, 'audit.json');
    writeFileSync(generatedFile, 'docx');
    writeFileSync(staleFile, 'old');
    writeFileSync(apiReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-stale',
      storage: 'oss',
      generatedFile,
      checks: REQUIRED_CHECKS,
      stability: {
        sequential: { total: 500, ok: 500, p95Ms: 10 },
        concurrent: { total: 20, ok: 20, p95Ms: 20 },
      },
    }));
    writeFileSync(ossReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-stale',
      checks: REQUIRED_OSS_CHECKS,
    }));
    writeFileSync(secretReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-stale',
      checkedKeys: ['DOCUMENT_RENDER_OSS_ACCESS_KEY_ID'],
      matches: [],
    }));
    writeFileSync(clientReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-stale',
      file: staleFile,
      checks: ['wps-process-visible', 'docx-window-visible', 'no-client-error-dialog'],
    }));
    writeFileSync(feishuReportPath, JSON.stringify({
      ok: true,
      milestoneRunId: 'run-stale',
      mode: 'execute',
      file: staleFile,
      checks: REQUIRED_FEISHU_EXECUTE_CHECKS,
    }));

    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'server/src/scripts/auditDocumentRenderMilestone1.ts',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DOCUMENT_RENDER_MILESTONE1_RUN_ID: 'run-stale',
        DOCUMENT_RENDER_MILESTONE1_REPORT_PATH: apiReportPath,
        DOCUMENT_RENDER_OSS_REPORT_PATH: ossReportPath,
        DOCUMENT_RENDER_SECRET_REPORT_PATH: secretReportPath,
        DOCUMENT_RENDER_CLIENT_REPORT_PATH: clientReportPath,
        DOCUMENT_RENDER_FEISHU_IMPORT_REPORT_PATH: feishuReportPath,
        DOCUMENT_RENDER_AUDIT_REPORT_PATH: auditReportPath,
        DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: 'configured',
        DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: 'configured',
        DOCUMENT_RENDER_OSS_BUCKET: 'configured',
        DOCUMENT_RENDER_OSS_REGION: 'configured',
      },
    });

    assert.equal(result.status, 1);
    const auditReport = JSON.parse(readFileSync(auditReportPath, 'utf8'));
    const failedGates = auditReport.gates
      .filter((gate: { status: string }) => gate.status !== 'pass')
      .map((gate: { name: string }) => gate.name);
    assert.deepEqual(failedGates, ['客户端打开验证通过', '飞书实际导入验证通过']);
    assert.deepEqual(
      auditReport.blockers.map((blocker: { name: string }) => blocker.name),
      failedGates,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
