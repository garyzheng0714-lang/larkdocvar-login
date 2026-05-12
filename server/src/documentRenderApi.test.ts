import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import JSZip from 'jszip';

import { __test__, createDocumentRenderRouter, type DocumentRenderStorage, type SaveGeneratedDocxInput, type SavedGeneratedDocx } from './documentRenderApi';

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

class FakeOssStorage implements DocumentRenderStorage {
  readonly saves: SaveGeneratedDocxInput[] = [];

  async saveDocx(input: SaveGeneratedDocxInput): Promise<SavedGeneratedDocx> {
    this.saves.push(input);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
    return {
      url: `https://oss.example.test/${encodeURIComponent(input.fileName)}?ttl=${input.ttlSeconds}`,
      path: `document-renders/${input.requestId}.docx`,
      fileName: input.fileName,
      contentType: DOCX_CONTENT_TYPE,
      size: input.buffer.length,
      storage: 'oss',
      createdAt,
      expiresAt,
    };
  }
}

async function startApiServer(options: { templateDocx?: Buffer; storage?: DocumentRenderStorage } = {}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  if (options.templateDocx) {
    app.get('/template.docx', (_request, response) => {
      response.setHeader('Content-Type', DOCX_CONTENT_TYPE);
      response.send(options.templateDocx);
    });
  }
  app.use('/api/v1/document-renders', createDocumentRenderRouter({ storage: options.storage }));

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
    if (previous === undefined) {
      delete process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS;
    } else {
      process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS = previous;
    }
  };
}

function withTemporaryEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
}

async function createMinimalDocxBuffer(text: string): Promise<Buffer> {
  return createDocxBuffer({
    documentXml: text.split('\n').map((line) => {
      return `<w:p><w:r><w:t>${escapeXml(line)}</w:t></w:r></w:p>`;
    }).join(''),
  });
}

async function createDocxBuffer(input: {
  documentXml: string;
  headerXml?: string;
  footerXml?: string;
}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  ${input.headerXml ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}
  ${input.footerXml ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}
</Types>`);
  zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${input.documentXml}</w:body>
</w:document>`);
  if (input.headerXml || input.footerXml) {
    const relationships = [
      input.headerXml ? '<Relationship Id="rHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : '',
      input.footerXml ? '<Relationship Id="rFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : '',
    ].join('');
    zip.folder('word')?.folder('_rels')?.file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`);
  }
  if (input.headerXml) {
    zip.folder('word')?.file('header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${input.headerXml}</w:hdr>`);
  }
  if (input.footerXml) {
    zip.folder('word')?.file('footer1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${input.footerXml}</w:ftr>`);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function createSplitRunDocxBuffer(): Promise<Buffer> {
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
  <w:body>
    <w:p>
      <w:r><w:t>客户：</w:t></w:r>
      <w:r><w:t>{{客</w:t></w:r>
      <w:r><w:t>户名称}}</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test('公开 API 可以用变量填充 Doc 文本模板并返回前端可预览内容', async () => {
  const api = await startApiServer();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'doc',
          title: '合同模板',
          content: '客户：{{客户名称}}\n金额：{{金额}}\n联系人：{{ 联系人 }}',
        },
        variables: {
          客户名称: '上海测试科技有限公司',
          金额: '12800 元',
          联系人: '李雷',
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.ok, true);
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(body.format, 'doc');
    assert.equal(body.document.title, '合同模板');
    assert.equal(body.document.previewText, '客户：上海测试科技有限公司\n金额：12800 元\n联系人：李雷');
    assert.deepEqual(body.variables.found, ['客户名称', '金额', '联系人']);
    assert.deepEqual(body.variables.missing, []);
  } finally {
    await api.close();
  }
});

test('公开 API 可以通过文档链接上传 Docx 模板并返回可下载结果', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const templateDocx = await createMinimalDocxBuffer('客户：{{客户名称}}\n金额：{{金额}}');
  const api = await startApiServer({ templateDocx });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          title: '报价单模板',
          url: `${api.baseUrl}/template.docx`,
        },
        variables: {
          客户名称: '上海测试科技有限公司',
          金额: '12800 元',
        },
        output: {
          fileName: '报价单-上海测试科技有限公司.docx',
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.ok, true);
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(body.format, 'docx');
    assert.equal(body.document.previewText, '客户：上海测试科技有限公司\n金额：12800 元');
    assert.equal(body.download.fileName, '报价单-上海测试科技有限公司.docx');
    assert.equal(body.download.storage, 'local');
    assert.match(body.download.url, /^\/api\/v1\/document-renders\/downloads\/.+/);

    const downloadResponse = await fetch(new URL(body.download.url, api.baseUrl));
    assert.equal(downloadResponse.status, 200);
    assert.equal(
      downloadResponse.headers.get('content-type'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    const outputZip = await JSZip.loadAsync(Buffer.from(await downloadResponse.arrayBuffer()));
    const documentXml = await outputZip.file('word/document.xml')?.async('string');
    assert.ok(documentXml);
    assert.match(documentXml, /上海测试科技有限公司/);
    assert.match(documentXml, /12800 元/);
    assert.doesNotMatch(documentXml, /\{\{客户名称\}\}/);
    assert.doesNotMatch(documentXml, /\{\{金额\}\}/);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 遇到缺失变量时返回可读错误并列出变量名', async () => {
  const api = await startApiServer();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'doc',
          title: '合同模板',
          content: '客户：{{客户名称}}\n金额：{{金额}}',
        },
        variables: {
          客户名称: '上海测试科技有限公司',
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(body.error, '还有变量没有填写，请补齐后再生成。');
    assert.deepEqual(body.missingVariables, ['金额']);
  } finally {
    await api.close();
  }
});

test('公开 API 遇到未使用变量时返回可读错误并列出变量名', async () => {
  const api = await startApiServer();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'doc',
          title: '合同模板',
          content: '客户：{{客户名称}}',
        },
        variables: {
          客户名称: '上海测试科技有限公司',
          金额: '12800 元',
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.equal(body.error, '有变量没有出现在模板中，请检查变量名。');
    assert.deepEqual(body.unusedVariables, ['金额']);
  } finally {
    await api.close();
  }
});

test('公开 API 有 OSS 存储时上传 Docx 并返回 OSS 临时下载链接', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const templateDocx = await createMinimalDocxBuffer('客户：{{客户名称}}');
  const storage = new FakeOssStorage();
  const api = await startApiServer({ templateDocx, storage });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          title: '报价单模板',
          url: `${api.baseUrl}/template.docx`,
        },
        variables: {
          客户名称: '上海测试科技有限公司',
        },
        output: {
          fileName: '报价单.docx',
          expiresInSeconds: 24 * 60 * 60,
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.ok, true);
    assert.equal(body.download.storage, 'oss');
    assert.match(body.download.url, /^https:\/\/oss\.example\.test\//);
    assert.equal(body.download.fileName, '报价单.docx');
    assert.equal(storage.saves.length, 1);
    assert.equal(storage.saves[0]?.ttlSeconds, 24 * 60 * 60);
    assert.equal(storage.saves[0]?.requestId, body.requestId);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 有 TOS 配置时上传 Docx 并返回 TOS 临时下载链接', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const restorers = [
    withTemporaryEnv('DOCUMENT_RENDER_STORAGE_PROVIDER', 'tos'),
    withTemporaryEnv('TOS_ACCESS_KEY', 'tos-ak'),
    withTemporaryEnv('TOS_SECRET_KEY', 'tos-secret'),
    withTemporaryEnv('TOS_BUCKET', 'tos-bucket'),
    withTemporaryEnv('TOS_REGION', 'cn-beijing'),
    withTemporaryEnv('TOS_ENDPOINT', 'tos-cn-beijing.volces.com'),
  ];
  const templateDocx = await createMinimalDocxBuffer('客户：{{客户名称}}');
  const api = await startApiServer({ templateDocx });
  try {
    const response = await previousFetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', title: '报价单模板', url: `${api.baseUrl}/template.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
        output: { expiresInSeconds: 3600 },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.download.storage, 'tos');
    assert.match(body.download.url, /^https:\/\/tos-bucket\.tos-cn-beijing\.volces\.com\//);
    assert.match(body.download.url, /X-Tos-Algorithm=TOS4-HMAC-SHA256/);
  } finally {
    await api.close();
    for (const restore of restorers.reverse()) restore();
    restorePrivateUrls();
    globalThis.fetch = previousFetch;
  }
});

test('公开 API 遇到 OSS 上传失败时返回可读错误且不降级 local', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const templateDocx = await createMinimalDocxBuffer('客户：{{客户名称}}');
  const storage = new __test__.OssDocumentRenderStorage({
    put: async () => {
      throw new Error('disabled access key');
    },
    signatureUrl: () => 'https://oss.example.test/should-not-happen.docx',
  }, 'document-renders/');
  const api = await startApiServer({ templateDocx, storage });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          title: '报价单模板',
          url: `${api.baseUrl}/template.docx`,
        },
        variables: {
          客户名称: '上海测试科技有限公司',
        },
        output: {
          fileName: '报价单.docx',
        },
      }),
    });

    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, '生成文件上传 OSS 失败，请检查 OSS 配置和权限。');
    assert.equal(body.download, undefined);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 遇到 Docx 未使用变量时不上传半成品', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const storage = new FakeOssStorage();
  const api = await startApiServer({
    templateDocx: await createMinimalDocxBuffer('客户：{{客户名称}}'),
    storage,
  });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          url: `${api.baseUrl}/template.docx`,
        },
        variables: {
          客户名称: '上海测试科技有限公司',
          金额: '12800 元',
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.deepEqual(body.unusedVariables, ['金额']);
    assert.equal(storage.saves.length, 0);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 遇到不完整 OSS 配置时不降级成本地存储', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const restoreBucket = withTemporaryEnv('DOCUMENT_RENDER_OSS_BUCKET', 'example-bucket');
  const templateDocx = await createMinimalDocxBuffer('客户：{{客户名称}}');
  const api = await startApiServer({ templateDocx });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', title: '报价单模板', url: `${api.baseUrl}/template.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.equal(body.error, 'OSS 配置不完整，请检查 AccessKey、Bucket 和 Region。');
  } finally {
    restoreBucket();
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 遇到不完整 TOS 配置时不降级成本地存储', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const restoreTos = withTemporaryEnv('TOS_ACCESS_KEY', 'tos-ak');
  const templateDocx = await createMinimalDocxBuffer('客户：{{客户名称}}');
  const api = await startApiServer({ templateDocx });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', title: '报价单模板', url: `${api.baseUrl}/template.docx` },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.equal(body.error, 'TOS 配置不完整，请检查 AccessKey、Bucket 和 Region。');
  } finally {
    restoreTos();
    restorePrivateUrls();
    await api.close();
  }
});

test('生产环境没有 OSS 配置时不降级成本地存储', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const restoreNodeEnv = withTemporaryEnv('NODE_ENV', 'production');
  const templateDocx = await createMinimalDocxBuffer('客户：{{客户名称}}');
  const api = await startApiServer({ templateDocx });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          title: '报价单模板',
          url: `${api.baseUrl}/template.docx`,
        },
        variables: {
          客户名称: '上海测试科技有限公司',
        },
      }),
    });

    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, '生产环境必须配置 OSS，不能使用本地临时下载链接。');
  } finally {
    restoreNodeEnv();
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 遇到 Docx 缺失变量时不上传半成品', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const storage = new FakeOssStorage();
  const api = await startApiServer({
    templateDocx: await createMinimalDocxBuffer('客户：{{客户名称}}\n金额：{{金额}}'),
    storage,
  });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          url: `${api.baseUrl}/template.docx`,
        },
        variables: {
          客户名称: '上海测试科技有限公司',
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.deepEqual(body.missingVariables, ['金额']);
    assert.equal(storage.saves.length, 0);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 将空字符串按已填写变量处理', async () => {
  const api = await startApiServer();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'doc',
          content: '客户：{{客户名称}}\n备注：{{备注}}',
        },
        variables: {
          客户名称: '上海测试科技有限公司',
          备注: '',
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.ok, true);
    assert.equal(body.document.previewText, '客户：上海测试科技有限公司\n备注：');
    assert.deepEqual(body.variables.missing, []);
  } finally {
    await api.close();
  }
});

test('公开 API 遇到损坏 Docx 模板时返回可读错误', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const api = await startApiServer({ templateDocx: Buffer.from('这不是一个 zip 文件') });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          url: `${api.baseUrl}/template.docx`,
        },
        variables: {
          客户名称: '上海测试科技有限公司',
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Docx 模板文件损坏或格式不支持。');
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 拒绝伪装成 Docx 的普通 zip 文件', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const fakeDocx = new JSZip();
  fakeDocx.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  fakeDocx.folder('word')?.file('document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{客户名称}}</w:t></w:r></w:p></w:body></w:document>');
  const api = await startApiServer({ templateDocx: await fakeDocx.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          url: `${api.baseUrl}/template.docx`,
        },
        variables: {
          客户名称: '上海测试科技有限公司',
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Docx 模板缺少必要的 Word 文档结构。');
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 拒绝缺少主文档关系的伪装 Docx', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const fakeDocx = new JSZip();
  fakeDocx.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  fakeDocx.folder('word')?.file('document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{客户名称}}</w:t></w:r></w:p></w:body></w:document>');
  const api = await startApiServer({ templateDocx: await fakeDocx.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) });
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
    assert.equal(body.error, 'Docx 模板缺少必要的 Word 文档结构。');
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 遇到不可访问 Docx 模板链接时返回可读错误', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const api = await startApiServer();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          url: `${api.baseUrl}/missing.docx`,
        },
        variables: {
          客户名称: '上海测试科技有限公司',
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Docx 模板链接无法访问，请检查链接是否正确。');
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 可以替换 Docx 中跨文本节点的变量', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const api = await startApiServer({ templateDocx: await createSplitRunDocxBuffer() });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          url: `${api.baseUrl}/template.docx`,
        },
        variables: {
          客户名称: '上海测试科技有限公司',
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.document.previewText, '客户：上海测试科技有限公司');

    const downloadResponse = await fetch(new URL(body.download.url, api.baseUrl));
    assert.equal(downloadResponse.status, 200);
    const outputZip = await JSZip.loadAsync(Buffer.from(await downloadResponse.arrayBuffer()));
    const documentXml = await outputZip.file('word/document.xml')?.async('string');
    assert.ok(documentXml);
    assert.match(documentXml, /上海测试科技有限公司/);
    assert.doesNotMatch(documentXml, /\{\{客/);
    assert.doesNotMatch(documentXml, /户名称\}\}/);
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('Docx 替换覆盖正文、表格、页眉和页脚', async () => {
  const templateDocx = await createDocxBuffer({
    documentXml: `
      <w:sectPr>
        <w:headerReference w:type="default" r:id="rHeader1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
        <w:footerReference w:type="default" r:id="rFooter1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
      </w:sectPr>
      <w:p><w:r><w:rPr><w:rFonts w:ascii="SimSun" w:eastAsia="SimSun"/><w:b/><w:color w:val="FF0000"/><w:sz w:val="28"/></w:rPr><w:t>正文：{{客户名称}}</w:t></w:r></w:p>
      <w:tbl>
        <w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>
        <w:tr>
          <w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>{{金额}}</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>`,
    headerXml: '<w:p><w:r><w:t>页眉：{{客户名称}}</w:t></w:r></w:p>',
    footerXml: '<w:p><w:r><w:t>页脚：{{日期}}</w:t></w:r></w:p>',
  });

  const rendered = await __test__.renderDocx(templateDocx, {
    客户名称: '上海测试科技有限公司',
    金额: '12800 元',
    日期: '2026-05-12',
  });

  assert.deepEqual(rendered.missing, []);
  const outputZip = await JSZip.loadAsync(rendered.buffer);
  const documentXml = await outputZip.file('word/document.xml')?.async('string');
  const headerXml = await outputZip.file('word/header1.xml')?.async('string');
  const footerXml = await outputZip.file('word/footer1.xml')?.async('string');
  assert.match(documentXml || '', /上海测试科技有限公司/);
  assert.match(documentXml || '', /12800 元/);
  assert.match(headerXml || '', /上海测试科技有限公司/);
  assert.match(footerXml || '', /2026-05-12/);
  assert.match(documentXml || '', /<w:rFonts w:ascii="SimSun" w:eastAsia="SimSun"\/>[\s\S]*<w:b\/>/);
  assert.match(documentXml || '', /<w:color w:val="FF0000"\/>/);
  assert.match(documentXml || '', /<w:sz w:val="28"\/>/);
  assert.match(documentXml || '', /<w:tblBorders>/);
  assert.doesNotMatch(`${documentXml}${headerXml}${footerXml}`, /\{\{/);
});

test('Docx 替换同一变量多次出现时全部替换', async () => {
  const rendered = await __test__.renderDocx(await createMinimalDocxBuffer('{{客户名称}} / {{客户名称}} / {{客户名称}}'), {
    客户名称: '上海测试科技有限公司',
  });

  const outputZip = await JSZip.loadAsync(rendered.buffer);
  const documentXml = await outputZip.file('word/document.xml')?.async('string');
  assert.equal((documentXml?.match(/上海测试科技有限公司/g) || []).length, 3);
  assert.doesNotMatch(documentXml || '', /\{\{客户名称\}\}/);
});

test('Docx 回归模板库至少覆盖 20 种结构且全部不残留变量', async () => {
  const templates = [
    { name: '合同-基础段落', documentXml: '<w:p><w:r><w:t>甲方：{{客户名称}}</w:t></w:r></w:p><w:p><w:r><w:t>金额：{{金额}}</w:t></w:r></w:p>' },
    { name: '合同-加粗标题', documentXml: '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>{{项目名称}} 服务合同</w:t></w:r></w:p><w:p><w:r><w:t>{{日期}}</w:t></w:r></w:p>' },
    { name: '报价单-双列表格', documentXml: '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>客户</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>{{客户名称}}</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>{{金额}}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' },
    { name: '报价单-带边框表格', documentXml: '<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single"/></w:tblBorders></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>{{项目名称}}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>{{金额}}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' },
    { name: '邀请函-居中文案', documentXml: '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>邀请 {{客户名称}} 参加 {{项目名称}}</w:t></w:r></w:p><w:p><w:r><w:t>日期：{{日期}}</w:t></w:r></w:p>' },
    { name: '通知-编号列表', documentXml: '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>{{客户名称}}</w:t></w:r></w:p><w:p><w:r><w:t>{{金额}}</w:t></w:r></w:p>' },
    { name: '页眉页脚-全局变量', documentXml: '<w:p><w:r><w:t>正文项目：{{项目名称}}</w:t></w:r></w:p>', headerXml: '<w:p><w:r><w:t>客户：{{客户名称}}</w:t></w:r></w:p>', footerXml: '<w:p><w:r><w:t>日期：{{日期}}</w:t></w:r></w:p>' },
    { name: '页眉-拆分变量', documentXml: '<w:p><w:r><w:t>金额：{{金额}}</w:t></w:r></w:p>', headerXml: '<w:p><w:r><w:t>{{客</w:t></w:r><w:r><w:t>户名称}}</w:t></w:r></w:p>' },
    { name: '页脚-多变量', documentXml: '<w:p><w:r><w:t>项目：{{项目名称}}</w:t></w:r></w:p>', footerXml: '<w:p><w:r><w:t>{{客户名称}} / {{日期}}</w:t></w:r></w:p>' },
    { name: '正文-同段多变量', documentXml: '<w:p><w:r><w:t>{{客户名称}} 在 {{日期}} 支付 {{金额}}</w:t></w:r></w:p>' },
    { name: '正文-同变量重复', documentXml: '<w:p><w:r><w:t>{{客户名称}}、{{客户名称}}、{{客户名称}}</w:t></w:r></w:p>' },
    { name: '正文-变量含空格', documentXml: '<w:p><w:r><w:t>客户：{{ 客户名称 }}</w:t></w:r></w:p><w:p><w:r><w:t>金额：{{ 金额 }}</w:t></w:r></w:p>' },
    { name: '正文-特殊字符样式', documentXml: '<w:p><w:r><w:rPr><w:color w:val="00AA00"/></w:rPr><w:t>{{客户名称}}</w:t></w:r><w:r><w:t> - {{项目名称}}</w:t></w:r></w:p>' },
    { name: '表格-三列表头', documentXml: '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>客户</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>{{客户名称}}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>{{项目名称}}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>{{金额}}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' },
    { name: '表格-单元格多段落', documentXml: '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>{{客户名称}}</w:t></w:r></w:p><w:p><w:r><w:t>{{项目名称}}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>{{金额}}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' },
    { name: '段落-拆分文本节点', documentXml: '<w:p><w:r><w:t>{{项</w:t></w:r><w:r><w:t>目名称}}</w:t></w:r><w:r><w:t> / {{金额}}</w:t></w:r></w:p>' },
    { name: '段落-日期字段', documentXml: '<w:p><w:r><w:t>签署日期：{{日期}}</w:t></w:r></w:p><w:p><w:r><w:t>客户：{{客户名称}}</w:t></w:r></w:p>' },
    { name: '确认函-混合表格页脚', documentXml: '<w:p><w:r><w:t>确认函：{{客户名称}}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>{{项目名称}}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>', footerXml: '<w:p><w:r><w:t>{{金额}} / {{日期}}</w:t></w:r></w:p>' },
    { name: '报价单-页眉表格', documentXml: '<w:p><w:r><w:t>报价金额：{{金额}}</w:t></w:r></w:p>', headerXml: '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>{{客户名称}}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>{{项目名称}}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' },
    { name: '验收单-完整混合', documentXml: '<w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>{{项目名称}} 验收单</w:t></w:r></w:p><w:p><w:r><w:t>{{客户名称}}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>{{金额}}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>', headerXml: '<w:p><w:r><w:t>验收</w:t></w:r></w:p>', footerXml: '<w:p><w:r><w:t>{{日期}}</w:t></w:r></w:p>' },
  ];

  assert.equal(templates.length, 20);
  const buffers = await Promise.all(templates.map((template) => createDocxBuffer(template)));
  for (const [index, buffer] of buffers.entries()) {
    const template = templates[index];
    const rendered = await __test__.renderDocx(buffer, {
      客户名称: `客户${index + 1}`,
      金额: `${1000 + index} 元`,
      日期: '2026-05-12',
      项目名称: `项目${index + 1}`,
    });
    assert.deepEqual(rendered.missing, [], template.name);
    const outputZip = await JSZip.loadAsync(rendered.buffer);
    const xml = await Promise.all(Object.keys(outputZip.files)
      .filter((name) => name.startsWith('word/') && name.endsWith('.xml'))
      .map((name) => outputZip.file(name)?.async('string') || ''));
    assert.doesNotMatch(xml.join('\n'), /\{\{[^{}]+?\}\}/, template.name);
  }
});

test('公开 API 拒绝非 HTTPS Docx 模板链接，除非显式开启本地实验', async () => {
  const api = await startApiServer();
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          url: 'http://example.com/template.docx',
        },
        variables: {
          客户名称: '上海测试科技有限公司',
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Docx 模板链接默认只允许 HTTPS。');
  } finally {
    await api.close();
  }
});

test('公开 API 拒绝解压后体积异常的 Docx 模板', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const restoreMaxUnzipped = withTemporaryEnv('DOCUMENT_RENDER_MAX_UNZIPPED_BYTES', '1024');
  const api = await startApiServer({ templateDocx: await createMinimalDocxBuffer(`客户：{{客户名称}}\n${'A'.repeat(4096)}`) });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          url: `${api.baseUrl}/template.docx`,
        },
        variables: {
          客户名称: '上海测试科技有限公司',
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Docx 模板文件体积异常，已拒绝处理。');
  } finally {
    restoreMaxUnzipped();
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 拒绝超过 20MB 的 Docx 模板下载', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const oversizedDocx = Buffer.concat([
    Buffer.from('PK'),
    Buffer.alloc(20 * 1024 * 1024),
  ]);
  const api = await startApiServer({ templateDocx: oversizedDocx });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          url: `${api.baseUrl}/template.docx`,
        },
        variables: {
          客户名称: '上海测试科技有限公司',
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Docx 模板不能超过 20MB。');
  } finally {
    restorePrivateUrls();
    await api.close();
  }
});

test('公开 API 的本地 Docx 下载链接过期后不可继续访问', async () => {
  const restorePrivateUrls = enablePrivateTemplateUrlsForTest();
  const restoreTtl = withTemporaryEnv('DOCUMENT_RENDER_DOWNLOAD_TTL_MS', '1');
  const api = await startApiServer({ templateDocx: await createMinimalDocxBuffer('客户：{{客户名称}}') });
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: {
          format: 'docx',
          url: `${api.baseUrl}/template.docx`,
        },
        variables: {
          客户名称: '上海测试科技有限公司',
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.match(body.download.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const downloadResponse = await fetch(new URL(body.download.url, api.baseUrl));
    assert.equal(downloadResponse.status, 404);
  } finally {
    restoreTtl();
    restorePrivateUrls();
    await api.close();
  }
});
