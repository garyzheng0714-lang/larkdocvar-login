import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { documentTemplateJsonParser } from './documentRenderBodyParser';
import { UserFacingError } from './documentRenderStorageErrors';
import { DocumentTemplateService } from './documentTemplateService';
import type { LoadedDocumentTemplate } from './documentTemplateService';
import { peekSessionForRequest } from './auth';
import { hasValidDocumentRenderApiKey } from './documentRenderApiKeyGuard';

const templateInputSchema = z.object({
  templateId: z.string().trim().optional(),
  name: z.string().trim().max(255).optional(),
  url: z.string().trim().min(1).optional(),
  fileBase64: z.string().trim().min(1).optional(),
  fileName: z.string().trim().max(255).optional(),
  category: z.string().trim().max(64).optional(),
  visibility: z.enum(['private', 'shared']).optional(),
  description: z.string().trim().max(1000).optional(),
});

const createTemplateSchema = templateInputSchema.refine((value) => Boolean(value.url || value.fileBase64), {
  message: '模板链接或模板文件不能为空。',
});

const createTemplateVersionSchema = templateInputSchema.omit({ templateId: true }).refine((value) => Boolean(value.url || value.fileBase64), {
  message: '模板链接或模板文件不能为空。',
});

export type DocumentTemplateResolver = {
  loadTemplate(templateId: string, versionId?: string): Promise<LoadedDocumentTemplate>;
};

export type DocumentTemplateActor = {
  openId?: string;
  isAdmin: boolean;
};

export type DocumentTemplateRouterOptions = {
  enforceOwnership?: boolean;
  resolveActor?: (request: express.Request) => Promise<DocumentTemplateActor>;
};

function isAdminOpenId(openId: string | undefined): boolean {
  if (!openId) return false;
  return (process.env.DOCUMENT_TEMPLATE_ADMIN_OPEN_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(openId);
}

export async function resolveDefaultDocumentTemplateActor(request: express.Request): Promise<DocumentTemplateActor> {
  const session = await peekSessionForRequest(request).catch(() => null);
  const openId = session?.profile.openId;
  return {
    openId,
    isAdmin: hasValidDocumentRenderApiKey(request) || isAdminOpenId(openId),
  };
}

async function requireTemplateActor(
  request: express.Request,
  response: express.Response,
  requestId: string,
  options: DocumentTemplateRouterOptions,
): Promise<DocumentTemplateActor | null> {
  if (!options.enforceOwnership) return { isAdmin: true };
  const actor = await (options.resolveActor || resolveDefaultDocumentTemplateActor)(request);
  if (actor.isAdmin || actor.openId) return actor;
  response.status(401).json({ ok: false, requestId, error: '登录状态没有接上，当前文件和填写内容已保留。请重新打开飞书侧边栏或登录后再点保存。' });
  return null;
}

function canManageTemplate(
  template: { createdByOpenId?: string },
  actor: DocumentTemplateActor,
): boolean {
  return actor.isAdmin || Boolean(actor.openId && template.createdByOpenId === actor.openId);
}

export function canReadDocumentTemplate(
  template: { visibility?: 'private' | 'shared'; createdByOpenId?: string },
  actor: DocumentTemplateActor,
): boolean {
  return actor.isAdmin || template.visibility !== 'private' || Boolean(actor.openId && template.createdByOpenId === actor.openId);
}

async function resolveTemplateReader(
  request: express.Request,
  options: DocumentTemplateRouterOptions,
): Promise<DocumentTemplateActor> {
  if (!options.enforceOwnership) return { isAdmin: true };
  return (options.resolveActor || resolveDefaultDocumentTemplateActor)(request).catch(() => ({ isAdmin: false }));
}

async function requireTemplateManager(
  request: express.Request,
  response: express.Response,
  requestId: string,
  service: DocumentTemplateService,
  templateId: string,
  options: DocumentTemplateRouterOptions,
): Promise<DocumentTemplateActor | null> {
  const actor = await requireTemplateActor(request, response, requestId, options);
  if (!actor) return null;
  const template = await service.getTemplate(templateId);
  if (canManageTemplate(template, actor)) return actor;
  response.status(403).json({ ok: false, requestId, error: '只有管理员或模板创建者可以修改此模板。' });
  return null;
}

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

export function createDocumentTemplateRouter(
  service = new DocumentTemplateService(),
  options: DocumentTemplateRouterOptions = {},
): express.Router {
  const router = express.Router();
  router.use(documentTemplateJsonParser);

  router.get('/', async (request, response) => {
    const requestId = getRequestId(request);
    try {
      const includeDeleted = String(request.query.includeDeleted || '').toLowerCase() === 'true';
      const actor = await resolveTemplateReader(request, options);
      const templates = (await service.listTemplates({ includeDeleted })).filter((template) => canReadDocumentTemplate(template, actor));
      response.json({ ok: true, requestId, templates });
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
      const actor = await requireTemplateActor(request, response, requestId, options);
      if (!actor) return;
      response.json({
        ok: true,
        requestId,
        template: await service.createTemplate({
          ...parsed.data,
          createdByOpenId: actor.openId,
          updatedByOpenId: actor.openId,
        }),
      });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  router.get('/:templateId', async (request, response) => {
    const requestId = getRequestId(request);
    try {
      const actor = await resolveTemplateReader(request, options);
      const template = await service.getTemplate(String(request.params.templateId || ''));
      if (!canReadDocumentTemplate(template, actor)) {
        response.status(403).json({ ok: false, requestId, error: '没有权限查看此模板。' });
        return;
      }
      response.json({ ok: true, requestId, template });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  router.get('/:templateId/versions', async (request, response) => {
    const requestId = getRequestId(request);
    try {
      const actor = await resolveTemplateReader(request, options);
      const template = await service.getTemplate(String(request.params.templateId || ''));
      if (!canReadDocumentTemplate(template, actor)) {
        response.status(403).json({ ok: false, requestId, error: '没有权限查看此模板。' });
        return;
      }
      response.json({ ok: true, requestId, templateId: template.templateId, activeVersionId: template.activeVersionId, versions: template.versions });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  router.post('/:templateId/versions', async (request, response) => {
    const requestId = getRequestId(request);
    const parsed = createTemplateVersionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, requestId, error: '请求参数不合法。' });
      return;
    }
    try {
      const templateId = String(request.params.templateId || '');
      const actor = await requireTemplateManager(request, response, requestId, service, templateId, options);
      if (!actor) return;
      response.json({
        ok: true,
        requestId,
        template: await service.addVersion(templateId, { ...parsed.data, updatedByOpenId: actor.openId }),
      });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  router.delete('/:templateId', async (request, response) => {
    const requestId = getRequestId(request);
    try {
      const templateId = String(request.params.templateId || '');
      const actor = await requireTemplateManager(request, response, requestId, service, templateId, options);
      if (!actor) return;
      const purge = String(request.query.purge || '').toLowerCase() === 'true';
      response.json({ ok: true, requestId, template: await service.deleteTemplate(templateId, { purge }) });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  return router;
}
