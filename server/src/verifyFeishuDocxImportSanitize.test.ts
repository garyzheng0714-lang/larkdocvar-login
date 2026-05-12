import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sanitizeText } from './scripts/verifyFeishuDocxImport';

test('飞书导入报告会脱敏 open_id', () => {
  const openId = `ou_${'abc123def456'}`;
  assert.equal(
    sanitizeText(`upload media failed: need_user_authorization (user: ${openId})`),
    'upload media failed: need_user_authorization (user: ou_***)',
  );
});

test('飞书导入验证失败时也写出失败报告', () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-render-feishu-import-'));
  try {
    const reportPath = join(dir, 'feishu-import-report.json');
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'server/src/scripts/verifyFeishuDocxImport.ts',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        DOCUMENT_RENDER_MILESTONE1_RUN_ID: 'run-feishu-missing',
        DOCUMENT_RENDER_FEISHU_IMPORT_REPORT_PATH: reportPath,
        DOCUMENT_RENDER_FEISHU_IMPORT_FILE: '',
      },
    });

    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.ok, false);
    assert.equal(report.milestoneRunId, 'run-feishu-missing');
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.reportFile, reportPath);
    assert.match(report.error, /请传入要导入验证的 Docx 文件路径/);
    assert.doesNotMatch(JSON.stringify(report), /ou_[A-Za-z0-9]+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
