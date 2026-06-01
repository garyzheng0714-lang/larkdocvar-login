import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import JSZip from 'jszip';

import {
  createDocumentRenderRouter,
  type DocumentRenderStorage,
  type SaveGeneratedDocxInput,
  type SavedGeneratedDocx,
} from './documentRenderApi';

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

class FailingStorage implements DocumentRenderStorage {
  async saveDocx(_input: SaveGeneratedDocxInput): Promise<SavedGeneratedDocx> {
    throw new Error('internal stack path /Users/simba/private-secret.ts');
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function createMinimalDocxBuffer(text: string): Promise<Buffer> {
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
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function startServer(storage?: DocumentRenderStorage, templateText = '客户：{{客户名称}}'): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const templateDocx = await createMinimalDocxBuffer(templateText);
  const app = express();
  app.get('/template.docx', (_request, response) => {
    response.setHeader('Content-Type', DOCX_CONTENT_TYPE);
    response.send(templateDocx);
  });
  app.use('/api/v1/document-renders', createDocumentRenderRouter({ storage }));
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

function enablePrivateTemplateUrlsForTest(): () => void {
  const previous = process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS;
  process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS = 'true';
  return () => {
    if (previous === undefined) delete process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS;
    else process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS = previous;
  };
}

test('公开 API 参数错误不暴露校验库细节', async () => {
  const api = await startServer();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: { format: 'pdf' }, variables: {} }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, '请求参数不合法。');
    assert.equal('issues' in body, false);
    assert.equal('stack' in body, false);
  } finally {
    await api.close();
  }
});

test('公开 API 遇到 JSON 解析错误时返回稳定 JSON', async () => {
  const api = await startServer();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'bad-json-request' },
      body: '{"template":',
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.deepEqual(Object.keys(body).sort(), ['error', 'ok', 'requestId']);
    assert.equal(body.ok, false);
    assert.equal(body.requestId, 'bad-json-request');
    assert.equal(body.error, '请求参数不合法。');
    assert.doesNotMatch(JSON.stringify(body), /SyntaxError|stack|Unexpected/i);
  } finally {
    await api.close();
  }
});

test('公开 API 遇到请求体过大时返回稳定 JSON', async () => {
  const api = await startServer();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'large-body-request' },
      body: JSON.stringify({ data: 'x'.repeat(11 * 1024 * 1024) }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 413);
    assert.deepEqual(Object.keys(body).sort(), ['error', 'ok', 'requestId']);
    assert.equal(body.ok, false);
    assert.equal(body.requestId, 'large-body-request');
    assert.equal(body.error, '请求体过大，请减少请求内容后重试。');
    assert.doesNotMatch(JSON.stringify(body), /PayloadTooLarge|entity.too.large|stack/i);
  } finally {
    await api.close();
  }
});

test('公开 API 内部异常只返回统一可读错误', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const api = await startServer(new FailingStorage());
  const originalConsoleError = console.error;
  const capturedLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    capturedLogs.push(args);
  };
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
    assert.equal(response.status, 500);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Docx 文档生成失败，请稍后重试。');
    assert.doesNotMatch(JSON.stringify(body), /private-secret|\/Users\/simba|stack/i);
    assert.equal(capturedLogs.length, 1);
  } finally {
    console.error = originalConsoleError;
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 遇到残留占位符时不生成半成品', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const api = await startServer(
    new FailingStorage(),
    '{{客</w:t></w:r></w:p><w:p><w:r><w:t>户名称}}',
  );
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: `${api.baseUrl}/template.docx` },
        variables: {},
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    // 新引擎对跨段落畸形占位符明确报"无法解析"错误（旧引擎报"残留占位符"）；两者都拒绝产出半成品
    assert.match(body.error, /无法解析|未替换的变量占位符/);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 Doc 预览遇到残留占位符时返回可读错误', async () => {
  const api = await startServer();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'doc',
          content: '客户：{{ }}',
        },
        variables: {},
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, '模板中仍有未替换的变量占位符，请检查模板。');
  } finally {
    await api.close();
  }
});
