import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { createDocumentRenderBatchRouter } from './documentRenderBatchApi';
import { createDocumentRenderJobRouter } from './documentRenderJobApi';
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

async function startServer(options: { jobTtlMs?: number; maxJobs?: number } = {}): Promise<{ baseUrl: string; close: () => Promise<void>; hits: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'document-render-batch-job-'));
  const service = new DocumentTemplateService(new LocalTemplateObjectStore(dir));
  const app = express();
  const templateDocx = await createDocx('客户：{{客户名称}}，金额：{{金额}}');
  let hits = 0;
  app.get('/template.docx', (_request, response) => {
    hits += 1;
    response.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(templateDocx);
  });
  app.use('/api/v1/document-templates', createDocumentTemplateRouter(service));
  app.use('/api/v1/document-render-jobs', createDocumentRenderJobRouter({
    templateResolver: service,
    storageDir: dir,
    jobTtlMs: options.jobTtlMs,
    maxJobs: options.maxJobs,
  }));
  app.use('/api/v1/document-renders', createDocumentRenderBatchRouter({ templateResolver: service, storageDir: dir }));
  app.use('/api/v1/document-renders', createDocumentRenderRouter({ templateResolver: service, storageDir: dir }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get hits() { return hits; },
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

async function createTemplate(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/document-templates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      templateId: 'fbiftemp_20260512_001',
      name: '通用合同模板',
      url: `${baseUrl}/template.docx`,
    }),
  });
  assert.equal(response.status, 200);
}

test('批量生成每条记录独立返回状态，失败记录不影响成功记录', async () => {
  const restore = withPrivateTemplateUrls();
  const api = await startServer();
  try {
    await createTemplate(api.baseUrl);
    assert.equal(api.hits, 1);
    const response = await fetch(`${api.baseUrl}/api/v1/document-renders/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', templateId: 'fbiftemp_20260512_001' },
        records: [
          { recordId: 'rec_ok', variables: { 客户名称: '上海测试科技有限公司', 金额: '12800 元' } },
          { recordId: 'rec_missing', variables: { 客户名称: '北京测试科技有限公司' } },
        ],
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.total, 2);
    assert.equal(body.succeeded, 1);
    assert.equal(body.failed, 1);
    assert.equal(body.records[0].ok, true);
    assert.equal(body.records[1].ok, false);
    assert.deepEqual(body.records[1].missingVariables, ['金额']);
    assert.equal(api.hits, 1);
  } finally {
    restore();
    await api.close();
  }
});

test('异步任务完成后按 TTL 清理，避免长期堆积内存', async () => {
  const restore = withPrivateTemplateUrls();
  const api = await startServer({ jobTtlMs: 50 });
  try {
    await createTemplate(api.baseUrl);
    const submitResponse = await fetch(`${api.baseUrl}/api/v1/document-render-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', templateId: 'fbiftemp_20260512_001' },
        records: [
          { recordId: 'rec_1', variables: { 客户名称: '客户 1', 金额: '100 元' } },
        ],
      }),
    });
    const submitted = await submitResponse.json() as any;
    const jobId = submitted.job.jobId;

    let job = submitted.job;
    for (let index = 0; index < 20 && !['completed', 'partial_failed', 'failed'].includes(job.status); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const progressResponse = await fetch(`${api.baseUrl}/api/v1/document-render-jobs/${jobId}`);
      const progress = await progressResponse.json() as any;
      job = progress.job;
    }
    assert.equal(job.status, 'completed');

    await new Promise((resolve) => setTimeout(resolve, 60));
    const expiredResponse = await fetch(`${api.baseUrl}/api/v1/document-render-jobs/${jobId}`);
    assert.equal(expiredResponse.status, 404);
  } finally {
    restore();
    await api.close();
  }
});

test('异步任务支持提交、查询进度和读取最终结果', async () => {
  const restore = withPrivateTemplateUrls();
  const api = await startServer();
  try {
    await createTemplate(api.baseUrl);
    const submitResponse = await fetch(`${api.baseUrl}/api/v1/document-render-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', templateId: 'fbiftemp_20260512_001' },
        records: [
          { recordId: 'rec_1', variables: { 客户名称: '客户 1', 金额: '100 元' } },
          { recordId: 'rec_2', variables: { 客户名称: '客户 2', 金额: '200 元' } },
          { recordId: 'rec_3', variables: { 客户名称: '客户 3' } },
        ],
      }),
    });
    const submitted = await submitResponse.json() as any;
    assert.equal(submitResponse.status, 202);
    const jobId = submitted.job.jobId;

    let job = submitted.job;
    for (let index = 0; index < 20 && !['completed', 'partial_failed', 'failed'].includes(job.status); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const progressResponse = await fetch(`${api.baseUrl}/api/v1/document-render-jobs/${jobId}`);
      const progress = await progressResponse.json() as any;
      job = progress.job;
    }
    assert.equal(job.status, 'partial_failed');
    assert.equal(job.total, 3);
    assert.equal(job.processed, 3);
    assert.equal(job.succeeded, 2);
    assert.equal(job.failed, 1);

    const resultsResponse = await fetch(`${api.baseUrl}/api/v1/document-render-jobs/${jobId}/results`);
    const results = await resultsResponse.json() as any;
    assert.equal(results.count, 3);
    assert.equal(results.records.filter((record: any) => record.ok).length, 2);
    assert.equal(results.records.find((record: any) => record.recordId === 'rec_3').missingVariables[0], '金额');
  } finally {
    restore();
    await api.close();
  }
});

test('异步任务支持 500 条记录并返回最终 count 校验', { timeout: 20000 }, async () => {
  const restore = withPrivateTemplateUrls();
  const api = await startServer();
  try {
    await createTemplate(api.baseUrl);
    const records = Array.from({ length: 500 }, (_value, index) => ({
      recordId: `rec_${String(index + 1).padStart(3, '0')}`,
      variables: {
        客户名称: `客户 ${index + 1}`,
        金额: `${index + 1}00 元`,
      },
    }));
    const submitStartedAt = Date.now();
    const submitResponse = await fetch(`${api.baseUrl}/api/v1/document-render-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'docx', templateId: 'fbiftemp_20260512_001' },
        records,
      }),
    });
    const submitted = await submitResponse.json() as any;
    assert.equal(submitResponse.status, 202);
    assert.equal(submitted.job.total, 500);
    assert.ok(Date.now() - submitStartedAt < 2000, '提交任务不应等待 500 条全部生成完成');

    const jobId = submitted.job.jobId;
    let job = submitted.job;
    for (let index = 0; index < 120 && !['completed', 'partial_failed', 'failed'].includes(job.status); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const progressResponse = await fetch(`${api.baseUrl}/api/v1/document-render-jobs/${jobId}`);
      const progress = await progressResponse.json() as any;
      job = progress.job;
    }
    assert.equal(job.status, 'completed');
    assert.equal(job.total, 500);
    assert.equal(job.processed, 500);
    assert.equal(job.succeeded, 500);
    assert.equal(job.failed, 0);

    const resultsResponse = await fetch(`${api.baseUrl}/api/v1/document-render-jobs/${jobId}/results`);
    const results = await resultsResponse.json() as any;
    assert.equal(results.count, 500);
    assert.equal(results.records.length, 500);
    assert.equal(results.records.filter((record: any) => record.ok).length, 500);
  } finally {
    restore();
    await api.close();
  }
});
