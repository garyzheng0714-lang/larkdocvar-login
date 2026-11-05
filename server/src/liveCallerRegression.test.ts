// 线上调用方回归测试（CLAUDE.md「改造红线」）。
// 下面每个用例都照着一条正在线上跑的多维表格自动化的真实请求写：路由、请求头、请求字段、
// 以及它后续步骤读取的返回字段。变量值已换成假数据，表格标识只记在本地资源索引里。
// 这些用例挂了，就说明改动会弄坏线上流程：先改代码，不要改用例。
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import JSZip from 'jszip';

import { createDocumentRenderRouter } from './documentRenderApi';
import { requireDocumentRenderApiKey } from './documentRenderApiKeyGuard';
import { TosDocumentRenderStorage } from './documentRenderTosStorage';
import { createDocumentTemplateRouter } from './documentTemplateApi';
import { DocumentTemplateService } from './documentTemplateService';
import { LocalTemplateObjectStore } from './documentTemplateStorage';

const API_KEY = 'live-caller-regression-key';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function createDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join('');
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function documentText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')!.async('string');
  return xml.replace(/<[^>]+>/g, '');
}

// 照 ① 参展合同模板：用到表里一部分字段，另有一个表里不传的变量（靠 missingStrategy=blank 留空）。
const EXPO_CONTRACT = [
  '合同编号：{{合同编号}}',
  '乙方：{{合同公司名}}，联系人 {{乙方联系人}}，电话 {{乙方电话}}',
  '展位号：{{展位号}}，{{展位宽度}} × {{展位长度}}',
  '费用：{{合作费用共计}} 元（{{合作费用共计（大写）}}）',
  '签约日期：{{签约日期}}',
];
// 照 ② 品鉴会合同模板。
const TASTING_CONTRACT = ['甲方与 {{合同公司名}} 签订', '合作费用共计 {{合作费用共计}} 元（{{合作费用共计（大写）}}）'];
// 照 ③ 人事离职证明模板：模板写的是「证件号」，表里那列叫「身份证号」，自动化两个名字都传。
const RESIGNATION = ['兹证明 {{姓名}}（证件号 {{证件号}}）于 {{入职日期}} 入职 {{部门}} 任 {{职务}}，{{离职日期}} 离职。', '{{现在的日期}}'];
// offer 模板要的字段，人事表里没有。
const OFFER = ['{{姓名}} 底薪 {{底薪}}，绩效 {{绩效}}'];

type Api = {
  baseUrl: string;
  close: () => Promise<void>;
  sourceUrl: (name: string) => string;
};

async function startProductionLikeApi(): Promise<Api> {
  const dir = await mkdtemp(join(tmpdir(), 'live-caller-regression-'));
  const service = new DocumentTemplateService(new LocalTemplateObjectStore(dir));
  const sources: Record<string, Buffer> = {
    'expo-contract.docx': await createDocx(EXPO_CONTRACT),
    'expo-contract-v2.docx': await createDocx([...EXPO_CONTRACT, '附件：展位图']),
    'tasting-contract.docx': await createDocx(TASTING_CONTRACT),
    'resignation.docx': await createDocx(RESIGNATION),
    'offer.docx': await createDocx(OFFER),
  };
  const app = express();
  app.get('/source/:name', (request, response) => {
    const file = sources[String(request.params.name)];
    if (!file) {
      response.status(404).end();
      return;
    }
    response.type(DOCX_TYPE).send(file);
  });
  // 和 server/src/index.ts 一样的挂法：钥匙校验 + 模板归属校验。
  app.use('/api/v1/document-templates', requireDocumentRenderApiKey, createDocumentTemplateRouter(service, { enforceOwnership: true }));
  app.use('/api/v1/document-renders', requireDocumentRenderApiKey, createDocumentRenderRouter({ templateResolver: service, storageDir: dir }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    sourceUrl: (name) => `${baseUrl}/source/${name}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function withLiveEnv(run: (api: Api) => Promise<void>): Promise<void> {
  const previous = {
    key: process.env.DOCUMENT_RENDER_API_KEY,
    privateUrls: process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS,
  };
  process.env.DOCUMENT_RENDER_API_KEY = API_KEY;
  process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS = 'true';
  const api = await startProductionLikeApi();
  try {
    await run(api);
  } finally {
    await api.close();
    if (previous.key === undefined) delete process.env.DOCUMENT_RENDER_API_KEY;
    else process.env.DOCUMENT_RENDER_API_KEY = previous.key;
    if (previous.privateUrls === undefined) delete process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS;
    else process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS = previous.privateUrls;
  }
}

async function post(api: Api, path: string, body: unknown, auth: 'x-api-key' | 'Authorization'): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth === 'x-api-key') headers['x-api-key'] = API_KEY;
  else headers.Authorization = `Bearer ${API_KEY}`;
  const response = await fetch(`${api.baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

// ④ 模板库「新增与更新模板」：附件临时链接 → 新增模板 / 新增版本，回填 template.templateId、template.activeVersionId。
async function uploadLikeTemplateLibrary(api: Api, sourceName: string, primaryProperty: string): Promise<{ templateId: string; activeVersionId: string }> {
  const result = await post(api, '/api/v1/document-templates', {
    name: primaryProperty,
    url: api.sourceUrl(sourceName),
    fileName: primaryProperty,
    category: '合同类',
    visibility: 'shared',
    description: '适用部门-测试部',
  }, 'Authorization');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.match(result.body.template.templateId, /^tpl_\d{3}$/);
  assert.equal(result.body.template.activeVersionId, `${result.body.template.templateId}_v001`);
  return { templateId: result.body.template.templateId, activeVersionId: result.body.template.activeVersionId };
}

function assertAutomationReadableDownload(body: any, expectedFileName: string): void {
  // ①②③ 后面的「链接转附件」读 download.url；回填步骤还看 ok。
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.format, 'docx');
  assert.equal(typeof body.download?.url, 'string');
  assert.ok(body.download.url.length > 0);
  assert.equal(body.download.fileName, expectedFileName);
  assert.equal(typeof body.download.expiresAt, 'string');
}

async function downloadText(api: Api, url: string): Promise<string> {
  const absolute = url.startsWith('http') ? url : `${api.baseUrl}${url}`;
  // 测试里用本地存储，下载口在钥匙校验后面；线上是 TOS 签名链接，不用钥匙。
  const response = await fetch(absolute, { headers: { 'x-api-key': API_KEY } });
  assert.equal(response.status, 200);
  return documentText(Buffer.from(await response.arrayBuffer()));
}

test('线上 ④ 模板库按钮：新增模板回填编号和版本，更新模板默认马上生效', async () => {
  await withLiveEnv(async (api) => {
    const created = await uploadLikeTemplateLibrary(api, 'expo-contract.docx', '模板-参展合同.docx');
    const updated = await post(api, `/api/v1/document-templates/${created.templateId}/versions`, {
      name: '模板-参展合同.docx',
      url: api.sourceUrl('expo-contract-v2.docx'),
      fileName: '模板-参展合同.docx',
      category: '合同类',
      visibility: 'shared',
      description: '适用部门-测试部',
    }, 'Authorization');
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.ok, true);
    assert.equal(updated.body.template.templateId, created.templateId);
    // 老行为：不传任何新字段时，新版本上传即生效。草稿、发布这类新能力只能是可选字段。
    assert.equal(updated.body.template.activeVersionId, `${created.templateId}_v002`);
  });
});

test('线上 ① 参展合同：x-api-key + 只给模板编号 + 留空缺失 + 忽略多余变量', async () => {
  await withLiveEnv(async (api) => {
    const { templateId } = await uploadLikeTemplateLibrary(api, 'expo-contract.docx', '【标展-中文】参展合同.docx');
    const result = await post(api, '/api/v1/document-renders', {
      template: { format: 'docx', templateId },
      unusedStrategy: 'ignore',
      missingStrategy: 'blank',
      variables: {
        合同编号: 'FBIF2026001',
        合同公司名: '测试食品有限公司',
        乙方联系人: '张三',
        乙方电话: '13800000000',
        乙方邮箱: 'test@example.com',
        展位号: 'A01',
        合作费用共计: '50000',
        '合作费用共计（大写）': '伍万元整',
        论坛通票数量: '2',
        展商证数量: '4',
        渠道对接会门票数量: '1',
        展位宽度: '3',
        展位长度: '6',
      },
      output: { fileName: '测试食品有限公司-标展-FBIF2026001', expiresInSeconds: 86400 },
    }, 'x-api-key');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assertAutomationReadableDownload(result.body, '测试食品有限公司-标展-FBIF2026001.docx');
    assert.deepEqual(result.body.variables.missing, ['签约日期']);
    const text = await downloadText(api, result.body.download.url);
    assert.match(text, /乙方：测试食品有限公司，联系人 张三/);
    assert.match(text, /费用：50000 元（伍万元整）/);
    assert.match(text, /签约日期：$/m);
  });
});

test('线上 ② 品鉴会合同：文件名自带 .docx 时不重复加后缀', async () => {
  await withLiveEnv(async (api) => {
    const { templateId } = await uploadLikeTemplateLibrary(api, 'tasting-contract.docx', '渠道线下品鉴会合同.docx');
    const result = await post(api, '/api/v1/document-renders', {
      template: { format: 'docx', templateId },
      variables: { 合同公司名: '测试食品有限公司', 合作费用共计: '5000', '合作费用共计（大写）': '伍仟元整' },
      missingStrategy: 'blank',
      unusedStrategy: 'ignore',
      output: { fileName: 'FBIF渠道线下品鉴会合同-测试食品有限公司-2026-07-07.docx', expiresInSeconds: 86400 },
    }, 'x-api-key');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assertAutomationReadableDownload(result.body, 'FBIF渠道线下品鉴会合同-测试食品有限公司-2026-07-07.docx');
    assert.match(await downloadText(api, result.body.download.url), /甲方与 测试食品有限公司 签订/);
  });
});

test('线上 ③ 人事离职证明：同一列同时传「身份证号」「证件号」，缺失默认报错', async () => {
  await withLiveEnv(async (api) => {
    const { templateId } = await uploadLikeTemplateLibrary(api, 'resignation.docx', '人事-离职证明.docx');
    const variables = {
      姓名: '李四',
      部门: '市场部',
      职务: '专员',
      入职日期: '2024-01-02',
      离职日期: '2026-11-05',
      现在的日期: '2026年11月05日',
      出生日期: '1990-01-01',
      身份证号: '310101199001010000',
      证件号: '310101199001010000',
    };
    const result = await post(api, '/api/v1/document-renders', {
      template: { format: 'docx', templateId },
      unusedStrategy: 'ignore',
      variables,
      output: { fileName: '李四-离职证明', expiresInSeconds: 86400 },
    }, 'x-api-key');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assertAutomationReadableDownload(result.body, '李四-离职证明.docx');
    assert.match(await downloadText(api, result.body.download.url), /兹证明 李四（证件号 310101199001010000）/);

    // 选到 offer：表里没有底薪、绩效。今天的行为是非 2xx（自动化停在「生成中」）。
    // 缓解只能做成可选字段；不传时这里必须保持原样。
    const offer = await uploadLikeTemplateLibrary(api, 'offer.docx', '人事-offer.docx');
    const failed = await post(api, '/api/v1/document-renders', {
      template: { format: 'docx', templateId: offer.templateId },
      unusedStrategy: 'ignore',
      variables,
      output: { fileName: '李四-offer', expiresInSeconds: 86400 },
    }, 'x-api-key');
    assert.equal(failed.status, 400);
    assert.equal(failed.body.ok, false);
  });
});

test('线上 ①②③ 共用：没钥匙或钥匙不对一律拒绝', async () => {
  await withLiveEnv(async (api) => {
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'wrong-key' },
      body: JSON.stringify({ template: { format: 'docx', templateId: 'tpl_001' }, variables: {} }),
    });
    assert.equal(response.status, 401);
  });
});

test('线上「链接转附件」：TOS 下载链接最后一段是中文文件名', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
  try {
    const storage = new TosDocumentRenderStorage({
      accessKeyId: 'testAK',
      accessKeySecret: 'testSK',
      bucket: 'examplebucket',
      region: 'cn-shanghai',
      endpoint: 'tos-cn-shanghai.volces.com',
      prefix: 'document-renders/',
    });
    for (const [input, expected] of [
      ['测试食品有限公司-标展-FBIF2026001', '测试食品有限公司-标展-FBIF2026001.docx'],
      ['FBIF渠道线下品鉴会合同-测试食品有限公司-2026-07-07.docx', 'FBIF渠道线下品鉴会合同-测试食品有限公司-2026-07-07.docx'],
      ['李四-离职证明', '李四-离职证明.docx'],
    ]) {
      const saved = await storage.saveDocx({ buffer: Buffer.from('x'), fileName: input, requestId: 'req', ttlMs: 1000, ttlSeconds: 1 });
      const lastSegment = decodeURIComponent(new URL(saved.url).pathname.split('/').pop() || '');
      assert.equal(lastSegment, expected);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});
