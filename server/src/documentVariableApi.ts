// 变量词典接口：/api/v1/document-variables。多维表格「变量」表按行同步过来，键用表格行号。
// 读：能过接口钥匙/登录的都能读；写：只认 API Key 或模板管理员。
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { documentTemplateJsonParser } from './documentRenderBodyParser';
import { UserFacingError } from './documentRenderStorageErrors';
import { resolveDefaultDocumentTemplateActor, type DocumentTemplateActor } from './documentTemplateApi';
import type { DocumentVariableStore } from './documentVariableDictionary';

const upsertVariableSchema = z.object({
  name: z.string().trim().min(1).max(64),
  aliases: z.union([z.string().max(2000), z.array(z.string().max(64)).max(50)]).optional(),
  description: z.string().trim().max(500).optional(),
  format: z.string().trim().max(64).optional(),
});

export type DocumentVariableRouterOptions = {
  resolveActor?: (request: express.Request) => Promise<DocumentTemplateActor>;
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
  console.error(`[document-variable:${requestId}]`, error instanceof Error ? error.message : String(error));
  response.status(500).json({ ok: false, requestId, error: '变量词典暂时不可用，请稍后重试。' });
}

export function createDocumentVariableRouter(
  store: Pick<DocumentVariableStore, 'list' | 'upsert' | 'remove'>,
  options: DocumentVariableRouterOptions = {},
): express.Router {
  const router = express.Router();
  router.use(documentTemplateJsonParser);
  const resolveActor = options.resolveActor || ((request: express.Request) => resolveDefaultDocumentTemplateActor(request));

  async function requireWriter(request: express.Request, response: express.Response, requestId: string): Promise<boolean> {
    const actor = await resolveActor(request).catch(() => ({ isAdmin: false }));
    if (actor.isAdmin) return true;
    response.status(403).json({ ok: false, requestId, error: '只有管理员可以修改变量词典。' });
    return false;
  }

  router.get('/', async (request, response) => {
    const requestId = getRequestId(request);
    try {
      response.json({ ok: true, requestId, variables: await store.list() });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  router.put('/:variableId', async (request, response) => {
    const requestId = getRequestId(request);
    const parsed = upsertVariableSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, requestId, error: '请求参数不合法。' });
      return;
    }
    try {
      if (!await requireWriter(request, response, requestId)) return;
      response.json({ ok: true, requestId, variable: await store.upsert(String(request.params.variableId || ''), parsed.data) });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  router.delete('/:variableId', async (request, response) => {
    const requestId = getRequestId(request);
    try {
      if (!await requireWriter(request, response, requestId)) return;
      const deleted = await store.remove(String(request.params.variableId || ''));
      response.json({ ok: true, requestId, deleted });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  return router;
}
