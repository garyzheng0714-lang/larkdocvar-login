import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import JSZip from 'jszip';

import { createDocumentRenderRouter } from './documentRenderApi';

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function createMinimalDocxBuffer(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>客户：{{客户名称}}</w:t></w:r></w:p></w:body>
</w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function withTemporaryEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

async function startApi(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.get('/template.docx', (_request, response) => {
    response.setHeader('Content-Type', DOCX_CONTENT_TYPE);
    response.send(templateDocx);
  });
  app.use('/api/v1/document-renders', createDocumentRenderRouter());
  const templateDocx = await createMinimalDocxBuffer();
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => closeServer(server) };
}

function assertExpiresIn(expiresAt: string, startedAt: number, seconds: number): void {
  const deltaMs = Date.parse(expiresAt) - startedAt;
  assert.ok(deltaMs >= seconds * 1000 - 3000, `expiresAt 太早：${deltaMs}`);
  assert.ok(deltaMs <= seconds * 1000 + 3000, `expiresAt 太晚：${deltaMs}`);
}

test('本地下载响应包含安全下载头并清洗文件名', async () => {
  const restorePrivateUrls = withTemporaryEnv('DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS', 'true');
  const api = await startApi();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: `${api.baseUrl}/template.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
        output: { fileName: '../报价:单?*.docx' },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.download.fileName.includes('..'), false);
    assert.equal(body.download.fileName.includes('/'), false);
    assert.equal(body.download.fileName.includes(':'), false);
    assert.equal(body.download.fileName.endsWith('.docx'), true);

    const downloadResponse = await fetch(new URL(body.download.url, api.baseUrl));
    const buffer = Buffer.from(await downloadResponse.arrayBuffer());
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.headers.get('cache-control'), 'private, no-store');
    assert.match(downloadResponse.headers.get('content-disposition') || '', /filename\*=UTF-8''/);
    assert.equal(Number(downloadResponse.headers.get('content-length')), buffer.length);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 拒绝超过上限的下载有效期', async () => {
  const api = await startApi();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: 'https://example.com/template.docx' },
        variables: { 客户名称: '上海测试科技有限公司' },
        output: { expiresInSeconds: 8 * 24 * 60 * 60 },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.error, '请求参数不合法。');
  } finally {
    await api.close();
  }
});

test('本地下载链接失效时返回稳定 requestId', async () => {
  const api = await startApi();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders/downloads/not-found`, {
      headers: { 'x-request-id': 'download-missing-request' },
    });
    const body = await response.json() as any;
    assert.equal(response.status, 404);
    assert.deepEqual(body, {
      ok: false,
      requestId: 'download-missing-request',
      error: '下载链接不存在或已失效。',
    });
  } finally {
    await api.close();
  }
});

test('本地下载文件超过上限时会淘汰最旧链接', async () => {
  const restorePrivateUrls = withTemporaryEnv('DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS', 'true');
  const restoreMaxFiles = withTemporaryEnv('DOCUMENT_RENDER_MAX_FILES', '1');
  const api = await startApi();
  try {
    async function createDownload(customerName: string): Promise<string> {
      const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template: { format: 'docx', url: `${api.baseUrl}/template.docx` },
          variables: { 客户名称: customerName },
        }),
      });
      const body = await response.json() as any;
      assert.equal(response.status, 200);
      return body.download.url;
    }

    const firstUrl = await createDownload('第一家公司');
    const secondUrl = await createDownload('第二家公司');

    const firstDownload = await fetch(new URL(firstUrl, api.baseUrl));
    const firstBody = await firstDownload.json() as any;
    assert.equal(firstDownload.status, 404);
    assert.equal(firstBody.ok, false);
    assert.equal(firstBody.error, '下载链接不存在或已失效。');

    const secondDownload = await fetch(new URL(secondUrl, api.baseUrl));
    assert.equal(secondDownload.status, 200);
  } finally {
    restoreMaxFiles();
    restorePrivateUrls();
    await api.close();
  }
});

test('本地下载链接支持配置 public base URL', async () => {
  const restorePrivateUrls = withTemporaryEnv('DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS', 'true');
  const restoreBaseUrl = withTemporaryEnv('DOCUMENT_RENDER_PUBLIC_BASE_URL', 'https://api.example.com/');
  const api = await startApi();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: `${api.baseUrl}/template.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.match(body.download.url, /^https:\/\/api\.example\.com\/api\/v1\/document-renders\/downloads\//);
  } finally {
    restoreBaseUrl();
    restorePrivateUrls();
    await api.close();
  }
});

test('本地下载链接支持单次配置 24 小时有效期', async () => {
  const restorePrivateUrls = withTemporaryEnv('DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS', 'true');
  const api = await startApi();
  try {
    const startedAt = Date.now();
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: `${api.baseUrl}/template.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
        output: { expiresInSeconds: 24 * 60 * 60 },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assertExpiresIn(body.download.expiresAt, startedAt, 24 * 60 * 60);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('本地下载链接支持环境变量配置默认 1 小时有效期', async () => {
  const restorePrivateUrls = withTemporaryEnv('DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS', 'true');
  const restoreTtl = withTemporaryEnv('DOCUMENT_RENDER_DOWNLOAD_TTL_SECONDS', '3600');
  const api = await startApi();
  try {
    const startedAt = Date.now();
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: `${api.baseUrl}/template.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assertExpiresIn(body.download.expiresAt, startedAt, 3600);
  } finally {
    restoreTtl();
    restorePrivateUrls();
    await api.close();
  }
});

test('环境变量配置的默认下载有效期会封顶 7 天', async () => {
  const restorePrivateUrls = withTemporaryEnv('DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS', 'true');
  const restoreTtl = withTemporaryEnv('DOCUMENT_RENDER_DOWNLOAD_TTL_SECONDS', String(30 * 24 * 60 * 60));
  const api = await startApi();
  try {
    const startedAt = Date.now();
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: `${api.baseUrl}/template.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assertExpiresIn(body.download.expiresAt, startedAt, 7 * 24 * 60 * 60);
  } finally {
    restoreTtl();
    restorePrivateUrls();
    await api.close();
  }
});
