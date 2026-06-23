import assert from 'node:assert/strict';
import test from 'node:test';

import { TosDocumentRenderStorage, __test__, createTosPresignedGetUrl, type TosStorageConfig } from './documentRenderTosStorage';

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function buildConfig(overrides: Partial<TosStorageConfig> = {}): TosStorageConfig {
  return {
    accessKeyId: 'testAK',
    accessKeySecret: 'testSK',
    bucket: 'examplebucket',
    region: 'ap-southeast-1',
    endpoint: 'tos-ap-southeast-1.bytepluses.com',
    prefix: 'document-renders/',
    ...overrides,
  };
}

test('TOS 预签名下载 URL 符合官方 TOS4 查询参数格式', () => {
  const url = createTosPresignedGetUrl(
    buildConfig({ prefix: '' }),
    'exampleobject',
    86400,
    new Date('2022-01-01T00:00:00.000Z'),
  );

  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://examplebucket.tos-ap-southeast-1.bytepluses.com');
  assert.equal(parsed.pathname, '/exampleobject');
  assert.equal(parsed.searchParams.get('X-Tos-Algorithm'), 'TOS4-HMAC-SHA256');
  assert.equal(parsed.searchParams.get('X-Tos-Credential'), 'testAK/20220101/ap-southeast-1/tos/request');
  assert.equal(parsed.searchParams.get('X-Tos-Date'), '20220101T000000Z');
  assert.equal(parsed.searchParams.get('X-Tos-Expires'), '86400');
  assert.equal(parsed.searchParams.get('X-Tos-SignedHeaders'), 'host');
  assert.match(parsed.searchParams.get('X-Tos-Signature') || '', /^[0-9a-f]{64}$/);
});

test('TOS 前缀支持统一项目根目录并清理危险路径片段', () => {
  assert.equal(__test__.buildTosPrefix('../fbif-sidebar-docgen\\prod', '../renders'), 'fbif-sidebar-docgen/prod/renders/');
  assert.equal(__test__.formatTosDatePath(new Date('2026-05-13T12:00:00.000Z')), '2026/05/13');
});

test('TOS 存储上传 Docx 并返回带 TTL 的签名下载链接', async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('', { status: 200 });
  }) as typeof fetch;

  try {
    const storage = new TosDocumentRenderStorage(buildConfig({
      accessKeyId: 'ak-id',
      accessKeySecret: 'ak-secret',
      region: 'cn-beijing',
      endpoint: 'tos-cn-beijing.volces.com',
    }));
    const buffer = Buffer.from('docx-content');
    const saved = await storage.saveDocx({
      buffer,
      fileName: '../报价:单?.docx',
      requestId: '../request\\id?',
      ttlMs: 3600 * 1000,
      ttlSeconds: 3600,
    });

    assert.equal(saved.storage, 'tos');
    assert.equal(saved.fileName, '报价-单-.docx');
    assert.equal(saved.contentType, DOCX_CONTENT_TYPE);
    assert.equal(saved.size, buffer.length);
    assert.match(saved.path, /^document-renders\/\d{4}\/\d{2}\/\d{2}\/request-id\/报价-单-\.docx$/);
    assert.match(saved.url, /^https:\/\/examplebucket\.tos-cn-beijing\.volces\.com\//);
    assert.match(saved.url, /X-Tos-Algorithm=TOS4-HMAC-SHA256/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.method, 'PUT');
    assert.equal((calls[0]?.init?.headers as Record<string, string>)['Content-Type'], DOCX_CONTENT_TYPE);
    assert.match(String((calls[0]?.init?.headers as Record<string, string>).Authorization), /^TOS4-HMAC-SHA256 Credential=/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('TOS 存储上传失败时返回用户可理解错误', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('<Error><Code>AccessDenied</Code><Message>denied</Message></Error>', {
    status: 403,
    headers: { 'x-tos-request-id': 'request-id' },
  })) as typeof fetch;

  try {
    await assert.rejects(
      () => new TosDocumentRenderStorage(buildConfig()).saveDocx({
        buffer: Buffer.from('x'),
        fileName: '合同.docx',
        requestId: 'request-id',
        ttlMs: 1000,
        ttlSeconds: 1,
      }),
      /生成文件上传 TOS 失败，请检查 TOS 配置和权限。/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
