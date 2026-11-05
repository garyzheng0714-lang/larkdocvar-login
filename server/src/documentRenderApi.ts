import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeObjectPrefix, sanitizeObjectRequestId } from './objectStorageKeys';
import JSZip from 'jszip';
import { TemplateHandler } from 'easy-template-x';
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
import { downloadTemplateDocx, MAX_TEMPLATE_DOWNLOAD_BYTES, validateTemplateUrl } from './documentTemplateDownload';
import {
  collectTextNodeSegments,
  extractPreviewTextFromDocumentXml,
  extractVariablesFromText,
  normalizePlaceholderRuns,
  renderText,
  replacePlaceholdersInTextNodes,
  textHasResidualPlaceholder,
  xmlHasResidualPlaceholders,
} from './documentRenderDocxText';
import { imageVariableMapSchema, isImagePlaceholderName, normalizeImageVariableName, replaceImagePlaceholdersInDocx, type DocumentRenderImageVariableInput, type RenderedImageVariable } from './documentRenderImages';
import type { DocumentTemplateResolver } from './documentTemplateApi';
import { createRequestScopedDocumentTemplateResolver } from './documentTemplateAccess';
import { convertDocxToPdfPreview } from './documentPdfPreview';
export { createConfiguredStorage } from './documentRenderStorage';
export { downloadTemplateDocx } from './documentTemplateDownload';
export type { DocumentRenderStorageKind, DocumentRenderStorage, SaveGeneratedDocxInput, SavedGeneratedDocx } from './documentRenderStorage';

const DEFAULT_MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_ZIP_ENTRIES = 1000;
const DEFAULT_DOWNLOAD_TTL_MS = 60 * 60 * 1000;
const MAX_DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type DocumentRenderRouterOptions = { storage?: DocumentRenderStorage; storageDir?: string; templateResolver?: DocumentTemplateResolver };

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

function getUnusedVariables(found: string[], variables: Record<string, string>): string[] {
  const foundSet = new Set(found); return Object.keys(variables).filter((name) => !foundSet.has(name));
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

function normalizeImageVariables(input: DocumentRenderRequest['imageVariables']): Record<string, DocumentRenderImageVariableInput> {
  const output = Object.create(null) as Record<string, DocumentRenderImageVariableInput>;
  for (const [key, value] of Object.entries(input || {})) {
    const name = normalizeImageVariableName(key);
    if (!name) continue;
    output[name] = value;
  }
  return output;
}

// easy-template-x 的 getContentParts 只覆盖 document.xml + 页眉 header* + 页脚 footer* + chart，
// 且缺失变量会被替换成空串——这些部件处理完不会再残留"真占位符"。脚注 footnotes.xml / 尾注 endnotes.xml
// 它完全不处理，仍留着原始 {{x}}，需要事后兜底文本替换。这个集合就是"需要兜底"的部件白名单。
const EASY_TEMPLATE_FALLBACK_PARTS = new Set(['word/footnotes.xml', 'word/endnotes.xml']);
function isEasyTemplateFallbackPart(name: string): boolean {
  return EASY_TEMPLATE_FALLBACK_PARTS.has(name);
}

// 参与变量提取与 found/missing 统计、以及需要做变量替换的"正文类"部件：
// 引擎覆盖的正文/页眉/页脚 + 需兜底的脚注/尾注。批注 comments.xml、设置 settings.xml 等辅助部件排除在外——
// 那里若出现 {{示例}} 不是模板变量，混进来会误报 missing 甚至让整单渲染失败。
function isVariableContentPart(name: string): boolean {
  return name === 'word/document.xml'
    || /^word\/header\d*\.xml$/.test(name)
    || /^word\/footer\d*\.xml$/.test(name)
    || EASY_TEMPLATE_FALLBACK_PARTS.has(name);
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || '');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
function getDefaultDownloadTtl(): { ttlMs: number; ttlSeconds: number } {
  const ttlSeconds = readPositiveIntegerEnv('DOCUMENT_RENDER_DOWNLOAD_TTL_SECONDS', 0);
  if (ttlSeconds > 0) return { ttlMs: Math.min(ttlSeconds * 1000, MAX_DOWNLOAD_TTL_MS), ttlSeconds: Math.min(ttlSeconds, MAX_DOWNLOAD_TTL_MS / 1000) };
  const ttlMs = Math.min(readPositiveIntegerEnv('DOCUMENT_RENDER_DOWNLOAD_TTL_MS', DEFAULT_DOWNLOAD_TTL_MS), MAX_DOWNLOAD_TTL_MS);
  return { ttlMs, ttlSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
}
const getMaxUnzippedBytes = () => readPositiveIntegerEnv('DOCUMENT_RENDER_MAX_UNZIPPED_BYTES', DEFAULT_MAX_UNZIPPED_BYTES);
const getMaxZipEntries = () => readPositiveIntegerEnv('DOCUMENT_RENDER_MAX_ZIP_ENTRIES', DEFAULT_MAX_ZIP_ENTRIES);

function getZipObjectUncompressedSize(file: JSZip.JSZipObject): number {
  const internalData = (file as unknown as { _data?: { uncompressedSize?: number } })._data;
  const size = internalData?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0;
}

function assertSafeDocxZip(zip: JSZip): void {
  const entries = Object.values(zip.files);
  if (entries.length > getMaxZipEntries()) {
    throw new UserFacingError('Docx 模板文件体积异常，已拒绝处理。');
  }

  const maxUnzippedBytes = getMaxUnzippedBytes();
  let totalUnzippedBytes = 0;
  for (const file of entries) {
    if (file.dir) continue;
    totalUnzippedBytes += getZipObjectUncompressedSize(file);
    if (totalUnzippedBytes > maxUnzippedBytes) {
      throw new UserFacingError('Docx 模板文件体积异常，已拒绝处理。');
    }
  }
}

function hasMainDocumentRelationship(xml: string): boolean {
  const relationships = xml.match(/<Relationship\b[^>]*>/g) || [];
  return relationships.some((item) => (
    /Type=["'][^"']*\/officeDocument["']/.test(item)
    && /Target=["']\/?word\/document\.xml["']/.test(item)
  ));
}

function getDocxTextEngine(): 'easy-template-x' | 'legacy' {
  // 默认走 easy-template-x（修复样式不统一/多行/跨 run 等根因）；可用 env 回退 legacy 兜底。
  return process.env.DOCUMENT_RENDER_TEXT_ENGINE === 'legacy' ? 'legacy' : 'easy-template-x';
}

const easyTemplateHandler = new TemplateHandler({ delimiters: { tagStart: '{{', tagEnd: '}}' } });

// 新文本渲染引擎：run 归一化 + easy-template-x（纯字面替换、正确处理跨 run/多行/嵌套表格）。
// 图片占位符仍复用 replaceImagePlaceholdersInDocx；返回契约与 renderDocx 完全一致。
async function renderDocxWithEasyTemplate(
  templateBuffer: Buffer,
  variables: Record<string, string>,
  imageVariables: Record<string, DocumentRenderImageVariableInput> = {},
): Promise<{
  buffer: Buffer;
  previewText: string; found: string[]; missing: string[]; hasResidualPlaceholders: boolean;
  images: { found: string[]; missing: string[]; rendered: RenderedImageVariable[] };
}> {
  if (templateBuffer.length > MAX_TEMPLATE_DOWNLOAD_BYTES) throw new UserFacingError('Docx 模板不能超过 20MB。');
  if (templateBuffer.subarray(0, 2).toString('utf8') !== 'PK') throw new UserFacingError('Docx 模板文件损坏或格式不支持。');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(templateBuffer);
  } catch {
    throw new UserFacingError('Docx 模板文件损坏或格式不支持。');
  }
  assertSafeDocxZip(zip);
  if (!zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) throw new UserFacingError('Docx 模板缺少必要的 Word 文档结构。');
  const contentTypesXml = await zip.file('[Content_Types].xml')?.async('string');
  if (!contentTypesXml?.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) throw new UserFacingError('Docx 模板缺少必要的 Word 文档结构。');
  const rootRelsXml = await zip.file('_rels/.rels')?.async('string');
  if (!rootRelsXml || !hasMainDocumentRelationship(rootRelsXml)) throw new UserFacingError('Docx 模板缺少必要的 Word 文档结构。');

  // 图片占位符（{{image:xxx}} → drawing），复用现有实现
  const renderedImages = await replaceImagePlaceholdersInDocx(zip, normalizeImageVariables(imageVariables));

  // 收集模板里出现的文本变量名（用于 found/missing），并对各 word/*.xml 做 run 归一化。
  // 变量名只从"正文类"部件收集：批注 comments.xml、设置等辅助部件里若写了 {{示例}} 不是模板变量，
  // 混进 found 会被误判为 missing（未提供该变量）导致整单 400 拒绝生成。
  const foundSet = new Set<string>();
  const xmlFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/') && name.endsWith('.xml'));
  for (const name of xmlFiles) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    if (isVariableContentPart(name)) {
      for (const variableName of extractVariablesFromText(collectTextNodeSegments(xml).combinedText).filter((candidate) => !isImagePlaceholderName(candidate))) {
        foundSet.add(variableName);
      }
    }
    zip.file(name, normalizePlaceholderRuns(xml));
  }

  const intermediate = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  let processedBuffer: Buffer;
  try {
    processedBuffer = Buffer.from(await easyTemplateHandler.process(intermediate, variables));
  } catch {
    throw new UserFacingError('文档生成失败：模板内容无法解析，请检查模板占位符是否完整。');
  }

  // easy-template-x 已用 XML 感知方式替换了 document/header/footer（缺失变量替成空串，不留真占位符）。
  // 对它不覆盖、仍留着原始 {{x}} 的脚注/尾注部件，在此做兜底文本替换，保证脚注等位置也被替换。
  //
  // 关键红线：兜底只能作用于脚注/尾注，绝不能对 document/header/footer 再跑一遍文本替换。
  // 此刻用户变量值已写进这些部件的 XML，值里字面的 {{某字段}}（说明文案、示例、粘贴内容里很常见）
  // 会被当成占位符二次替换 → 把另一个变量的值静默注入进来，产出串包的错误文档；也不能据此判残留而 400
  // （值里的示例括号不是残留）。这是"看起来成功、内容却错"的信任杀手，务必只兜底引擎不覆盖的部件。
  const finalZip = await JSZip.loadAsync(processedBuffer);
  let hasResidualPlaceholders = false;
  for (const name of Object.keys(finalZip.files).filter((n) => n.startsWith('word/') && n.endsWith('.xml'))) {
    if (!isEasyTemplateFallbackPart(name)) continue;
    const file = finalZip.file(name);
    if (!file) continue;
    let xml = await file.async('string');
    if (xmlHasResidualPlaceholders(xml)) {
      xml = replacePlaceholdersInTextNodes(xml, variables).xml;
      finalZip.file(name, xml);
    }
    if (xmlHasResidualPlaceholders(xml)) hasResidualPlaceholders = true;
  }
  const finalBuffer = Buffer.from(await finalZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const finalDocumentXml = (await finalZip.file('word/document.xml')?.async('string')) || '';

  const textFound = Array.from(foundSet);
  const found = Array.from(new Set([...textFound, ...renderedImages.found.map((name) => `image:${name}`)]));
  const missing = Array.from(new Set([
    ...textFound.filter((name) => !Object.prototype.hasOwnProperty.call(variables, name)),
    ...renderedImages.missing.map((name) => `image:${name}`),
  ]));

  return {
    buffer: finalBuffer,
    previewText: extractPreviewTextFromDocumentXml(finalDocumentXml),
    found,
    missing,
    hasResidualPlaceholders,
    images: renderedImages,
  };
}

export async function renderDocx(templateBuffer: Buffer, variables: Record<string, string>, imageVariables: Record<string, DocumentRenderImageVariableInput> = {}): Promise<{
  buffer: Buffer;
  previewText: string; found: string[]; missing: string[]; hasResidualPlaceholders: boolean;
  images: { found: string[]; missing: string[]; rendered: RenderedImageVariable[] };
}> {
  if (getDocxTextEngine() === 'easy-template-x') {
    return renderDocxWithEasyTemplate(templateBuffer, variables, imageVariables);
  }
  if (templateBuffer.length > MAX_TEMPLATE_DOWNLOAD_BYTES) throw new UserFacingError('Docx 模板不能超过 20MB。');
  if (templateBuffer.subarray(0, 2).toString('utf8') !== 'PK') throw new UserFacingError('Docx 模板文件损坏或格式不支持。');

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(templateBuffer);
  } catch {
    throw new UserFacingError('Docx 模板文件损坏或格式不支持。');
  }

  assertSafeDocxZip(zip);

  if (!zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) throw new UserFacingError('Docx 模板缺少必要的 Word 文档结构。');
  const contentTypesXml = await zip.file('[Content_Types].xml')?.async('string');
  if (!contentTypesXml?.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) throw new UserFacingError('Docx 模板缺少必要的 Word 文档结构。');
  const rootRelsXml = await zip.file('_rels/.rels')?.async('string');
  if (!rootRelsXml || !hasMainDocumentRelationship(rootRelsXml)) throw new UserFacingError('Docx 模板缺少必要的 Word 文档结构。');

  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new UserFacingError('Docx 模板缺少正文内容。');

  const foundSet = new Set<string>();
  let renderedDocumentXml = documentXml;
  let hasResidualPlaceholders = false;
  const renderedImages = await replaceImagePlaceholdersInDocx(zip, normalizeImageVariables(imageVariables));

  const xmlFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/') && name.endsWith('.xml'));
  for (const name of xmlFiles) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    const rendered = replacePlaceholdersInTextNodes(xml, variables);
    for (const found of rendered.found) {
      foundSet.add(found);
    }
    hasResidualPlaceholders ||= xmlHasResidualPlaceholders(rendered.xml);
    zip.file(name, rendered.xml);
    if (name === 'word/document.xml') {
      renderedDocumentXml = rendered.xml;
    }
  }

  const found = Array.from(new Set([...Array.from(foundSet), ...renderedImages.found.map((name) => `image:${name}`)]));
  const missing = Array.from(new Set([
    ...found.filter((name) => !Object.prototype.hasOwnProperty.call(variables, name) && !name.startsWith('image:')),
    ...renderedImages.missing.map((name) => `image:${name}`),
  ]));
  return {
    buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    previewText: extractPreviewTextFromDocumentXml(renderedDocumentXml),
    found,
    missing,
    hasResidualPlaceholders,
    images: renderedImages,
  };
}

function buildDocResponse(input: DocumentRenderRequest, requestId: string) {
  const content = input.template.content ?? '';
  const variables = normalizeVariables(input.variables);
  const found = extractVariablesFromText(content);
  const missing = found.filter((name) => !Object.prototype.hasOwnProperty.call(variables, name));
  throwIfMissingVariables(getBlockingMissingVariables(missing, input.missingStrategy));
  const unused = getUnusedVariables(found, variables);
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
      provided: Object.keys(variables),
      unused,
    },
  };
}

async function buildDocxResponse(
  input: DocumentRenderRequest,
  storage: DocumentRenderStorage,
  requestId: string,
  templateResolver?: DocumentTemplateResolver,
  preloadedTemplate?: { buffer: Buffer; fileName?: string; templateName?: string },
) {
  if (!input.template.url && !input.template.templateId) {
    throw new UserFacingError('Docx 模板必须提供 template.url 文档链接。');
  }

  const variables = normalizeVariables(input.variables);
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
  const unused = [...getUnusedVariables(rendered.found, variables), ...unusedImageVariables];
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
      provided: [...Object.keys(variables), ...Object.keys(imageVariables).map((name) => `image:${name}`)],
      unused,
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
) {
  return input.template.format === 'doc'
    ? buildDocResponse(input, requestId)
    : buildDocxResponse(input, storage, requestId, templateResolver, preloadedTemplate);
}

function getRequestId(request: express.Request): string {
  const headerValue = request.headers['x-request-id'];
  const requestId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof requestId === 'string' && requestId.trim() ? sanitizeObjectRequestId(requestId) : randomUUID();
}

export function createDocumentRenderRouter(options: DocumentRenderRouterOptions = {}): express.Router {
  const storage = options.storage || createConfiguredStorage(options.storageDir);
  const templateResolver = options.templateResolver;
  const router = express.Router();
  router.use(documentRenderJsonParser);

  router.post('/', async (request, response) => {
    const requestId = getRequestId(request);
    const caller = readAuditCaller(request.headers);
    const parsed = documentRenderSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, requestId, error: '请求参数不合法。' });
      void recordRenderAudit(buildRenderAuditEntry({ requestId, source: 'single', status: 'failed', error: '请求参数不合法。', caller }));
      return;
    }

    try {
      const result = await renderDocumentRequest(
        parsed.data,
        storage,
        requestId,
        createRequestScopedDocumentTemplateResolver(request, templateResolver),
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
        response.status(400).json({ ok: false, requestId, error: error.message, missingVariables: error.missingVariables });
        return;
      }

      if (error instanceof UnusedVariablesError) {
        response.status(400).json({ ok: false, requestId, error: error.message, unusedVariables: error.unusedVariables });
        return;
      }

      if (error instanceof UserFacingError) {
        response.status(400).json({ ok: false, requestId, error: error.message });
        return;
      }

      // eslint-disable-next-line no-console
      console.error(`[document-render:${requestId}]`, error instanceof Error ? error.message : String(error));
      response.status(500).json({ ok: false, requestId, error: 'Docx 文档生成失败，请稍后重试。' });
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
