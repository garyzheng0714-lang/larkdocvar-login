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

function withTemporaryEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

async function createLargeDocxBuffer(): Promise<Buffer> {
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
  zip.file('word/media/filler.bin', Buffer.alloc(19 * 1024 * 1024, 65));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

async function startApi(templateDocx: Buffer): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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

test('公开 API 支持接近 20MB 的合法 Docx 模板', async () => {
  const templateDocx = await createLargeDocxBuffer();
  assert.ok(templateDocx.length > 19 * 1024 * 1024);
  assert.ok(templateDocx.length < 20 * 1024 * 1024);
  const restorePrivateUrls = withTemporaryEnv('DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS', 'true');
  const api = await startApi(templateDocx);
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
    assert.equal(body.ok, true);
    assert.equal(body.document.previewText, '客户：上海测试科技有限公司');
    assert.equal(body.download.storage, 'local');
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});
