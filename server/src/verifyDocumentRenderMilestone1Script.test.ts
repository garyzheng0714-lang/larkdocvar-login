import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('Docx API 验收失败时也写出失败报告', () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-render-api-verify-'));
  try {
    const reportPath = join(dir, 'api-report.json');
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'server/src/scripts/verifyDocumentRenderMilestone1.ts',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DOCUMENT_RENDER_MILESTONE1_RUN_ID: 'run-api-failed',
        DOCUMENT_RENDER_VERIFY_BASE_URL: 'http://127.0.0.1:9',
        DOCUMENT_RENDER_VERIFY_REPORT_PATH: reportPath,
        DOCUMENT_RENDER_VERIFY_REPEAT: '0',
        DOCUMENT_RENDER_VERIFY_CONCURRENCY: '0',
      },
    });

    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.ok, false);
    assert.equal(report.milestoneRunId, 'run-api-failed');
    assert.equal(report.baseUrl, 'http://127.0.0.1:9');
    assert.equal(report.reportFile, reportPath);
    assert.equal(typeof report.error, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Docx API 验收模板包含飞书导入需要的标准 Word 部件', () => {
  const source = readFileSync('server/src/scripts/verifyDocumentRenderMilestone1.ts', 'utf8');

  for (const requiredPart of [
    '/docProps/core.xml',
    '/docProps/app.xml',
    '/word/styles.xml',
    '/word/settings.xml',
    '/word/fontTable.xml',
    '/word/theme/theme1.xml',
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  ]) {
    assert.match(source, new RegExp(requiredPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
