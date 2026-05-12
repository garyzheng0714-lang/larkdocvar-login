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

class CaptureStorage implements DocumentRenderStorage {
  readonly saves: SaveGeneratedDocxInput[] = [];

  async saveDocx(input: SaveGeneratedDocxInput): Promise<SavedGeneratedDocx> {
    this.saves.push(input);
    return {
      url: '/download.docx',
      path: '/download.docx',
      fileName: input.fileName,
      contentType: DOCX_CONTENT_TYPE,
      size: input.buffer.length,
      storage: 'local',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
    };
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function createHeaderFooterDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.folder('_rels')?.file('document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>');
  zip.folder('word')?.file('document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>正文：{{客户名称}}</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rHeader1"/><w:footerReference w:type="default" r:id="rFooter1"/></w:sectPr></w:body></w:document>');
  zip.folder('word')?.file('header1.xml', '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页眉：{{页眉编号}}</w:t></w:r></w:p></w:hdr>');
  zip.folder('word')?.file('footer1.xml', '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页脚：{{页脚日期}}</w:t></w:r></w:p></w:ftr>');
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

test('公开 API 遇到页眉页脚缺失变量时不上传半成品', async () => {
  const storage = new CaptureStorage();
  const templateDocx = await createHeaderFooterDocx();
  const app = express();
  app.get('/template.docx', (_request, response) => {
    response.setHeader('Content-Type', DOCX_CONTENT_TYPE);
    response.send(templateDocx);
  });
  app.use('/api/v1/document-renders', createDocumentRenderRouter({ storage }));
  const server = createServer(app);
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo | null;
  assert.ok(address);

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: `http://127.0.0.1:${address.port}/template.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.deepEqual(body.missingVariables.sort(), ['页眉编号', '页脚日期'].sort());
    assert.equal(storage.saves.length, 0);
  } finally {
    restorePrivateUrls();
    await closeServer(server);
  }
});
