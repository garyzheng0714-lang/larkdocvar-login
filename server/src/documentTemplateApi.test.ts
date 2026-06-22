import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { createDocumentRenderRouter } from './documentRenderApi';
import { createDocumentTemplateRouter } from './documentTemplateApi';
import { DocumentTemplateService } from './documentTemplateService';
import { LocalTemplateObjectStore } from './documentTemplateStorage';

async function createDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function startServer(options: { enforceOwnership?: boolean } = {}): Promise<{ baseUrl: string; close: () => Promise<void>; hits: Record<string, number> }> {
  const dir = await mkdtemp(join(tmpdir(), 'document-template-api-'));
  const service = new DocumentTemplateService(new LocalTemplateObjectStore(dir));
  const app = express();
  const hits: Record<string, number> = { v1: 0, v2: 0 };
  const v1 = await createDocx('客户：{{客户名称}}');
  const v2 = await createDocx('金额：{{金额}}');
  app.get('/template-v1.docx', (_request, response) => {
    hits.v1 += 1;
    response.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(v1);
  });
  app.get('/template-v2.docx', (_request, response) => {
    hits.v2 += 1;
    response.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(v2);
  });
  app.use('/api/v1/document-templates', createDocumentTemplateRouter(service, options.enforceOwnership ? {
    enforceOwnership: true,
    resolveActor: async (request) => ({
      openId: typeof request.headers['x-test-open-id'] === 'string' ? request.headers['x-test-open-id'] : undefined,
      isAdmin: request.headers['x-test-admin'] === 'true',
    }),
  } : undefined));
  app.use('/api/v1/document-renders', createDocumentRenderRouter({ templateResolver: service, storageDir: dir }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function withPrivateTemplateUrls(): () => void {
  const previous = process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS;
  process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS = 'true';
  return () => {
    if (previous === undefined) delete process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS;
    else process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS = previous;
  };
}

test('模板上传后返回指定模板编号，后续按 templateId 生成且不再下载原始链接', async () => {
  const restore = withPrivateTemplateUrls();
  const api = await startServer();
  try {
    const createResponse = await fetch(`${api.baseUrl}/api/v1/document-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'fbiftemp_20260512_001',
        name: '通用合同模板',
        url: `${api.baseUrl}/template-v1.docx`,
      }),
    });
    const created = await createResponse.json() as any;
    assert.equal(createResponse.status, 200);
    assert.equal(created.template.templateId, 'fbiftemp_20260512_001');
    assert.equal(created.template.activeVersionId, 'fbiftemp_20260512_001_v001');
    assert.deepEqual(created.template.versions[0].variables, ['客户名称']);
    assert.equal(created.template.versions[0].thumbnail.kind, 'docx-outline');
    assert.deepEqual(created.template.versions[0].thumbnail.lines, [
      { text: '客户：客户名称', role: 'title' },
    ]);
    assert.equal(JSON.stringify(created.template.versions[0].thumbnail).includes('{{'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(created.template.versions[0], 'sourceUrl'), false);
    assert.equal(api.hits.v1, 1);

    const listResponse = await fetch(`${api.baseUrl}/api/v1/document-templates`);
    const list = await listResponse.json() as any;
    assert.equal(listResponse.status, 200);
    assert.equal(list.templates.length, 1);
    assert.equal(list.templates[0].templateId, 'fbiftemp_20260512_001');
    assert.equal(list.templates[0].versionCount, 1);
    assert.deepEqual(list.templates[0].variables, ['客户名称']);
    assert.deepEqual(list.templates[0].thumbnail.variableNames, ['客户名称']);

    const renderResponse = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', templateId: 'fbiftemp_20260512_001' },
        variables: { 客户名称: '上海测试科技有限公司' },
      }),
    });
    const rendered = await renderResponse.json() as any;
    assert.equal(renderResponse.status, 200);
    assert.equal(rendered.document.title, '通用合同模板');
    assert.equal(rendered.document.previewText, '客户：上海测试科技有限公司');
    assert.equal(api.hits.v1, 1);
  } finally {
    restore();
    await api.close();
  }
});

test('未指定模板编号时按现有序号递增生成简短模板 ID', async () => {
  const restore = withPrivateTemplateUrls();
  const api = await startServer();
  try {
    const firstResponse = await fetch(`${api.baseUrl}/api/v1/document-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '第一个自动编号模板',
        url: `${api.baseUrl}/template-v1.docx`,
      }),
    });
    const first = await firstResponse.json() as any;
    assert.equal(firstResponse.status, 200);
    assert.equal(first.template.templateId, 'tpl_001');
    assert.equal(first.template.activeVersionId, 'tpl_001_v001');

    const secondResponse = await fetch(`${api.baseUrl}/api/v1/document-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '第二个自动编号模板',
        url: `${api.baseUrl}/template-v2.docx`,
      }),
    });
    const second = await secondResponse.json() as any;
    assert.equal(secondResponse.status, 200);
    assert.equal(second.template.templateId, 'tpl_002');
    assert.equal(second.template.activeVersionId, 'tpl_002_v001');
  } finally {
    restore();
    await api.close();
  }
});

test('模板可直接上传文件内容创建并返回真实变量', async () => {
  const api = await startServer();
  try {
    const docx = await createDocx('客户：{{客户名称}}');
    const response = await fetch(`${api.baseUrl}/api/v1/document-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'upload_tpl_001',
        name: '上传模板',
        fileName: '上传模板.docx',
        fileBase64: docx.toString('base64'),
        category: '合同',
        visibility: 'private',
        description: '用于上传链路验证',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.template.templateId, 'upload_tpl_001');
    assert.equal(body.template.category, '合同');
    assert.equal(body.template.visibility, 'private');
    assert.deepEqual(body.template.versions[0].variables, ['客户名称']);
  } finally {
    await api.close();
  }
});

test('模板新增版本时允许清空已有说明', async () => {
  const restore = withPrivateTemplateUrls();
  const api = await startServer();
  try {
    await fetch(`${api.baseUrl}/api/v1/document-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'desc_clear_tpl_001',
        name: '带说明模板',
        description: '旧说明',
        url: `${api.baseUrl}/template-v1.docx`,
      }),
    });

    const response = await fetch(`${api.baseUrl}/api/v1/document-templates/desc_clear_tpl_001/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: '',
        url: `${api.baseUrl}/template-v2.docx`,
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.template.description, undefined);
  } finally {
    restore();
    await api.close();
  }
});

test('非管理员只能修改或删除自己创建的模板', async () => {
  const restore = withPrivateTemplateUrls();
  const api = await startServer({ enforceOwnership: true });
  try {
    const anonymousCreate = await fetch(`${api.baseUrl}/api/v1/document-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'owner_tpl_001',
        name: '权限模板',
        url: `${api.baseUrl}/template-v1.docx`,
      }),
    });
    assert.equal(anonymousCreate.status, 401);

    const createResponse = await fetch(`${api.baseUrl}/api/v1/document-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-open-id': 'ou_owner' },
      body: JSON.stringify({
        templateId: 'owner_tpl_001',
        name: '权限模板',
        url: `${api.baseUrl}/template-v1.docx`,
      }),
    });
    const created = await createResponse.json() as any;
    assert.equal(createResponse.status, 200);
    assert.equal(created.template.createdByOpenId, 'ou_owner');

    const otherVersion = await fetch(`${api.baseUrl}/api/v1/document-templates/owner_tpl_001/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-open-id': 'ou_other' },
      body: JSON.stringify({ url: `${api.baseUrl}/template-v2.docx` }),
    });
    assert.equal(otherVersion.status, 403);

    const ownerVersion = await fetch(`${api.baseUrl}/api/v1/document-templates/owner_tpl_001/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-open-id': 'ou_owner' },
      body: JSON.stringify({ url: `${api.baseUrl}/template-v2.docx` }),
    });
    assert.equal(ownerVersion.status, 200);

    const otherDelete = await fetch(`${api.baseUrl}/api/v1/document-templates/owner_tpl_001`, {
      method: 'DELETE',
      headers: { 'x-test-open-id': 'ou_other' },
    });
    assert.equal(otherDelete.status, 403);

    const adminDelete = await fetch(`${api.baseUrl}/api/v1/document-templates/owner_tpl_001`, {
      method: 'DELETE',
      headers: { 'x-test-admin': 'true' },
    });
    assert.equal(adminDelete.status, 200);
  } finally {
    restore();
    await api.close();
  }
});

test('并发新增版本不会复用版本号或覆盖版本列表', async () => {
  const restore = withPrivateTemplateUrls();
  const api = await startServer();
  try {
    await fetch(`${api.baseUrl}/api/v1/document-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'concurrent_tpl_001',
        name: '并发模板',
        url: `${api.baseUrl}/template-v1.docx`,
      }),
    });
    const [first, second] = await Promise.all([
      fetch(`${api.baseUrl}/api/v1/document-templates/concurrent_tpl_001/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `${api.baseUrl}/template-v2.docx` }),
      }),
      fetch(`${api.baseUrl}/api/v1/document-templates/concurrent_tpl_001/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `${api.baseUrl}/template-v1.docx` }),
      }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const versionsResponse = await fetch(`${api.baseUrl}/api/v1/document-templates/concurrent_tpl_001/versions`);
    const versions = await versionsResponse.json() as any;
    assert.deepEqual(
      versions.versions.map((version: any) => version.versionId),
      ['concurrent_tpl_001_v001', 'concurrent_tpl_001_v002', 'concurrent_tpl_001_v003'],
    );
  } finally {
    restore();
    await api.close();
  }
});

test('模板新增版本后默认使用最新版本，软删除后禁止继续生成', async () => {
  const restore = withPrivateTemplateUrls();
  const api = await startServer();
  try {
    await fetch(`${api.baseUrl}/api/v1/document-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'fbiftemp_20260512_001',
        name: '通用合同模板',
        url: `${api.baseUrl}/template-v1.docx`,
      }),
    });
    const versionResponse = await fetch(`${api.baseUrl}/api/v1/document-templates/fbiftemp_20260512_001/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${api.baseUrl}/template-v2.docx`,
      }),
    });
    const versioned = await versionResponse.json() as any;
    assert.equal(versionResponse.status, 200);
    assert.equal(versioned.template.activeVersionId, 'fbiftemp_20260512_001_v002');
    assert.deepEqual(versioned.template.versions[1].variables, ['金额']);

    const renderResponse = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', templateId: 'fbiftemp_20260512_001' },
        variables: { 金额: '12800 元' },
      }),
    });
    const rendered = await renderResponse.json() as any;
    assert.equal(renderResponse.status, 200);
    assert.equal(rendered.document.previewText, '金额：12800 元');

    const deleteResponse = await fetch(`${api.baseUrl}/api/v1/document-templates/fbiftemp_20260512_001`, { method: 'DELETE' });
    const deleted = await deleteResponse.json() as any;
    assert.equal(deleteResponse.status, 200);
    assert.equal(deleted.template.status, 'deleted');

    const listResponse = await fetch(`${api.baseUrl}/api/v1/document-templates`);
    const list = await listResponse.json() as any;
    assert.equal(list.templates.length, 0);
    const deletedListResponse = await fetch(`${api.baseUrl}/api/v1/document-templates?includeDeleted=true`);
    const deletedList = await deletedListResponse.json() as any;
    assert.equal(deletedList.templates[0].status, 'deleted');

    const blockedResponse = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', templateId: 'fbiftemp_20260512_001' },
        variables: { 金额: '12800 元' },
      }),
    });
    const blocked = await blockedResponse.json() as any;
    assert.equal(blockedResponse.status, 400);
    assert.equal(blocked.error, '模板已删除，不能用于生成。');
  } finally {
    restore();
    await api.close();
  }
});

// 锁住 CONTEXT.md「存储边界」红线：生产环境只要拿不到完整对象存储，就必须失败，
// 绝不静默降级到本地临时存储。此前只覆盖「完全无配置」，半配/显式 provider 缺失的
// 缺口靠临时探测验证过，这里固化为回归测试，防止将来分支调整时漏掉守卫。
function withStorageEnv(overrides: Record<string, string | undefined>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(overrides)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test('生产环境 TOS 模板存储只配置了一半时拒绝降级到本地存储', async () => {
  const restore = withStorageEnv({
    NODE_ENV: 'production',
    DOCUMENT_TEMPLATE_STORAGE_PROVIDER: undefined,
    DOCUMENT_RENDER_STORAGE_PROVIDER: undefined,
    TOS_ACCESS_KEY: 'ak-only',
    TOS_SECRET_KEY: 'sk-only',
    TOS_BUCKET: undefined,
    TOS_REGION: undefined,
    TOS_ENDPOINT: undefined,
  });
  try {
    const { createConfiguredTemplateObjectStore, LocalTemplateObjectStore } = await import('./documentTemplateStorage');
    let store: unknown;
    let threw: unknown;
    try {
      store = createConfiguredTemplateObjectStore();
    } catch (error) {
      threw = error;
    }
    assert.ok(threw, '生产环境配置不完整时应抛错，不能返回任何存储');
    assert.ok(!(store instanceof LocalTemplateObjectStore), '绝不降级到本地临时模板存储');
  } finally {
    restore();
  }
});

test('生产环境显式 provider=tos 但配置缺失时拒绝降级到本地存储', async () => {
  const restore = withStorageEnv({
    NODE_ENV: 'production',
    DOCUMENT_TEMPLATE_STORAGE_PROVIDER: 'tos',
    DOCUMENT_RENDER_STORAGE_PROVIDER: undefined,
    TOS_ACCESS_KEY: undefined,
    TOS_SECRET_KEY: undefined,
    TOS_BUCKET: undefined,
    TOS_REGION: undefined,
    TOS_ENDPOINT: undefined,
  });
  try {
    const { createConfiguredTemplateObjectStore, LocalTemplateObjectStore } = await import('./documentTemplateStorage');
    let store: unknown;
    let threw: unknown;
    try {
      store = createConfiguredTemplateObjectStore();
    } catch (error) {
      threw = error;
    }
    assert.ok(threw, '显式选了 tos 但没配置时应抛错');
    assert.ok(!(store instanceof LocalTemplateObjectStore), '绝不降级到本地临时模板存储');
  } finally {
    restore();
  }
});

test('生产环境未配置 TOS 模板存储时拒绝使用本地临时模板存储', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousProvider = process.env.DOCUMENT_TEMPLATE_STORAGE_PROVIDER;
  const previousTosKey = process.env.TOS_ACCESS_KEY;
  const previousTosSecret = process.env.TOS_SECRET_KEY;
  const previousTosBucket = process.env.TOS_BUCKET;
  const previousTosRegion = process.env.TOS_REGION;
  process.env.NODE_ENV = 'production';
  delete process.env.DOCUMENT_TEMPLATE_STORAGE_PROVIDER;
  delete process.env.TOS_ACCESS_KEY;
  delete process.env.TOS_SECRET_KEY;
  delete process.env.TOS_BUCKET;
  delete process.env.TOS_REGION;
  try {
    const { createConfiguredTemplateObjectStore } = await import('./documentTemplateStorage');
    assert.throws(() => createConfiguredTemplateObjectStore(), /生产环境必须配置 TOS 模板存储/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousProvider === undefined) delete process.env.DOCUMENT_TEMPLATE_STORAGE_PROVIDER;
    else process.env.DOCUMENT_TEMPLATE_STORAGE_PROVIDER = previousProvider;
    if (previousTosKey === undefined) delete process.env.TOS_ACCESS_KEY;
    else process.env.TOS_ACCESS_KEY = previousTosKey;
    if (previousTosSecret === undefined) delete process.env.TOS_SECRET_KEY;
    else process.env.TOS_SECRET_KEY = previousTosSecret;
    if (previousTosBucket === undefined) delete process.env.TOS_BUCKET;
    else process.env.TOS_BUCKET = previousTosBucket;
    if (previousTosRegion === undefined) delete process.env.TOS_REGION;
    else process.env.TOS_REGION = previousTosRegion;
  }
});
