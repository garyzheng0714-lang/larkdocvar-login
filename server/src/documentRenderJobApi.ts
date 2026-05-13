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
const DEFAULT_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_JOBS = 100;

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
  expiresAt: string;
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
    includeFileBase64: z.boolean().optional(),
  }).optional(),
  records: z.array(z.object({
    recordId: z.string().trim().min(1).max(128),
    variables: variableMapSchema.default({}),
    imageVariables: imageVariableMapSchema.optional(),
    output: z.object({
      fileName: z.string().trim().max(255).optional(),
      expiresInSeconds: z.number().int().positive().max(7 * 24 * 60 * 60).optional(),
      includeFileBase64: z.boolean().optional(),
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
    expiresAt: job.expiresAt,
    error: job.error,
  };
}

function getJobTtlMs(value: number | undefined): number {
  const fromEnv = Number(process.env.DOCUMENT_RENDER_JOB_TTL_SECONDS || 0);
  if (value !== undefined) return Math.max(1, value);
  const ttlMs = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv * 1000 : DEFAULT_JOB_TTL_MS;
  return Math.max(1000, ttlMs);
}

function getMaxJobs(value: number | undefined): number {
  const fromEnv = Number(process.env.DOCUMENT_RENDER_MAX_JOBS || 0);
  const maxJobs = value ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MAX_JOBS);
  return Math.max(1, Math.floor(maxJobs));
}

function refreshExpiresAt(job: RenderJob, ttlMs: number): void {
  job.expiresAt = new Date(Date.now() + ttlMs).toISOString();
}

function isTerminalJob(job: RenderJob): boolean {
  return ['completed', 'partial_failed', 'failed'].includes(job.status);
}

function cleanupJobs(jobs: Map<string, RenderJob>, maxJobs: number, now = Date.now()): void {
  for (const [jobId, job] of jobs) {
    if (isTerminalJob(job) && Date.parse(job.expiresAt) <= now) jobs.delete(jobId);
  }
  if (jobs.size <= maxJobs) return;
  const removable = Array.from(jobs.values())
    .filter(isTerminalJob)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const job of removable) {
    if (jobs.size <= maxJobs) return;
    jobs.delete(job.jobId);
  }
}

async function runJob(job: RenderJob, storage: DocumentRenderStorage, ttlMs: number, templateResolver?: DocumentTemplateResolver): Promise<void> {
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
    refreshExpiresAt(job, ttlMs);
  } catch (error) {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : '任务执行失败。';
    job.updatedAt = new Date().toISOString();
    refreshExpiresAt(job, ttlMs);
  }
}

export function createDocumentRenderJobRouter(options: {
  storage?: DocumentRenderStorage;
  storageDir?: string;
  templateResolver?: DocumentTemplateResolver;
  jobTtlMs?: number;
  maxJobs?: number;
} = {}): express.Router {
  const router = express.Router();
  const storage = options.storage || createConfiguredStorage(options.storageDir);
  const jobs = new Map<string, RenderJob>();
  const jobTtlMs = getJobTtlMs(options.jobTtlMs);
  const maxJobs = getMaxJobs(options.maxJobs);
  router.use(documentRenderJsonParser);

  router.post('/', async (request, response) => {
    const requestId = randomUUID();
    const parsed = jobSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, requestId, error: '请求参数不合法。' });
      return;
    }
    const now = new Date().toISOString();
    cleanupJobs(jobs, maxJobs);
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
      expiresAt: new Date(Date.now() + jobTtlMs).toISOString(),
    };
    jobs.set(job.jobId, job);
    cleanupJobs(jobs, maxJobs);
    setImmediate(() => { void runJob(job, storage, jobTtlMs, options.templateResolver); });
    response.status(202).json({ ok: true, requestId, job: publicJob(job) });
  });

  router.get('/:jobId', (request, response) => {
    const requestId = randomUUID();
    cleanupJobs(jobs, maxJobs);
    const job = jobs.get(String(request.params.jobId || ''));
    if (!job) {
      response.status(404).json({ ok: false, requestId, error: '任务不存在。' });
      return;
    }
    response.json({ ok: true, requestId, job: publicJob(job) });
  });

  router.get('/:jobId/results', (request, response) => {
    const requestId = randomUUID();
    cleanupJobs(jobs, maxJobs);
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
