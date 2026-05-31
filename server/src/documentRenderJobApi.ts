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

// Job 存储接口：支持内存 Map（测试用）和 PostgreSQL（生产用）
interface JobStore {
  insert(job: { jobId: string; status: string; templateJson: string; outputJson?: string; total: number; recordsJson: string; expiresAt: string }): Promise<void>;
  get(jobId: string): Promise<{ jobId: string; status: string; templateJson: string; outputJson: string | null; total: number; processed: number; succeeded: number; failed: number; recordsJson: string; resultsJson: string; error: string | null; createdAt: string; updatedAt: string; expiresAt: string } | undefined>;
  update(jobId: string, updates: { status?: string; processed?: number; succeeded?: number; failed?: number; resultsJson?: string; error?: string }): Promise<void>;
  cleanup(): Promise<number>;
  markStaleAsFailed(): Promise<number>;
}

// 内存 Job 存储（测试用）
function createMemoryJobStore(): JobStore {
  const jobs = new Map<string, {
    jobId: string; status: string; templateJson: string; outputJson: string | null;
    total: number; processed: number; succeeded: number; failed: number;
    recordsJson: string; resultsJson: string; error: string | null;
    createdAt: string; updatedAt: string; expiresAt: string;
  }>();
  return {
    async insert(job) {
      const now = new Date().toISOString();
      jobs.set(job.jobId, {
        ...job,
        outputJson: job.outputJson ?? null,
        processed: 0, succeeded: 0, failed: 0,
        resultsJson: '[]', error: null,
        createdAt: now, updatedAt: now,
      });
    },
    async get(jobId) { return jobs.get(jobId); },
    async update(jobId, updates) {
      const job = jobs.get(jobId);
      if (!job) return;
      if (updates.status !== undefined) job.status = updates.status;
      if (updates.processed !== undefined) job.processed = updates.processed;
      if (updates.succeeded !== undefined) job.succeeded = updates.succeeded;
      if (updates.failed !== undefined) job.failed = updates.failed;
      if (updates.resultsJson !== undefined) job.resultsJson = updates.resultsJson;
      if (updates.error !== undefined) job.error = updates.error;
      job.updatedAt = new Date().toISOString();
    },
    async cleanup() {
      const now = Date.now();
      let count = 0;
      for (const [id, job] of jobs) {
        if (['completed', 'failed', 'partial_failed'].includes(job.status) && Date.parse(job.expiresAt) <= now) {
          jobs.delete(id);
          count++;
        }
      }
      return count;
    },
    async markStaleAsFailed() {
      let count = 0;
      for (const job of jobs.values()) {
        if (job.status === 'pending' || job.status === 'running') {
          job.status = 'failed';
          job.error = '服务重启，任务中断';
          job.updatedAt = new Date().toISOString();
          count++;
        }
      }
      return count;
    },
  };
}

// PostgreSQL Job 存储（生产用）
function createPostgresJobStore(): JobStore | null {
  try {
    // 延迟导入，避免测试环境报错
    const storage = require('./storage');
    return {
      async insert(job) { await storage.insertRenderJob(job); },
      async get(jobId) { return storage.getRenderJob(jobId); },
      async update(jobId, updates) { await storage.updateRenderJob(jobId, updates); },
      async cleanup() { return storage.cleanupExpiredRenderJobs(); },
      async markStaleAsFailed() { return storage.markStaleRenderJobsAsFailed(); },
    };
  } catch {
    return null;
  }
}

const MAX_JOB_RECORDS = 500;
const DEFAULT_JOB_TTL_MS = 24 * 60 * 60 * 1000;

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

function rowToJob(row: { jobId: string; status: string; templateJson: string; outputJson: string | null; total: number; processed: number; succeeded: number; failed: number; recordsJson: string; resultsJson: string; error: string | null; createdAt: string; updatedAt: string; expiresAt: string }): RenderJob {
  return {
    jobId: row.jobId,
    status: row.status as RenderJobStatus,
    template: JSON.parse(row.templateJson),
    output: row.outputJson ? JSON.parse(row.outputJson) : undefined,
    total: row.total,
    processed: row.processed,
    succeeded: row.succeeded,
    failed: row.failed,
    records: JSON.parse(row.recordsJson),
    results: JSON.parse(row.resultsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    error: row.error ?? undefined,
  };
}

async function runJob(job: RenderJob, storage: DocumentRenderStorage, ttlMs: number, jobStore: JobStore, templateResolver?: DocumentTemplateResolver): Promise<void> {
  await jobStore.update(job.jobId, { status: 'running' });
  job.status = 'running';
  try {
    job.results = await renderBatchRecords({
      template: job.template,
      output: job.output,
      records: job.records,
    }, {
      storage,
      templateResolver,
      async onProgress(result) {
        job.processed += 1;
        if (result.ok) job.succeeded += 1;
        else job.failed += 1;
        await jobStore.update(job.jobId, {
          processed: job.processed,
          succeeded: job.succeeded,
          failed: job.failed,
        });
      },
    });
    job.status = job.failed > 0 ? 'partial_failed' : 'completed';
    await jobStore.update(job.jobId, {
      status: job.status,
      resultsJson: JSON.stringify(job.results),
    });
  } catch (error) {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : '任务执行失败。';
    await jobStore.update(job.jobId, {
      status: 'failed',
      error: job.error,
    });
  }
}

export function createDocumentRenderJobRouter(options: {
  storage?: DocumentRenderStorage;
  storageDir?: string;
  templateResolver?: DocumentTemplateResolver;
  jobTtlMs?: number;
  jobStore?: JobStore;
} = {}): express.Router {
  const router = express.Router();
  const storage = options.storage || createConfiguredStorage(options.storageDir);
  const jobTtlMs = getJobTtlMs(options.jobTtlMs);
  // 优先使用传入的 jobStore，否则尝试 PostgreSQL，最后降级到内存
  const jobStore = options.jobStore || createPostgresJobStore() || createMemoryJobStore();
  router.use(documentRenderJsonParser);

  // 服务启动时标记 stale job 为 failed
  jobStore.markStaleAsFailed().catch(() => undefined);

  router.post('/', async (request, response) => {
    const requestId = randomUUID();
    const parsed = jobSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, requestId, error: '请求参数不合法。' });
      return;
    }

    // 清理过期 job
    jobStore.cleanup().catch(() => undefined);

    const now = new Date().toISOString();
    const jobId = `job_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const expiresAt = new Date(Date.now() + jobTtlMs).toISOString();

    const job: RenderJob = {
      jobId,
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
      expiresAt,
    };

    await jobStore.insert({
      jobId,
      status: 'pending',
      templateJson: JSON.stringify(job.template),
      outputJson: job.output ? JSON.stringify(job.output) : undefined,
      total: job.total,
      recordsJson: JSON.stringify(job.records),
      expiresAt,
    });

    setImmediate(() => { void runJob(job, storage, jobTtlMs, jobStore, options.templateResolver); });
    response.status(202).json({ ok: true, requestId, job: publicJob(job) });
  });

  router.get('/:jobId', async (request, response) => {
    const requestId = randomUUID();
    jobStore.cleanup().catch(() => undefined);
    const row = await jobStore.get(String(request.params.jobId || ''));
    if (!row) {
      response.status(404).json({ ok: false, requestId, error: '任务不存在。' });
      return;
    }
    const job = rowToJob(row);
    response.json({ ok: true, requestId, job: publicJob(job) });
  });

  router.get('/:jobId/results', async (request, response) => {
    const requestId = randomUUID();
    jobStore.cleanup().catch(() => undefined);
    const row = await jobStore.get(String(request.params.jobId || ''));
    if (!row) {
      response.status(404).json({ ok: false, requestId, error: '任务不存在。' });
      return;
    }
    const job = rowToJob(row);
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
