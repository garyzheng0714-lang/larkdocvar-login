import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import JSZip from 'jszip';

import { createDocumentRenderRouter } from './documentRenderApi';

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function createDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>金额：{{金额}}，确认：{{已确认}}，备注：{{备注}}</w:t></w:r></w:p></w:body>
</w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function enablePrivateTemplateUrlsForTest(): () => void {
  const previous = process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS;
  process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS = 'true';
  return () => {
    if (previous === undefined) delete process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS;
    else process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS = previous;
  };
}

test('公开 Docx API 支持数字、布尔值和 null 变量值', async () => {
  const templateDocx = await createDocx();
  const app = express();
  app.get('/template.docx', (_request, response) => {
    response.setHeader('Content-Type', DOCX_CONTENT_TYPE);
    response.send(templateDocx);
  });
  app.use('/api/v1/document-renders', createDocumentRenderRouter());
  const server = createServer(app);
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: `${baseUrl}/template.docx` },
        variables: { 金额: 12800, 已确认: true, 备注: null },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.deepEqual(body.variables.missing, []);
    assert.deepEqual(body.variables.unused, []);
    assert.equal(body.document.previewText, '金额：12800，确认：true，备注：');

    const downloadResponse = await fetch(new URL(body.download.url, baseUrl));
    const outputZip = await JSZip.loadAsync(Buffer.from(await downloadResponse.arrayBuffer()));
    const documentXml = await outputZip.file('word/document.xml')?.async('string');
    assert.match(documentXml || '', /金额：12800，确认：true，备注：/);
    assert.doesNotMatch(documentXml || '', /\{\{[^{}]+?\}\}/);
  } finally {
    restorePrivateUrls();
    await closeServer(server);
  }
});
