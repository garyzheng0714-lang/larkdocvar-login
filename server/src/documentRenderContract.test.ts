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

async function createDocx(): Promise<Buffer> {
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

async function startApi(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const templateDocx = await createDocx();
  const app = express();
  app.get('/template.docx', (_request, response) => {
    response.setHeader('Content-Type', DOCX_CONTENT_TYPE);
    response.send(templateDocx);
  });
  app.use('/api/v1/document-renders', createDocumentRenderRouter());
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => closeServer(server) };
}

function withTemporaryEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

test('Docx 成功响应字段契约保持稳定', async () => {
  const restorePrivateUrls = withTemporaryEnv('DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS', 'true');
  const api = await startApi();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'contract-test-request' },
      body: JSON.stringify({
        template: { format: 'docx', title: '合同模板', url: `${api.baseUrl}/template.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
        output: { expiresInSeconds: 3600 },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['document', 'download', 'format', 'ok', 'requestId', 'variables']);
    assert.equal(body.ok, true);
    assert.equal(body.requestId, 'contract-test-request');
    assert.equal(body.format, 'docx');
    assert.deepEqual(Object.keys(body.document).sort(), ['previewText', 'title']);
    assert.deepEqual(Object.keys(body.variables).sort(), ['found', 'missing', 'provided', 'unused']);
    assert.deepEqual(Object.keys(body.download).sort(), [
      'contentType',
      'createdAt',
      'expiresAt',
      'fileName',
      'path',
      'size',
      'storage',
      'url',
    ]);
    assert.equal(body.download.storage, 'local');
    assert.equal(body.download.contentType, DOCX_CONTENT_TYPE);
    assert.deepEqual(body.variables.missing, []);
    assert.deepEqual(body.variables.unused, []);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('Docx API 会清洗 requestId 中的异常字符', async () => {
  const restorePrivateUrls = withTemporaryEnv('DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS', 'true');
  const api = await startApi();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': '../bad request/id?' },
      body: JSON.stringify({
        template: { format: 'docx', title: '合同模板', url: `${api.baseUrl}/template.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.requestId, 'bad-request-id');
    assert.doesNotMatch(body.requestId, /[/?\s]/);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('Docx 缺失变量错误响应字段契约保持稳定', async () => {
  const restorePrivateUrls = withTemporaryEnv('DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS', 'true');
  const api = await startApi();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'missing-contract-request' },
      body: JSON.stringify({
        template: { format: 'docx', url: `${api.baseUrl}/template.docx` },
        variables: {},
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.deepEqual(Object.keys(body).sort(), ['error', 'missingVariables', 'ok', 'requestId']);
    assert.equal(body.ok, false);
    assert.equal(body.requestId, 'missing-contract-request');
    assert.deepEqual(body.missingVariables, ['客户名称']);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('Docx 未使用变量错误响应字段契约保持稳定', async () => {
  const restorePrivateUrls = withTemporaryEnv('DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS', 'true');
  const api = await startApi();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'unused-contract-request' },
      body: JSON.stringify({
        template: { format: 'docx', url: `${api.baseUrl}/template.docx` },
        variables: { 客户名称: '上海测试科技有限公司', 金额: '12800 元' },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.deepEqual(Object.keys(body).sort(), ['error', 'ok', 'requestId', 'unusedVariables']);
    assert.equal(body.ok, false);
    assert.equal(body.requestId, 'unused-contract-request');
    assert.deepEqual(body.unusedVariables, ['金额']);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});
