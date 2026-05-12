import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { documentRenderJsonParser } from './documentRenderBodyParser';
import {
  createConfiguredStorage,
  type DocumentRenderRequest,
  type DocumentRenderStorage,
} from './documentRenderApi';
import { imageVariableMapSchema } from './documentRenderImages';
import type { DocumentTemplateResolver } from './documentTemplateApi';
import {
  renderBatchRecords,
  type DocumentRenderBatchRecordInput,
  type DocumentRenderBatchRecordResult,
} from './documentRenderBatchApi';

const MAX_JOB_RECORDS = 500;

type RenderJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'partial_failed';

type RenderJob = {
  jobId: string;
  status: RenderJobStatus;
  template: DocumentRenderRequest['template'];
  output?: DocumentRenderRequest['output'];
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  records: DocumentRenderBatchRecordInput[];
  results: DocumentRenderBatchRecordResult[];
  createdAt: string;
  updatedAt: string;
  error?: string;
};

const variableMapSchema = z.custom<Record<string, string | number | boolean | null>>((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>)
    .every((item) => ['string', 'number', 'boolean'].includes(typeof item) || item === null);
});

const jobSchema = z.object({
  template: z.object({
    format: z.enum(['doc', 'docx']),
    title: z.string().trim().max(255).optional(),
    content: z.string().optional(),
    url: z.string().trim().optional(),
    templateId: z.string().trim().optional(),
    versionId: z.string().trim().optional(),
    fileName: z.string().trim().max(255).optional(),
  }),
  output: z.object({
    fileName: z.string().trim().max(255).optional(),
    expiresInSeconds: z.number().int().positive().max(7 * 24 * 60 * 60).optional(),
  }).optional(),
  records: z.array(z.object({
    recordId: z.string().trim().min(1).max(128),
    variables: variableMapSchema.default({}),
    imageVariables: imageVariableMapSchema.optional(),
    output: z.object({
      fileName: z.string().trim().max(255).optional(),
      expiresInSeconds: z.number().int().positive().max(7 * 24 * 60 * 60).optional(),
    }).optional(),
  })).min(1).max(MAX_JOB_RECORDS),
});

function publicJob(job: RenderJob) {
  return {
    jobId: job.jobId,
    status: job.status,
    total: job.total,
    processed: job.processed,
    succeeded: job.succeeded,
    failed: job.failed,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
  };
}

async function runJob(job: RenderJob, storage: DocumentRenderStorage, templateResolver?: DocumentTemplateResolver): Promise<void> {
  job.status = 'running';
  job.updatedAt = new Date().toISOString();
  try {
    job.results = await renderBatchRecords({
      template: job.template,
      output: job.output,
      records: job.records,
    }, {
      storage,
      templateResolver,
      onProgress(result) {
        job.processed += 1;
        if (result.ok) job.succeeded += 1;
        else job.failed += 1;
        job.updatedAt = new Date().toISOString();
      },
    });
    job.status = job.failed > 0 ? 'partial_failed' : 'completed';
    job.updatedAt = new Date().toISOString();
  } catch (error) {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : '任务执行失败。';
    job.updatedAt = new Date().toISOString();
  }
}

export function createDocumentRenderJobRouter(options: {
  storage?: DocumentRenderStorage;
  storageDir?: string;
  templateResolver?: DocumentTemplateResolver;
} = {}): express.Router {
  const router = express.Router();
  const storage = options.storage || createConfiguredStorage(options.storageDir);
  const jobs = new Map<string, RenderJob>();
  router.use(documentRenderJsonParser);

  router.post('/', async (request, response) => {
    const requestId = randomUUID();
    const parsed = jobSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, requestId, error: '请求参数不合法。' });
      return;
    }
    const now = new Date().toISOString();
    const job: RenderJob = {
      jobId: `job_${Date.now()}_${randomUUID().slice(0, 8)}`,
      status: 'pending',
      template: parsed.data.template,
      output: parsed.data.output,
      total: parsed.data.records.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      records: parsed.data.records,
      results: [],
      createdAt: now,
      updatedAt: now,
    };
    jobs.set(job.jobId, job);
    setImmediate(() => { void runJob(job, storage, options.templateResolver); });
    response.status(202).json({ ok: true, requestId, job: publicJob(job) });
  });

  router.get('/:jobId', (request, response) => {
    const requestId = randomUUID();
    const job = jobs.get(String(request.params.jobId || ''));
    if (!job) {
      response.status(404).json({ ok: false, requestId, error: '任务不存在。' });
      return;
    }
    response.json({ ok: true, requestId, job: publicJob(job) });
  });

  router.get('/:jobId/results', (request, response) => {
    const requestId = randomUUID();
    const job = jobs.get(String(request.params.jobId || ''));
    if (!job) {
      response.status(404).json({ ok: false, requestId, error: '任务不存在。' });
      return;
    }
    response.json({
      ok: true,
      requestId,
      job: publicJob(job),
      count: job.results.length,
      records: job.results,
    });
  });

  return router;
}
