import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { documentRenderJsonParser } from './documentRenderBodyParser';
import {
  createConfiguredStorage,
  renderDocumentRequest,
  type DocumentRenderRequest,
  type DocumentRenderStorage,
} from './documentRenderApi';
import { imageVariableMapSchema } from './documentRenderImages';
import type { DocumentTemplateResolver } from './documentTemplateApi';
import { UserFacingError } from './documentRenderStorageErrors';

const variableMapSchema = z.custom<Record<string, string | number | boolean | null>>((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>)
    .every((item) => ['string', 'number', 'boolean'].includes(typeof item) || item === null);
});

const templateSchema = z.object({
  format: z.enum(['doc', 'docx']),
  title: z.string().trim().max(255).optional(),
  content: z.string().optional(),
  url: z.string().trim().optional(),
  templateId: z.string().trim().optional(),
  versionId: z.string().trim().optional(),
  fileName: z.string().trim().max(255).optional(),
});

const outputSchema = z.object({
  fileName: z.string().trim().max(255).optional(),
  expiresInSeconds: z.number().int().positive().max(7 * 24 * 60 * 60).optional(),
  includeFileBase64: z.boolean().optional(),
}).optional();

export type DocumentRenderBatchRecordInput = {
  recordId: string;
  variables: Record<string, string | number | boolean | null>;
  imageVariables?: DocumentRenderRequest['imageVariables'];
  output?: DocumentRenderRequest['output'];
};

export type DocumentRenderBatchInput = {
  template: DocumentRenderRequest['template'];
  output?: DocumentRenderRequest['output'];
  records: DocumentRenderBatchRecordInput[];
};

export type DocumentRenderBatchRecordResult = {
  recordId: string;
  ok: boolean;
  requestId: string;
  document?: unknown;
  variables?: unknown;
  images?: unknown;
  download?: unknown;
  error?: string;
  missingVariables?: string[];
  unusedVariables?: string[];
};

function createBatchSchema(maxRecords: number) {
  return z.object({
    template: templateSchema,
    output: outputSchema,
    records: z.array(z.object({
      recordId: z.string().trim().min(1).max(128),
      variables: variableMapSchema.default({}),
      imageVariables: imageVariableMapSchema.optional(),
      output: outputSchema,
    })).min(1).max(maxRecords),
  });
}

function toErrorResult(recordId: string, requestId: string, error: unknown): DocumentRenderBatchRecordResult {
  const result: DocumentRenderBatchRecordResult = {
    recordId,
    ok: false,
    requestId,
    error: error instanceof UserFacingError ? error.message : 'Docx 文档生成失败，请稍后重试。',
  };
  if (error && typeof error === 'object' && Array.isArray((error as { missingVariables?: unknown }).missingVariables)) {
    result.missingVariables = (error as { missingVariables: string[] }).missingVariables;
  }
  if (error && typeof error === 'object' && Array.isArray((error as { unusedVariables?: unknown }).unusedVariables)) {
    result.unusedVariables = (error as { unusedVariables: string[] }).unusedVariables;
  }
  return result;
}

export async function renderBatchRecords(
  input: DocumentRenderBatchInput,
  options: {
    storage: DocumentRenderStorage;
    templateResolver?: DocumentTemplateResolver;
    onProgress?: (result: DocumentRenderBatchRecordResult, index: number) => void;
  },
): Promise<DocumentRenderBatchRecordResult[]> {
  const results: DocumentRenderBatchRecordResult[] = [];
  for (let index = 0; index < input.records.length; index += 1) {
    const record = input.records[index];
    const requestId = randomUUID();
    try {
      const rendered = await renderDocumentRequest({
        template: input.template,
        variables: record.variables,
        imageVariables: record.imageVariables || {},
        output: record.output || input.output,
      }, options.storage, requestId, options.templateResolver) as {
        document?: unknown;
        variables?: unknown;
        images?: unknown;
        download?: unknown;
      };
      results.push({
        recordId: record.recordId,
        ok: true,
        requestId,
        document: rendered.document,
        variables: rendered.variables,
        images: rendered.images,
        download: rendered.download,
      });
    } catch (error) {
      results.push(toErrorResult(record.recordId, requestId, error));
    }
    options.onProgress?.(results[results.length - 1], index + 1);
  }
  return results;
}

export function createDocumentRenderBatchRouter(options: {
  storage?: DocumentRenderStorage;
  storageDir?: string;
  templateResolver?: DocumentTemplateResolver;
  maxRecords?: number;
} = {}): express.Router {
  const router = express.Router();
  const storage = options.storage || createConfiguredStorage(options.storageDir);
  const schema = createBatchSchema(options.maxRecords || 100);
  router.use(documentRenderJsonParser);

  router.post('/batch', async (request, response) => {
    const requestId = randomUUID();
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, requestId, error: '请求参数不合法。' });
      return;
    }
    const records = await renderBatchRecords(parsed.data, { storage, templateResolver: options.templateResolver });
    const succeeded = records.filter((record) => record.ok).length;
    response.json({
      ok: true,
      requestId,
      total: records.length,
      succeeded,
      failed: records.length - succeeded,
      records,
    });
  });

  return router;
}

export const __test__ = {
  createBatchSchema,
};
