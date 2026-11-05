// 变量词典接口：/api/v1/document-variables。多维表格「变量」表按行同步过来，键用表格行号。
// 读：能过接口钥匙/登录的都能读；写：只认 API Key 或模板管理员。
// 写成功、或 errorMode=body 下出错，都带一句 summaryText，自动化直接写回「同步结果」。
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { documentTemplateBodyParser } from './documentRenderBodyParser';
import { UserFacingError } from './documentRenderStorageErrors';
import { resolveDefaultDocumentTemplateActor, type DocumentTemplateActor } from './documentTemplateApi';
import type { DocumentVariableStore } from './documentVariableDictionary';

// 表单体里勾选框是 "true"/"false" 字符串。
const TRUE_TEXT = new Set(['true', '1', 'yes', 'on', '是']);
const flagSchema = z.union([z.boolean(), z.string().max(16)]).optional()
  .transform((value) => value === true || (typeof value === 'string' && TRUE_TEXT.has(value.trim().toLowerCase())));

const upsertVariableSchema = z.object({
  // 标准名为空（行里名字被清掉）或 disabled 为真时，按这一行不再算变量处理：从词典移除。
  name: z.string().trim().max(64).optional().default(''),
  aliases: z.union([z.string().max(2000), z.array(z.string().max(64)).max(50)]).optional(),
  description: z.string().trim().max(500).optional(),
  format: z.string().trim().max(64).optional(),
  disabled: flagSchema,
  errorMode: z.enum(['status', 'body']).optional(),
});

const syncTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

export type DocumentVariableRouterOptions = {
  resolveActor?: (request: express.Request) => Promise<DocumentTemplateActor>;
};

function getRequestId(request: express.Request): string {
  const headerValue = request.headers['x-request-id'];
  const requestId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof requestId === 'string' && requestId.trim() ? requestId.trim().slice(0, 128) : randomUUID();
}

const ERROR_CODE_BY_STATUS: Record<number, string> = { 400: 'REJECTED', 403: 'FORBIDDEN', 500: 'INTERNAL_ERROR' };

// 写接口可选 errorMode=body（请求体或 ?errorMode=body）：出错也回 200 带 errorCode，多维表格自动化才能把原因写回表格。
function wantsBodyErrors(request: express.Request): boolean {
  const body = request.body as { errorMode?: unknown } | undefined;
  return request.query.errorMode === 'body' || Boolean(body && typeof body === 'object' && body.errorMode === 'body');
}

function sendJsonError(request: express.Request, response: express.Response, status: number, payload: { ok: false; requestId: string; error: string }, errorCode?: string): void {
  if (!wantsBodyErrors(request)) {
    response.status(status).json(payload);
    return;
  }
  response.status(200).json({
    ...payload,
    errorCode: errorCode || ERROR_CODE_BY_STATUS[status] || 'REJECTED',
    ...(status >= 500 ? { retryable: true } : {}),
    summaryText: payload.error,
  });
}

function sendError(request: express.Request, response: express.Response, requestId: string, error: unknown): void {
  if (error instanceof UserFacingError) {
    sendJsonError(request, response, 400, { ok: false, requestId, error: error.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`[document-variable:${requestId}]`, error instanceof Error ? error.message : String(error));
  sendJsonError(request, response, 500, { ok: false, requestId, error: '变量词典暂时不可用，请稍后重试。' });
}

export function createDocumentVariableRouter(
  store: Pick<DocumentVariableStore, 'list' | 'upsert' | 'remove'>,
  options: DocumentVariableRouterOptions = {},
): express.Router {
  const router = express.Router();
  router.use(documentTemplateBodyParser);
  const resolveActor = options.resolveActor || ((request: express.Request) => resolveDefaultDocumentTemplateActor(request));

  async function requireWriter(request: express.Request, response: express.Response, requestId: string): Promise<boolean> {
    const actor = await resolveActor(request).catch(() => ({ isAdmin: false }));
    if (actor.isAdmin) return true;
    sendJsonError(request, response, 403, { ok: false, requestId, error: '只有管理员可以修改变量词典。' });
    return false;
  }

  router.get('/', async (request, response) => {
    const requestId = getRequestId(request);
    try {
      response.json({ ok: true, requestId, variables: await store.list() });
    } catch (error) {
      sendError(request, response, requestId, error);
    }
  });

  router.put('/:variableId', async (request, response) => {
    const requestId = getRequestId(request);
    const parsed = upsertVariableSchema.safeParse(request.body);
    if (!parsed.success) {
      sendJsonError(request, response, 400, { ok: false, requestId, error: '请求参数不合法。' }, 'INVALID_REQUEST');
      return;
    }
    try {
      if (!await requireWriter(request, response, requestId)) return;
      const { errorMode: _errorMode, disabled, ...input } = parsed.data;
      const variableId = String(request.params.variableId || '');
      const time = syncTimeFormat.format(new Date());
      if (disabled || !input.name) {
        const deleted = await store.remove(variableId);
        const summaryText = disabled ? `已停用 ${time}` : (deleted ? '没填标准名，已移出词典' : '先填标准名');
        response.json({ ok: true, requestId, deleted, summaryText });
        return;
      }
      response.json({ ok: true, requestId, variable: await store.upsert(variableId, input), summaryText: `已同步 ${time}` });
    } catch (error) {
      sendError(request, response, requestId, error);
    }
  });

  router.delete('/:variableId', async (request, response) => {
    const requestId = getRequestId(request);
    try {
      if (!await requireWriter(request, response, requestId)) return;
      const deleted = await store.remove(String(request.params.variableId || ''));
      response.json({ ok: true, requestId, deleted, summaryText: deleted ? '已移出词典' : '词典里没有这个变量' });
    } catch (error) {
      sendError(request, response, requestId, error);
    }
  });

  return router;
}
