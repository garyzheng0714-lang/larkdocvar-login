import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('Docx 客户端打开验证失败时也写出失败报告', () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-render-client-verify-'));
  try {
    const reportPath = join(dir, 'client-report.json');
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'server/src/scripts/verifyDocxClientOpen.ts',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DOCUMENT_RENDER_MILESTONE1_RUN_ID: 'run-client-missing',
        DOCUMENT_RENDER_CLIENT_REPORT_PATH: reportPath,
        DOCUMENT_RENDER_CLIENT_FILE: '',
      },
    });

    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.ok, false);
    assert.equal(report.app, 'auto');
    assert.equal(report.milestoneRunId, 'run-client-missing');
    assert.equal(report.reportFile, reportPath);
    assert.match(report.error, /请传入要验证的 Docx 文件路径/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
