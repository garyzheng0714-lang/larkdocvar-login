import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateCloudDocuments,
  parseJsonResponse,
  saveCloudDocAutoConfig,
} from './cloudDocApi';

test('parseJsonResponse 把非 ok 响应转换成可读错误', async () => {
  await assert.rejects(
    parseJsonResponse(new Response(JSON.stringify({ ok: false, error: '无权限' }), { status: 403 })),
    /无权限/,
  );
});

test('生成云文档 API 保持固定权限选项，避免拆分后改变后端契约', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response(JSON.stringify({ ok: true, results: [] }));
  }) as typeof fetch;

  try {
    await generateCloudDocuments('https://example.feishu.cn/docx/mock', [
      { recordId: 'rec1', variables: { 姓名: '甲' } },
    ], { 'Content-Type': 'application/json', 'X-Bitable-Base-Id': 'base', 'X-Bitable-Table-Id': 'table' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls[0].url, '/api/documents/generate');
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    templateUrl: 'https://example.feishu.cn/docx/mock',
    records: [{ recordId: 'rec1', variables: { 姓名: '甲' } }],
    options: {
      permissionMode: 'tenant_readable',
      ownerTransferEnabled: false,
    },
  });
});

test('自动配置保存使用调用方传入的 outputFieldId，AUTO 哨兵值应在状态层转换为空串', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;

  try {
    await saveCloudDocAutoConfig({
      templateUrl: 'https://foodtalks.feishu.cn/docx/mock',
      activeTableId: 'tbl1',
      templateTitle: '模板',
      documentId: 'mock',
      mapping: { 姓名: 'f_name' },
      outputFieldId: '',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls[0].url, '/api/configs/auto');
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    templateUrl: 'https://foodtalks.feishu.cn/docx/mock',
    tableId: 'tbl1',
    payload: {
      templateUrl: 'https://foodtalks.feishu.cn/docx/mock',
      templateTitle: '模板',
      templateId: 'mock',
      tableId: 'tbl1',
      bindings: { 姓名: 'f_name' },
      outputFieldId: '',
    },
  });
});
