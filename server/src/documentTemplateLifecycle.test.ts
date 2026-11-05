// 多维表格运营流程要用的新接口：检查模板、按指纹发布、退回旧版本、变量词典、别名生成、出错回 200。
// 都是可选的新能力；老调用方不传这些字段时的行为由 liveCallerRegression.test.ts 守着。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import JSZip from 'jszip';

import { createDocumentRenderRouter } from './documentRenderApi';
import { createDocumentTemplateRouter } from './documentTemplateApi';
import { findWritingProblems } from './documentTemplateInspect';
import { DocumentTemplateService } from './documentTemplateService';
import { LocalTemplateObjectStore } from './documentTemplateStorage';
import { createDocumentVariableRouter } from './documentVariableApi';
import { applyVariableAliases, parseAliasList } from './documentVariableDictionary';

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

async function documentText(base64: string): Promise<string> {
  const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
  return (await zip.file('word/document.xml')!.async('string')).replace(/<[^>]+>/g, '');
}

const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

type Api = {
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any }>;
  close: () => Promise<void>;
};

const ADMIN = { 'x-test-admin': 'true' };
const OWNER = { 'x-test-open-id': 'ou_owner' };
const STRANGER = { 'x-test-open-id': 'ou_stranger' };

async function startApi(): Promise<Api> {
  const dir = await mkdtemp(join(tmpdir(), 'document-template-lifecycle-'));
  const service = new DocumentTemplateService(new LocalTemplateObjectStore(dir));
  const resolveActor = async (request: express.Request) => ({
    openId: typeof request.headers['x-test-open-id'] === 'string' ? request.headers['x-test-open-id'] : undefined,
    isAdmin: request.headers['x-test-admin'] === 'true',
  });
  const app = express();
  app.use('/api/v1/document-templates', createDocumentTemplateRouter(service, { enforceOwnership: true, resolveActor }));
  app.use('/api/v1/document-renders', createDocumentRenderRouter({ templateResolver: service, storageDir: dir, variableDictionary: service.variables }));
  app.use('/api/v1/document-variables', createDocumentVariableRouter(service.variables, { resolveActor }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    call: async (method, path, body, headers = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json() };
    },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

// 同一份文件要复用同一个 buffer：zip 里带 2 秒精度的时间戳，分两次生成可能差一个字节。
async function upload(api: Api, source: string[] | Buffer, extra: Record<string, unknown> = {}, headers = OWNER) {
  const buffer = Buffer.isBuffer(source) ? source : await createDocx(source);
  const result = await api.call('POST', '/api/v1/document-templates', { fileBase64: buffer.toString('base64'), fileName: '测试模板.docx', ...extra }, headers);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json.template;
}

test('检查模板：新模板能发布、要审核，返回变量和可写回表格的文字', async () => {
  const api = await startApi();
  try {
    const buffer = await createDocx(['甲方：{{客户名称}}', '金额：{{金额}}']);
    const result = await api.call('POST', '/api/v1/document-templates/inspect', { fileBase64: buffer.toString('base64'), fileName: '报价单.docx' }, OWNER);
    assert.equal(result.status, 200);
    const inspection = result.json.inspection;
    assert.deepEqual(inspection.variables, ['客户名称', '金额']);
    assert.equal(inspection.variablesText, '客户名称、金额');
    assert.equal(inspection.sha256, sha(buffer));
    assert.equal(inspection.publishable, true);
    assert.equal(inspection.needsReview, true);
    assert.equal(inspection.statusText, '等审核');
    assert.deepEqual(inspection.problems, []);
    assert.match(inspection.summaryText, /可以发布.*新模板，需要审核/);
    // 检查只读：模板库里不会多出模板。
    const list = await api.call('GET', '/api/v1/document-templates', undefined, ADMIN);
    assert.equal(list.json.templates.length, 0);
  } finally {
    await api.close();
  }
});

test('检查模板：中文大括号、没配对、空占位符、单层大括号都会被指出', () => {
  const codes = (text: string) => findWritingProblems(text).map((problem) => `${problem.level}:${problem.code}`);
  assert.deepEqual(codes('姓名 ｛｛姓名｝｝'), ['error:FULLWIDTH_BRACES']);
  assert.deepEqual(codes('姓名 {｛姓名}}'), ['error:FULLWIDTH_BRACES']);
  assert.deepEqual(codes('姓名 {{姓名}'), ['error:UNPAIRED_BRACES']);
  assert.deepEqual(codes('姓名 {{ }}'), ['error:EMPTY_PLACEHOLDER']);
  assert.deepEqual(codes('姓名 {姓名}'), ['warning:SINGLE_BRACES']);
  assert.deepEqual(codes('姓名 {{姓名}}，日期 {{ 日期 }}'), []);
});

test('检查模板：有写法错误或没有变量时不能发布，仍回 200 并给出原因', async () => {
  const api = await startApi();
  try {
    const broken = await createDocx(['姓名：｛｛姓名｝｝', '部门：{{部门}']);
    const result = await api.call('POST', '/api/v1/document-templates/inspect', { fileBase64: broken.toString('base64') }, OWNER);
    assert.equal(result.status, 200);
    const inspection = result.json.inspection;
    assert.equal(inspection.publishable, false);
    assert.equal(inspection.status, 'blocked');
    assert.equal(inspection.statusText, '检查没过');
    assert.ok(inspection.problems.some((problem: { code: string }) => problem.code === 'FULLWIDTH_BRACES'));
    assert.ok(inspection.problems.some((problem: { code: string }) => problem.code === 'UNPAIRED_BRACES'));
    assert.match(inspection.summaryText, /^不能发布：/);
    assert.match(inspection.problemsText, /【要改】/);

    const notDocx = await api.call('POST', '/api/v1/document-templates/inspect', { fileBase64: Buffer.from('hello').toString('base64') }, OWNER);
    assert.equal(notDocx.status, 200);
    assert.equal(notDocx.json.inspection.publishable, false);
    assert.equal(notDocx.json.inspection.problems[0].code, 'UNREADABLE');

    const empty = await createDocx(['没有变量的文件']);
    const noVariables = await api.call('POST', '/api/v1/document-templates/inspect', { fileBase64: empty.toString('base64') }, OWNER);
    assert.equal(noVariables.json.inspection.publishable, false);
    assert.equal(noVariables.json.inspection.problems[0].code, 'NO_VARIABLES');

    const emptyCompare = await api.call('POST', '/api/v1/document-templates/inspect', { fileBase64: (await createDocx(['{{甲}}'])).toString('base64'), compareTemplateId: '' }, OWNER);
    assert.equal(emptyCompare.status, 200);
    assert.equal(emptyCompare.json.inspection.compare, undefined);
    assert.equal(emptyCompare.json.inspection.needsReview, true);

    const missingFile = await api.call('POST', '/api/v1/document-templates/inspect', {}, OWNER);
    assert.equal(missingFile.status, 400);
  } finally {
    await api.close();
  }
});

test('检查模板：对比现用版本，变量没变不用审核，变量有增减要审核，同一文件会提醒', async () => {
  const api = await startApi();
  try {
    const original = ['甲方：{{客户名称}}', '金额：{{金额}}'];
    const originalFile = await createDocx(original);
    const template = await upload(api, originalFile);
    const sameVariables = await createDocx([...original, '附件：报价明细']);
    const unchanged = await api.call('POST', '/api/v1/document-templates/inspect', { fileBase64: sameVariables.toString('base64'), compareTemplateId: template.templateId }, OWNER);
    assert.equal(unchanged.json.inspection.needsReview, false);
    assert.equal(unchanged.json.inspection.statusText, '能发布');
    assert.deepEqual(unchanged.json.inspection.compare.added, []);
    assert.match(unchanged.json.inspection.summaryText, /模板负责人可以直接发布/);

    const changed = await createDocx(['甲方：{{客户名称}}', '税额：{{税额}}']);
    const reviewed = await api.call('POST', '/api/v1/document-templates/inspect', { fileBase64: changed.toString('base64'), compareTemplateId: template.templateId }, OWNER);
    assert.equal(reviewed.json.inspection.needsReview, true);
    assert.deepEqual(reviewed.json.inspection.compare.added, ['税额']);
    assert.deepEqual(reviewed.json.inspection.compare.removed, ['金额']);
    assert.match(reviewed.json.inspection.summaryText, /新增 税额，去掉 金额，需要审核/);

    const sameFile = await api.call('POST', '/api/v1/document-templates/inspect', { fileBase64: originalFile.toString('base64'), compareTemplateId: template.templateId }, OWNER);
    assert.ok(sameFile.json.inspection.problems.some((problem: { code: string }) => problem.code === 'SAME_AS_ACTIVE'));
  } finally {
    await api.close();
  }
});

test('检查模板：新模板和库里已有模板重复时列出来', async () => {
  const api = await startApi();
  try {
    const sameFile = await createDocx(['兹证明 {{姓名}} 于 {{离职日期}} 离职']);
    const existing = await upload(api, sameFile, { name: '离职证明' });
    const result = await api.call('POST', '/api/v1/document-templates/inspect', { fileBase64: sameFile.toString('base64'), name: '离职证明（新）' }, OWNER);
    assert.deepEqual(result.json.inspection.duplicates, [{ templateId: existing.templateId, name: '离职证明', reason: 'same-file' }]);
    assert.match(result.json.inspection.summaryText, /已有相似模板：离职证明（同一个文件）/);

    const similarName = await createDocx(['{{员工姓名}} 离职']);
    const byName = await api.call('POST', '/api/v1/document-templates/inspect', { fileBase64: similarName.toString('base64'), name: '离职证明 v2' }, OWNER);
    assert.equal(byName.json.inspection.duplicates[0]?.reason, 'similar-name');

    // 别人的私有模板不出现在重复列表里。
    await upload(api, ['{{私密}}'], { name: '私有模板', visibility: 'private' }, { 'x-test-open-id': 'ou_other' });
    const privateCheck = await api.call('POST', '/api/v1/document-templates/inspect', { fileBase64: (await createDocx(['{{私密}}'])).toString('base64'), name: '私有模板' }, OWNER);
    assert.deepEqual(privateCheck.json.inspection.duplicates, []);
  } finally {
    await api.close();
  }
});

test('发布：带 expectedSha256 时文件必须和检查时一致', async () => {
  const api = await startApi();
  try {
    const buffer = await createDocx(['{{客户名称}}']);
    const mismatch = await api.call('POST', '/api/v1/document-templates', { fileBase64: buffer.toString('base64'), expectedSha256: 'a'.repeat(64) }, OWNER);
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.json.error, /不是同一份/);

    const created = await api.call('POST', '/api/v1/document-templates', { fileBase64: buffer.toString('base64'), expectedSha256: sha(buffer).toUpperCase() }, OWNER);
    assert.equal(created.status, 200);
    assert.equal(created.json.template.versions[0].sourceSha256, sha(buffer));

    const next = await createDocx(['{{客户名称}} 新版']);
    const badVersion = await api.call('POST', `/api/v1/document-templates/${created.json.template.templateId}/versions`, { fileBase64: next.toString('base64'), expectedSha256: sha(buffer) }, OWNER);
    assert.equal(badVersion.status, 400);
    const goodVersion = await api.call('POST', `/api/v1/document-templates/${created.json.template.templateId}/versions`, { fileBase64: next.toString('base64'), expectedSha256: sha(next) }, OWNER);
    assert.equal(goodVersion.status, 200);
    assert.equal(goodVersion.json.template.versions.length, 2);
  } finally {
    await api.close();
  }
});

test('退回旧版本：publish 把已有版本设为现用，生成随之改用旧版本；只有负责人或管理员能退', async () => {
  const api = await startApi();
  try {
    const template = await upload(api, ['旧版：{{姓名}}']);
    const v2 = await createDocx(['新版：{{姓名}}']);
    await api.call('POST', `/api/v1/document-templates/${template.templateId}/versions`, { fileBase64: v2.toString('base64') }, OWNER);

    const render = async () => {
      const result = await api.call('POST', '/api/v1/document-renders', {
        template: { format: 'docx', templateId: template.templateId },
        variables: { 姓名: '张三' },
        output: { includeFileBase64: true },
      }, ADMIN);
      return documentText(result.json.download.fileBase64);
    };
    assert.match(await render(), /新版：张三/);

    const denied = await api.call('POST', `/api/v1/document-templates/${template.templateId}/publish`, { versionId: template.activeVersionId }, STRANGER);
    assert.equal(denied.status, 403);

    const rolledBack = await api.call('POST', `/api/v1/document-templates/${template.templateId}/publish`, { versionId: template.activeVersionId }, OWNER);
    assert.equal(rolledBack.status, 200);
    assert.equal(rolledBack.json.template.activeVersionId, `${template.templateId}_v001`);
    assert.equal(rolledBack.json.template.versions.length, 2);
    assert.match(await render(), /旧版：张三/);

    const missing = await api.call('POST', `/api/v1/document-templates/${template.templateId}/publish`, { versionId: 'nope_v009' }, OWNER);
    assert.equal(missing.status, 400);
  } finally {
    await api.close();
  }
});

test('变量词典：别名可以用顿号逗号分隔，一个名字只能属于一组，只有管理员能改', async () => {
  assert.deepEqual(parseAliasList('证件号、身份证，{{身份证号码}};证件号'), ['证件号', '身份证', '身份证号码']);

  const api = await startApi();
  try {
    const denied = await api.call('PUT', '/api/v1/document-variables/rec1', { name: '身份证号', aliases: '证件号' }, OWNER);
    assert.equal(denied.status, 403);

    const saved = await api.call('PUT', '/api/v1/document-variables/rec1', { name: '身份证号', aliases: '证件号、身份证' }, ADMIN);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.variable.aliases, ['证件号', '身份证']);

    const conflict = await api.call('PUT', '/api/v1/document-variables/rec2', { name: '证件号码', aliases: ['证件号'] }, ADMIN);
    assert.equal(conflict.status, 400);
    assert.match(conflict.json.error, /「证件号」已经记在变量「身份证号」下面/);

    const bodyConflict = await api.call('PUT', '/api/v1/document-variables/rec2', { name: '证件号码', aliases: ['证件号'], errorMode: 'body' }, ADMIN);
    assert.equal(bodyConflict.status, 200);
    assert.equal(bodyConflict.json.errorCode, 'REJECTED');
    const bodyDenied = await api.call('DELETE', '/api/v1/document-variables/rec1?errorMode=body', undefined, OWNER);
    assert.equal(bodyDenied.status, 200);
    assert.equal(bodyDenied.json.errorCode, 'FORBIDDEN');

    const renamed = await api.call('PUT', '/api/v1/document-variables/rec1', { name: '身份证号码', aliases: ['身份证号', '证件号'] }, ADMIN);
    assert.equal(renamed.status, 200);

    const list = await api.call('GET', '/api/v1/document-variables', undefined, OWNER);
    assert.deepEqual(list.json.variables.map((item: { id: string; name: string }) => [item.id, item.name]), [['rec1', '身份证号码']]);

    const removed = await api.call('DELETE', '/api/v1/document-variables/rec1', undefined, ADMIN);
    assert.equal(removed.json.deleted, true);
    const again = await api.call('DELETE', '/api/v1/document-variables/rec1', undefined, ADMIN);
    assert.equal(again.json.deleted, false);
  } finally {
    await api.close();
  }
});

test('变量词典：多维表格用表单体同步，引号换行原样收下；停用或清空标准名就移出词典', async () => {
  const api = await startApi();
  const form = (path: string, fields: Record<string, string>) => api.call('PUT', path, new URLSearchParams(fields).toString(), {
    ...ADMIN,
    'content-type': 'application/x-www-form-urlencoded',
  });
  try {
    const saved = await form('/api/v1/document-variables/rec1?errorMode=body', { name: '身份证号', aliases: '证件号、身份"证\n居民身份证', format: '文本', disabled: 'false' });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.ok, true);
    assert.deepEqual(saved.json.variable.aliases, ['证件号', '身份"证', '居民身份证']);
    assert.match(saved.json.summaryText, /^已同步 /);

    const conflict = await form('/api/v1/document-variables/rec2?errorMode=body', { name: '证件号', disabled: 'false' });
    assert.equal(conflict.json.ok, false);
    assert.equal(conflict.json.summaryText, conflict.json.error);

    const disabled = await form('/api/v1/document-variables/rec1?errorMode=body', { name: '身份证号', disabled: 'true' });
    assert.equal(disabled.json.deleted, true);
    assert.match(disabled.json.summaryText, /^已停用 /);

    await form('/api/v1/document-variables/rec1', { name: '身份证号', aliases: '证件号' });
    const cleared = await form('/api/v1/document-variables/rec1', { name: '', aliases: '证件号' });
    assert.equal(cleared.json.deleted, true);
    assert.equal(cleared.json.summaryText, '没填标准名，已移出词典');

    const list = await api.call('GET', '/api/v1/document-variables', undefined, OWNER);
    assert.deepEqual(list.json.variables, []);
  } finally {
    await api.close();
  }
});

test('别名顶替：只顶没传的变量，记下谁顶了谁', () => {
  const entries = [{ id: 'rec1', name: '身份证号', aliases: ['证件号'], updatedAt: '' }];
  const { variables, derived } = applyVariableAliases({ 身份证号: '110', 姓名: '张三' }, entries);
  assert.equal(variables.证件号, '110');
  assert.equal(derived.证件号, '身份证号');
  const both = applyVariableAliases({ 身份证号: '110', 证件号: '220' }, entries);
  assert.equal(both.variables.证件号, '220');
  assert.equal(Object.keys(both.derived).length, 0);
});

test('生成：aliasStrategy=dictionary 时同义变量互相顶替；不传时照旧报错', async () => {
  const api = await startApi();
  try {
    await api.call('PUT', '/api/v1/document-variables/rec1', { name: '身份证号', aliases: '证件号' }, ADMIN);
    const template = await upload(api, ['{{姓名}}（证件号 {{证件号}}）']);
    const body = { template: { format: 'docx', templateId: template.templateId }, variables: { 姓名: '张三', 身份证号: '110' } };

    const old = await api.call('POST', '/api/v1/document-renders', body, ADMIN);
    assert.equal(old.status, 400);
    assert.deepEqual(old.json.missingVariables, ['证件号']);

    const aliased = await api.call('POST', '/api/v1/document-renders', { ...body, aliasStrategy: 'dictionary', output: { includeFileBase64: true } }, ADMIN);
    assert.equal(aliased.status, 200, JSON.stringify(aliased.json));
    assert.match(await documentText(aliased.json.download.fileBase64), /张三（证件号 110）/);
    assert.deepEqual(aliased.json.variables.aliased, { 证件号: '身份证号' });
    assert.deepEqual(aliased.json.variables.unused, []);
    assert.deepEqual(aliased.json.variables.provided, ['姓名', '身份证号']);
  } finally {
    await api.close();
  }
});

test('生成：errorMode=body 时出错回 200，带 errorCode；不传时照旧 400', async () => {
  const api = await startApi();
  try {
    const template = await upload(api, ['{{姓名}} {{部门}}']);
    const body = { template: { format: 'docx', templateId: template.templateId }, variables: { 姓名: '张三' } };

    const old = await api.call('POST', '/api/v1/document-renders', body, ADMIN);
    assert.equal(old.status, 400);
    assert.equal(old.json.errorCode, undefined);

    const missing = await api.call('POST', '/api/v1/document-renders', { ...body, errorMode: 'body' }, ADMIN);
    assert.equal(missing.status, 200);
    assert.equal(missing.json.ok, false);
    assert.equal(missing.json.errorCode, 'MISSING_VARIABLES');
    assert.deepEqual(missing.json.missingVariables, ['部门']);

    const invalid = await api.call('POST', '/api/v1/document-renders', { template: { templateId: template.templateId }, errorMode: 'body' }, ADMIN);
    assert.equal(invalid.status, 200);
    assert.equal(invalid.json.errorCode, 'INVALID_REQUEST');

    const deleted = await api.call('POST', '/api/v1/document-renders', { template: { format: 'docx', templateId: 'tpl_999' }, variables: {}, errorMode: 'body' }, ADMIN);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.errorCode, 'RENDER_REJECTED');
  } finally {
    await api.close();
  }
});

test('检查模板：变量表里记成别名的变量会提醒改成标准名', async () => {
  const api = await startApi();
  try {
    await api.call('PUT', '/api/v1/document-variables/rec1', { name: '身份证号', aliases: '证件号' }, ADMIN);
    const buffer = await createDocx(['{{姓名}} {{证件号}}']);
    const result = await api.call('POST', '/api/v1/document-templates/inspect', { fileBase64: buffer.toString('base64') }, OWNER);
    const inspection = result.json.inspection;
    assert.deepEqual(inspection.aliasHints, [{ variable: '证件号', standardName: '身份证号' }]);
    assert.deepEqual(inspection.unknownVariables, ['姓名']);
    assert.equal(inspection.publishable, true);
    assert.ok(inspection.problems.some((problem: { code: string; level: string }) => problem.code === 'ALIAS_NAME' && problem.level === 'warning'));
  } finally {
    await api.close();
  }
});

test('模板写接口：errorMode=body 时出错回 200 带 errorCode；不传照旧 4xx', async () => {
  const api = await startApi();
  try {
    const buffer = await createDocx(['{{客户名称}}']);
    const mismatch = await api.call('POST', '/api/v1/document-templates', { fileBase64: buffer.toString('base64'), expectedSha256: 'b'.repeat(64), errorMode: 'body' }, OWNER);
    assert.equal(mismatch.status, 200);
    assert.equal(mismatch.json.ok, false);
    assert.equal(mismatch.json.errorCode, 'REJECTED');
    assert.match(mismatch.json.error, /不是同一份/);

    const invalid = await api.call('POST', '/api/v1/document-templates', { errorMode: 'body' }, OWNER);
    assert.equal(invalid.status, 200);
    assert.equal(invalid.json.errorCode, 'INVALID_REQUEST');

    const template = await upload(api, buffer);
    const forbidden = await api.call('POST', `/api/v1/document-templates/${template.templateId}/publish`, { versionId: template.activeVersionId, errorMode: 'body' }, STRANGER);
    assert.equal(forbidden.status, 200);
    assert.equal(forbidden.json.errorCode, 'FORBIDDEN');

    const next = await createDocx(['{{客户名称}} v2']);
    const badVersion = await api.call('POST', `/api/v1/document-templates/${template.templateId}/versions`, { fileBase64: next.toString('base64'), expectedSha256: sha(buffer), errorMode: 'body' }, OWNER);
    assert.equal(badVersion.status, 200);
    assert.equal(badVersion.json.errorCode, 'REJECTED');

    const old = await api.call('POST', `/api/v1/document-templates/${template.templateId}/versions`, { fileBase64: next.toString('base64'), expectedSha256: sha(buffer) }, OWNER);
    assert.equal(old.status, 400);
    assert.equal(old.json.errorCode, undefined);

    // 多维表格自动化用表单体发：名字里带引号也不会把请求弄坏。
    const formInspect = await api.call('POST', '/api/v1/document-templates/inspect', new URLSearchParams({
      fileBase64: next.toString('base64'), name: '客户"确认"函', compareTemplateId: template.templateId,
    }).toString(), { ...OWNER, 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(formInspect.status, 200);
    assert.equal(formInspect.json.inspection.compare.templateId, template.templateId);
  } finally {
    await api.close();
  }
});
