import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { documentRenderJsonParser } from './documentRenderBodyParser';
import { UserFacingError } from './documentRenderStorageErrors';
import { DocumentTemplateService } from './documentTemplateService';
import type { LoadedDocumentTemplate } from './documentTemplateService';

const createTemplateSchema = z.object({
  templateId: z.string().trim().optional(),
  name: z.string().trim().max(255).optional(),
  url: z.string().trim().min(1),
  fileName: z.string().trim().max(255).optional(),
});

export type DocumentTemplateResolver = {
  loadTemplate(templateId: string, versionId?: string): Promise<LoadedDocumentTemplate>;
};

function getRequestId(request: express.Request): string {
  const headerValue = request.headers['x-request-id'];
  const requestId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof requestId === 'string' && requestId.trim() ? requestId.trim().slice(0, 128) : randomUUID();
}

function sendError(response: express.Response, requestId: string, error: unknown): void {
  if (error instanceof UserFacingError) {
    response.status(400).json({ ok: false, requestId, error: error.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`[document-template:${requestId}]`, error instanceof Error ? error.message : String(error));
  response.status(500).json({ ok: false, requestId, error: '模板服务暂时不可用，请稍后重试。' });
}

export function createDocumentTemplateRouter(service = new DocumentTemplateService()): express.Router {
  const router = express.Router();
  router.use(documentRenderJsonParser);

  router.get('/', async (request, response) => {
    const requestId = getRequestId(request);
    try {
      const includeDeleted = String(request.query.includeDeleted || '').toLowerCase() === 'true';
      response.json({ ok: true, requestId, templates: await service.listTemplates({ includeDeleted }) });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  router.post('/', async (request, response) => {
    const requestId = getRequestId(request);
    const parsed = createTemplateSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, requestId, error: '请求参数不合法。' });
      return;
    }
    try {
      response.json({ ok: true, requestId, template: await service.createTemplate(parsed.data) });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  router.get('/:templateId', async (request, response) => {
    const requestId = getRequestId(request);
    try {
      response.json({ ok: true, requestId, template: await service.getTemplate(String(request.params.templateId || '')) });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  router.get('/:templateId/versions', async (request, response) => {
    const requestId = getRequestId(request);
    try {
      const template = await service.getTemplate(String(request.params.templateId || ''));
      response.json({ ok: true, requestId, templateId: template.templateId, activeVersionId: template.activeVersionId, versions: template.versions });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  router.post('/:templateId/versions', async (request, response) => {
    const requestId = getRequestId(request);
    const parsed = createTemplateSchema.omit({ templateId: true }).safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, requestId, error: '请求参数不合法。' });
      return;
    }
    try {
      response.json({ ok: true, requestId, template: await service.addVersion(String(request.params.templateId || ''), parsed.data) });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  router.delete('/:templateId', async (request, response) => {
    const requestId = getRequestId(request);
    try {
      const purge = String(request.query.purge || '').toLowerCase() === 'true';
      response.json({ ok: true, requestId, template: await service.deleteTemplate(String(request.params.templateId || ''), { purge }) });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  return router;
}
