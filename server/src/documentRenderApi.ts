import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeObjectPrefix, sanitizeObjectRequestId } from './objectStorageKeys';
import { buildRenderAuditEntry, recordRenderAudit, readAuditCaller } from './documentRenderAudit';
import { z } from 'zod';
import { documentRenderJsonParser } from './documentRenderBodyParser';
import { UserFacingError } from './documentRenderStorageErrors';
import {
  createConfiguredStorage,
  getGeneratedFileForDownload,
  OssDocumentRenderStorage,
  readOssConfig,
  readTosConfig,
  type DocumentRenderStorage,
} from './documentRenderStorage';
import { createFixedLookup, isBlockedIpAddress } from './documentRenderUrlSafety';
import { downloadTemplateDocx, validateTemplateUrl } from './documentTemplateDownload';
import { extractVariablesFromText, normalizePlaceholderRuns, renderText, textHasResidualPlaceholder } from './documentRenderDocxText';
import { normalizeImageVariables, readPositiveIntegerEnv, renderDocx, renderDocxWithEasyTemplate } from './documentRenderDocx';
import { imageVariableMapSchema, isImagePlaceholderName } from './documentRenderImages';
import type { DocumentTemplateResolver } from './documentTemplateApi';
import { createRequestScopedDocumentTemplateResolver } from './documentTemplateAccess';
import { convertDocxToPdfPreview } from './documentPdfPreview';
import { applyVariableAliases, type DocumentVariableEntry } from './documentVariableDictionary';
export { createConfiguredStorage } from './documentRenderStorage';
export { downloadTemplateDocx } from './documentTemplateDownload';
export { renderDocx } from './documentRenderDocx';
export type { DocumentRenderStorageKind, DocumentRenderStorage, SaveGeneratedDocxInput, SavedGeneratedDocx } from './documentRenderStorage';

const DEFAULT_DOWNLOAD_TTL_MS = 60 * 60 * 1000;
const MAX_DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type DocumentRenderRouterOptions = {
  storage?: DocumentRenderStorage;
  storageDir?: string;
  templateResolver?: DocumentTemplateResolver;
  variableDictionary?: { list(): Promise<DocumentVariableEntry[]> };
};
// 单次生成的附加上下文：目前只有变量别名（请求里 aliasStrategy=dictionary 时由路由读词典填进来）。
type RenderContext = { variableAliases?: DocumentVariableEntry[] };

const documentRenderSchema = z.object({
  template: z.object({
    format: z.enum(['doc', 'docx']),
    title: z.string().trim().max(255).optional(),
    content: z.string().optional(),
    url: z.string().trim().optional(),
    templateId: z.string().trim().optional(),
    versionId: z.string().trim().optional(),
    fileName: z.string().trim().max(255).optional(),
  }),
  variables: z.custom<Record<string, string | number | boolean | null>>((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value as Record<string, unknown>)
      .every((item) => ['string', 'number', 'boolean'].includes(typeof item) || item === null);
  }).default({}),
  imageVariables: imageVariableMapSchema,
  missingStrategy: z.enum(['fail', 'blank']).optional(),
  unusedStrategy: z.enum(['error', 'ignore']).optional(),
  // 可选，不传就是老行为。dictionary：按变量词典让同义变量互相顶替（传了「身份证号」，模板写「证件号」也能填上）。
  aliasStrategy: z.enum(['none', 'dictionary']).optional(),
  // 可选，不传就是老行为。body：出错也回 HTTP 200，靠 ok=false 和 errorCode 判断，方便多维表格自动化把原因写回表格。
  errorMode: z.enum(['status', 'body']).optional(),
  output: z.object({
    fileName: z.string().trim().max(255).optional(),
    expiresInSeconds: z.number().int().positive().max(7 * 24 * 60 * 60).optional(),
    includeFileBase64: z.boolean().optional(),
    includePdfPreview: z.boolean().optional(),
  }).optional(),
});

export type DocumentRenderRequest = z.infer<typeof documentRenderSchema>;

class MissingVariablesError extends UserFacingError {
  constructor(readonly missingVariables: string[]) {
    super(`还有变量没有填写：${missingVariables.join('、')}。请补齐后再生成。`);
  }
}
class UnusedVariablesError extends UserFacingError {
  constructor(readonly unusedVariables: string[]) {
    super(`以下变量在模板正文里没有找到：${unusedVariables.join('、')}。请检查变量名是否与模板中的 {{占位符}} 完全一致。`);
  }
}
function throwIfMissingVariables(missingVariables: string[]): void {
  if (missingVariables.length > 0) throw new MissingVariablesError(missingVariables);
}

function getBlockingMissingVariables(missingVariables: string[], strategy: DocumentRenderRequest['missingStrategy']): string[] {
  if (strategy !== 'blank') return missingVariables;
  return missingVariables.filter((name) => isImagePlaceholderName(name));
}

function withBlankMissingVariables(variables: Record<string, string>, missingVariables: string[]): Record<string, string> {
  if (missingVariables.length === 0) return variables;
  const output = { ...variables };
  for (const name of missingVariables) {
    if (!isImagePlaceholderName(name) && !Object.prototype.hasOwnProperty.call(output, name)) {
      output[name] = '';
    }
  }
  return output;
}

// derived：别名顶上的变量 → 顶它的那个调用方变量。调用方变量只要自己或它顶上的别名在模板里出现，就不算多余。
function getUnusedVariables(found: string[], provided: Record<string, string>, derived: Record<string, string> = {}): string[] {
  const foundSet = new Set(found);
  const usedSources = new Set(found.filter((name) => Object.prototype.hasOwnProperty.call(derived, name)).map((name) => derived[name]));
  return Object.keys(provided).filter((name) => !foundSet.has(name) && !usedSources.has(name));
}

function resolveRenderVariables(input: DocumentRenderRequest, context: RenderContext) {
  const provided = normalizeVariables(input.variables);
  if (!context.variableAliases) return { provided, variables: provided, derived: {} as Record<string, string>, aliasing: false };
  return { provided, ...applyVariableAliases(provided, context.variableAliases), aliasing: true };
}

function aliasedFields(aliasing: boolean, found: string[], derived: Record<string, string>): { aliased?: Record<string, string> } {
  if (!aliasing) return {};
  const aliased: Record<string, string> = {};
  for (const name of found) {
    if (Object.prototype.hasOwnProperty.call(derived, name)) aliased[name] = derived[name];
  }
  return { aliased };
}

function normalizeVariables(input: DocumentRenderRequest['variables']): Record<string, string> {
  const output = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(input)) {
    const name = key.trim();
    if (!name) continue;
    output[name] = value === null ? '' : String(value);
  }
  return output;
}


function getDefaultDownloadTtl(): { ttlMs: number; ttlSeconds: number } {
  const ttlSeconds = readPositiveIntegerEnv('DOCUMENT_RENDER_DOWNLOAD_TTL_SECONDS', 0);
  if (ttlSeconds > 0) return { ttlMs: Math.min(ttlSeconds * 1000, MAX_DOWNLOAD_TTL_MS), ttlSeconds: Math.min(ttlSeconds, MAX_DOWNLOAD_TTL_MS / 1000) };
  const ttlMs = Math.min(readPositiveIntegerEnv('DOCUMENT_RENDER_DOWNLOAD_TTL_MS', DEFAULT_DOWNLOAD_TTL_MS), MAX_DOWNLOAD_TTL_MS);
  return { ttlMs, ttlSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
}

function buildDocResponse(input: DocumentRenderRequest, requestId: string, context: RenderContext = {}) {
  const content = input.template.content ?? '';
  const { provided, variables, derived, aliasing } = resolveRenderVariables(input, context);
  const found = extractVariablesFromText(content);
  const missing = found.filter((name) => !Object.prototype.hasOwnProperty.call(variables, name));
  throwIfMissingVariables(getBlockingMissingVariables(missing, input.missingStrategy));
  const unused = getUnusedVariables(found, provided, derived);
  if (unused.length > 0 && input.unusedStrategy !== 'ignore') throw new UnusedVariablesError(unused);
  const renderVariables = input.missingStrategy === 'blank' ? withBlankMissingVariables(variables, missing) : variables;
  const previewText = renderText(content, renderVariables);
  if (textHasResidualPlaceholder(previewText)) throw new UserFacingError('模板中仍有未替换的变量占位符，请检查模板。');

  return {
    ok: true,
    requestId,
    format: 'doc',
    document: {
      title: input.template.title || '未命名文档',
      previewText,
    },
    variables: {
      found,
      missing,
      provided: Object.keys(provided),
      unused,
      ...aliasedFields(aliasing, found, derived),
    },
  };
}

async function buildDocxResponse(
  input: DocumentRenderRequest,
  storage: DocumentRenderStorage,
  requestId: string,
  templateResolver?: DocumentTemplateResolver,
  preloadedTemplate?: { buffer: Buffer; fileName?: string; templateName?: string },
  context: RenderContext = {},
) {
  if (!input.template.url && !input.template.templateId) {
    throw new UserFacingError('Docx 模板必须提供 template.url 文档链接。');
  }

  const { provided, variables, derived, aliasing } = resolveRenderVariables(input, context);
  const imageVariables = normalizeImageVariables(input.imageVariables);

  let templateBuffer: Buffer;
  let loadedTemplate: { buffer: Buffer; version: { fileName: string }; record: { name: string } } | undefined;

  if (preloadedTemplate) {
    // 批量渲染时复用预加载的模板
    templateBuffer = preloadedTemplate.buffer;
    loadedTemplate = preloadedTemplate.fileName || preloadedTemplate.templateName
      ? { buffer: preloadedTemplate.buffer, version: { fileName: preloadedTemplate.fileName || '' }, record: { name: preloadedTemplate.templateName || '' } }
      : undefined;
  } else {
    loadedTemplate = input.template.templateId
      ? await templateResolver?.loadTemplate(input.template.templateId, input.template.versionId)
      : undefined;
    if (input.template.templateId && !loadedTemplate) throw new UserFacingError('模板服务未配置。');
    templateBuffer = loadedTemplate?.buffer || await downloadTemplateDocx(input.template.url || '');
  }
  const rendered = await renderDocx(templateBuffer, variables, imageVariables);
  throwIfMissingVariables(getBlockingMissingVariables(rendered.missing, input.missingStrategy));
  const unusedImageVariables = Object.keys(imageVariables).filter((name) => !rendered.images.found.includes(name)).map((name) => `image:${name}`);
  const unused = [...getUnusedVariables(rendered.found, provided, derived), ...unusedImageVariables];
  if (unused.length > 0 && input.unusedStrategy !== 'ignore') throw new UnusedVariablesError(unused);
  if (rendered.hasResidualPlaceholders) throw new UserFacingError('模板中仍有未替换的变量占位符，请检查模板。');
  const outputFileName = input.output?.fileName
    || input.template.fileName
    || loadedTemplate?.version.fileName
    || input.template.title
    || '生成文档.docx';
  const ttl = input.output?.expiresInSeconds
    ? { ttlMs: input.output.expiresInSeconds * 1000, ttlSeconds: input.output.expiresInSeconds }
    : getDefaultDownloadTtl();
  const saved = await storage.saveDocx({
    buffer: rendered.buffer,
    fileName: outputFileName,
    requestId,
    ttlMs: ttl.ttlMs,
    ttlSeconds: ttl.ttlSeconds,
  });

  const response = {
    ok: true,
    requestId,
    format: 'docx',
    document: {
      title: input.template.title || loadedTemplate?.record.name || path.basename(saved.fileName, '.docx') || '生成文档',
      previewText: rendered.previewText,
    },
    variables: {
      found: rendered.found,
      missing: rendered.missing,
      provided: [...Object.keys(provided), ...Object.keys(imageVariables).map((name) => `image:${name}`)],
      unused,
      ...aliasedFields(aliasing, rendered.found, derived),
    },
    download: input.output?.includeFileBase64
      ? { ...saved, fileBase64: rendered.buffer.toString('base64') }
      : saved,
    ...(input.output?.includePdfPreview
      ? { preview: { pdf: await convertDocxToPdfPreview({ buffer: rendered.buffer, fileName: outputFileName }) } }
      : {}),
  };
  return rendered.images.found.length > 0 || Object.keys(imageVariables).length > 0
    ? { ...response, images: { ...rendered.images, provided: Object.keys(imageVariables), unused: unusedImageVariables.map((name) => name.replace(/^image:/, '')) } }
    : response;
}

export async function renderDocumentRequest(
  input: DocumentRenderRequest,
  storage: DocumentRenderStorage,
  requestId: string,
  templateResolver?: DocumentTemplateResolver,
  preloadedTemplate?: { buffer: Buffer; fileName?: string; templateName?: string },
  context: RenderContext = {},
) {
  return input.template.format === 'doc'
    ? buildDocResponse(input, requestId, context)
    : buildDocxResponse(input, storage, requestId, templateResolver, preloadedTemplate, context);
}

function getRequestId(request: express.Request): string {
  const headerValue = request.headers['x-request-id'];
  const requestId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof requestId === 'string' && requestId.trim() ? sanitizeObjectRequestId(requestId) : randomUUID();
}

type RenderErrorCode = 'INVALID_REQUEST' | 'MISSING_VARIABLES' | 'UNUSED_VARIABLES' | 'RENDER_REJECTED' | 'INTERNAL_ERROR';

function wantsBodyErrors(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && (body as { errorMode?: unknown }).errorMode === 'body');
}

// 默认（不传 errorMode）照旧回 400/500；errorMode=body 时一律回 200，多带 errorCode，服务端故障再带 retryable。
function sendRenderError(
  response: express.Response,
  bodyMode: boolean,
  status: number,
  errorCode: RenderErrorCode,
  payload: Record<string, unknown>,
): void {
  if (!bodyMode) {
    response.status(status).json(payload);
    return;
  }
  response.status(200).json({ ...payload, errorCode, ...(status >= 500 ? { retryable: true } : {}) });
}

async function loadRenderContext(input: DocumentRenderRequest, options: DocumentRenderRouterOptions): Promise<RenderContext> {
  if (input.aliasStrategy !== 'dictionary') return {};
  if (!options.variableDictionary) throw new UserFacingError('变量词典未配置，不能使用 aliasStrategy=dictionary。');
  return { variableAliases: await options.variableDictionary.list() };
}

export function createDocumentRenderRouter(options: DocumentRenderRouterOptions = {}): express.Router {
  const storage = options.storage || createConfiguredStorage(options.storageDir);
  const templateResolver = options.templateResolver;
  const router = express.Router();
  router.use(documentRenderJsonParser);

  router.post('/', async (request, response) => {
    const requestId = getRequestId(request);
    const caller = readAuditCaller(request.headers);
    const bodyMode = wantsBodyErrors(request.body);
    const parsed = documentRenderSchema.safeParse(request.body);
    if (!parsed.success) {
      sendRenderError(response, bodyMode, 400, 'INVALID_REQUEST', { ok: false, requestId, error: '请求参数不合法。' });
      void recordRenderAudit(buildRenderAuditEntry({ requestId, source: 'single', status: 'failed', error: '请求参数不合法。', caller }));
      return;
    }

    try {
      const result = await renderDocumentRequest(
        parsed.data,
        storage,
        requestId,
        createRequestScopedDocumentTemplateResolver(request, templateResolver),
        undefined,
        await loadRenderContext(parsed.data, options),
      );
      response.json(result);
      void recordRenderAudit(buildRenderAuditEntry({
        requestId,
        source: 'single',
        status: 'success',
        templateId: parsed.data.template.templateId ?? null,
        versionId: parsed.data.template.versionId ?? null,
        result,
        caller,
      }));
    } catch (error) {
      void recordRenderAudit(buildRenderAuditEntry({
        requestId,
        source: 'single',
        status: 'failed',
        templateId: parsed.data.template.templateId ?? null,
        versionId: parsed.data.template.versionId ?? null,
        error,
        caller,
      }));
      if (error instanceof MissingVariablesError) {
        sendRenderError(response, bodyMode, 400, 'MISSING_VARIABLES', { ok: false, requestId, error: error.message, missingVariables: error.missingVariables });
        return;
      }

      if (error instanceof UnusedVariablesError) {
        sendRenderError(response, bodyMode, 400, 'UNUSED_VARIABLES', { ok: false, requestId, error: error.message, unusedVariables: error.unusedVariables });
        return;
      }

      if (error instanceof UserFacingError) {
        sendRenderError(response, bodyMode, 400, 'RENDER_REJECTED', { ok: false, requestId, error: error.message });
        return;
      }

      // eslint-disable-next-line no-console
      console.error(`[document-render:${requestId}]`, error instanceof Error ? error.message : String(error));
      sendRenderError(response, bodyMode, 500, 'INTERNAL_ERROR', { ok: false, requestId, error: 'Docx 文档生成失败，请稍后重试。' });
    }
  });

  router.get('/downloads/:id', async (request, response) => {
    const requestId = getRequestId(request);
    const id = String(request.params.id || '').trim();
    const file = await getGeneratedFileForDownload(id);
    if (!file) {
      response.status(404).json({ ok: false, requestId, error: '下载链接不存在或已失效。' });
      return;
    }

    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Length', String(file.size));
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.sendFile(file.filePath);
  });

  return router;
}

export const __test__ = {
  extractVariablesFromText,
  renderText,
  renderDocx,
  renderDocxWithEasyTemplate,
  normalizePlaceholderRuns,
  isBlockedIpAddress,
  normalizeOssPrefix: normalizeObjectPrefix, createFixedLookup, readOssConfig, readTosConfig, OssDocumentRenderStorage, sanitizeRequestId: sanitizeObjectRequestId, validateTemplateUrl,
};
