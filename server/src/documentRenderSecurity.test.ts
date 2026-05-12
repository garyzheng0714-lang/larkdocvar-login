import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import JSZip from 'jszip';

import { __test__, createDocumentRenderRouter } from './documentRenderApi';

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

function enablePrivateTemplateUrlsForTest(): () => void {
  const previous = process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS;
  process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS = 'true';
  return () => {
    if (previous === undefined) delete process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS;
    else process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS = previous;
  };
}

function withTemporaryEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

async function startDocxServer(templateDocx: Buffer): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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

test('公开 API 将 __proto__ 变量名按普通字段安全替换', async () => {
  const api = await startDocxServer(await createMinimalDocxBuffer('字段：{{__proto__}}'));
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{
        "template": { "format": "docx", "url": "${api.baseUrl}/template.docx" },
        "variables": { "__proto__": "安全值" }
      }`,
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.document.previewText, '字段：安全值');
    assert.deepEqual(body.variables.found, ['__proto__']);
    assert.deepEqual(body.variables.provided, ['__proto__']);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('OSS 对象前缀会清洗路径穿越片段和反斜杠', () => {
  assert.equal(__test__.normalizeOssPrefix('../合同\\2026/./../报价'), '合同/2026/报价/');
  assert.equal(__test__.normalizeOssPrefix('/.././'), '');
});

test('模板链接安全检查会识别 IPv6 映射的本机和云元数据地址', () => {
  assert.equal(__test__.isBlockedIpAddress('0:0:0:0:0:ffff:7f00:1'), true);
  assert.equal(__test__.isBlockedIpAddress('0:0:0:0:0:ffff:a9fe:a9fe'), true);
  assert.equal(__test__.isBlockedIpAddress('::ffff:127.0.0.1'), true);
  assert.equal(__test__.isBlockedIpAddress('::ffff:169.254.169.254'), true);
});

test('模板链接安全检查覆盖常见内网和保留地址段', () => {
  for (const address of [
    '0.0.0.1',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '::1',
    '0:0:0:0:0:0:0:0',
    '0:0:0:0:0:0:0:1',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2001:0db8::1',
  ]) {
    assert.equal(__test__.isBlockedIpAddress(address), true, address);
  }
  assert.equal(__test__.isBlockedIpAddress('8.8.8.8'), false);
  assert.equal(__test__.isBlockedIpAddress('2606:4700:4700::1111'), false);
});

test('模板链接 URL 校验会拒绝 HTTPS 云元数据地址', async () => {
  await assert.rejects(
    __test__.validateTemplateUrl('https://169.254.169.254/latest/meta-data/'),
    /模板链接不能指向内网或本机地址/,
  );
});

test('模板链接 URL 校验会拒绝非标准编码的内网地址', async () => {
  for (const url of [
    'https://2130706433/template.docx',
    'https://0x7f000001/template.docx',
    'https://0177.0.0.1/template.docx',
    'https://2852039166/latest/meta-data/',
  ]) {
    await assert.rejects(
      __test__.validateTemplateUrl(url),
      /模板链接不能指向内网或本机地址/,
      url,
    );
  }
});

test('模板链接固定 DNS lookup 会绑定校验时的域名', async () => {
  const lookup = __test__.createFixedLookup('example.com', [{ address: '203.0.113.10', family: 4 }]);
  const error = await new Promise<Error | null>((resolve) => {
    lookup('other.example.com', {}, (lookupError) => resolve(lookupError as Error | null));
  });
  assert.match(error?.message || '', /域名与校验域名不一致/);
});

test('公开 API 拒绝包含用户名或密码的模板链接', async () => {
  const app = express();
  app.use('/api/v1/document-renders', createDocumentRenderRouter());
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: 'https://user:pass@example.com/template.docx' },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, '模板链接不能包含用户名或密码。');
  } finally {
    await closeServer(server);
  }
});

test('公开 API 拒绝非 HTTP 或 HTTPS 的模板链接协议', async () => {
  const app = express();
  app.use('/api/v1/document-renders', createDocumentRenderRouter());
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: 'file:///etc/passwd' },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, '模板链接只支持 HTTP 或 HTTPS。');
  } finally {
    await closeServer(server);
  }
});

test('公开 API 拒绝 zip 条目数量异常的 Docx 模板', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('word')?.file('document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{客户名称}}</w:t></w:r></w:p></w:body></w:document>');
  for (let index = 0; index < 8; index += 1) {
    zip.file(`extra-${index}.xml`, '<x/>');
  }
  const api = await startDocxServer(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const restoreMaxZipEntries = withTemporaryEnv('DOCUMENT_RENDER_MAX_ZIP_ENTRIES', '5');
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
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Docx 模板文件体积异常，已拒绝处理。');
  } finally {
    restoreMaxZipEntries();
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 在显式本地实验下支持模板链接重定向', async () => {
  const app = express();
  app.get('/redirect.docx', (_request, response) => response.redirect('/template.docx'));
  app.get('/template.docx', (_request, response) => {
    response.setHeader('Content-Type', DOCX_CONTENT_TYPE);
    response.send(templateDocx);
  });
  app.use('/api/v1/document-renders', createDocumentRenderRouter());

  const templateDocx = await createMinimalDocxBuffer('客户：{{客户名称}}');
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();

  try {
    const response = await fetch(`${baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: `${baseUrl}/redirect.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.document.previewText, '客户：上海测试科技有限公司');
  } finally {
    restorePrivateUrls();
    await closeServer(server);
  }
});

test('公开 API 遇到模板链接重定向次数过多时返回可读错误', async () => {
  const app = express();
  app.get('/loop-a.docx', (_request, response) => response.redirect('/loop-b.docx'));
  app.get('/loop-b.docx', (_request, response) => response.redirect('/loop-a.docx'));
  app.use('/api/v1/document-renders', createDocumentRenderRouter());

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();

  try {
    const response = await fetch(`${baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: `${baseUrl}/loop-a.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, '模板链接重定向次数过多。');
  } finally {
    restorePrivateUrls();
    await closeServer(server);
  }
});

test('公开 API 遇到模板链接重定向缺少目标地址时返回可读错误', async () => {
  const app = express();
  app.get('/empty-redirect.docx', (_request, response) => response.status(302).end());
  app.use('/api/v1/document-renders', createDocumentRenderRouter());

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();

  try {
    const response = await fetch(`${baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: `${baseUrl}/empty-redirect.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, '模板链接重定向缺少目标地址。');
  } finally {
    restorePrivateUrls();
    await closeServer(server);
  }
});

test('公开 API 会重新校验模板重定向目标协议', async () => {
  const app = express();
  app.get('/redirect-to-file.docx', (_request, response) => response.redirect('file:///etc/passwd'));
  app.use('/api/v1/document-renders', createDocumentRenderRouter());

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();

  try {
    const response = await fetch(`${baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', url: `${baseUrl}/redirect-to-file.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, '模板链接只支持 HTTP 或 HTTPS。');
  } finally {
    restorePrivateUrls();
    await closeServer(server);
  }
});
