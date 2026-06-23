import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRenderAuditEntry, readAuditCaller } from './documentRenderAudit';

test('成功渲染 → 审计 entry 记录模板、状态、变量计数、下载信息', () => {
  const entry = buildRenderAuditEntry({
    requestId: 'req-1',
    source: 'single',
    status: 'success',
    templateId: 'tpl_x',
    versionId: 'tpl_x_v001',
    caller: 'api-key',
    result: {
      variables: { provided: ['a', 'b', 'c'], missing: [] },
      download: { storage: 'tos', path: 'renders/2026/x.docx', size: 12345 },
    },
  });
  assert.equal(entry.status, 'success');
  assert.equal(entry.templateId, 'tpl_x');
  assert.equal(entry.versionId, 'tpl_x_v001');
  assert.equal(entry.variableCount, 3);
  assert.equal(entry.missingCount, 0);
  assert.equal(entry.storage, 'tos');
  assert.equal(entry.downloadPath, 'renders/2026/x.docx');
  assert.equal(entry.sizeBytes, 12345);
  assert.equal(entry.errorMessage, null);
});

// WHY：失败也要落库——出问题回溯时，失败记录比成功记录更关键。
test('失败渲染 → 审计 entry 记 status=failed 与错误信息', () => {
  const entry = buildRenderAuditEntry({
    requestId: 'req-2',
    source: 'single',
    status: 'failed',
    templateId: 'tpl_y',
    error: new Error('模板不存在。'),
    caller: 'session',
  });
  assert.equal(entry.status, 'failed');
  assert.equal(entry.errorMessage, '模板不存在。');
  assert.equal(entry.variableCount, null);
  assert.equal(entry.storage, null);
  assert.equal(entry.caller, 'session');
});

// WHY：非 Error 抛出（字符串等）也要能记录，不能让审计构造本身崩。
test('非 Error 抛出 → errorMessage 转字符串', () => {
  const entry = buildRenderAuditEntry({
    requestId: 'r',
    source: 'single',
    status: 'failed',
    error: '请求参数不合法。',
  });
  assert.equal(entry.errorMessage, '请求参数不合法。');
});

test('readAuditCaller：带 x-api-key → api-key', () => {
  assert.equal(readAuditCaller({ 'x-api-key': 'k' }), 'api-key');
});

test('readAuditCaller：带 Bearer Authorization → api-key', () => {
  assert.equal(readAuditCaller({ authorization: 'Bearer xxx' }), 'api-key');
});

test('readAuditCaller：无凭据头 → session（侧边栏会话）', () => {
  assert.equal(readAuditCaller({}), 'session');
});
