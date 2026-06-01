import express from 'express';
import axios from 'axios';
import FormData from 'form-data';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LookupFunction } from 'node:net';
import { normalizeObjectPrefix, sanitizeObjectRequestId } from './objectStorageKeys';
import JSZip from 'jszip';
import { TemplateHandler } from 'easy-template-x';
import { z } from 'zod';
import { documentRenderJsonParser } from './documentRenderBodyParser';
import { DOCX_CONTENT_TYPE, ensureDocxExtension, sanitizeFileName } from './documentRenderFile';
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
import { imageVariableMapSchema, isImagePlaceholderName, normalizeImageVariableName, replaceImagePlaceholdersInDocx, type DocumentRenderImageVariableInput, type RenderedImageVariable } from './documentRenderImages';
import type { DocumentTemplateResolver } from './documentTemplateApi';
export { createConfiguredStorage } from './documentRenderStorage';
export type { DocumentRenderStorageKind, DocumentRenderStorage, SaveGeneratedDocxInput, SavedGeneratedDocx } from './documentRenderStorage';

const MAX_TEMPLATE_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_ZIP_ENTRIES = 1000;
const MAX_TEMPLATE_REDIRECTS = 3;
const DEFAULT_DOWNLOAD_TTL_MS = 60 * 60 * 1000;
const MAX_DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_GOTENBERG_TIMEOUT_MS = 30_000;

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
  output: z.object({
    fileName: z.string().trim().max(255).optional(),
    expiresInSeconds: z.number().int().positive().max(7 * 24 * 60 * 60).optional(),
    includeFileBase64: z.boolean().optional(),
    includePdfPreview: z.boolean().optional(),
  }).optional(),
});

export type DocumentRenderRequest = z.infer<typeof documentRenderSchema>;
type VerifiedTemplateUrl = { url: URL; lookup?: LookupFunction };

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

function extractVariablesFromText(input: string): string[] {
  const variables: string[] = [];
  const seen = new Set<string>();
  const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(input)) !== null) {
    const name = match[1]?.trim() || '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    variables.push(name);
  }
  return variables;
}

function renderText(input: string, variables: Record<string, string>): string {
  return input.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawName: string) => {
    const name = rawName.trim();
    return Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : match;
  });
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(input: string): string {
  return input
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
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
const getGotenbergTimeoutMs = () => readPositiveIntegerEnv('GOTENBERG_TIMEOUT_MS', DEFAULT_GOTENBERG_TIMEOUT_MS);

async function convertDocxToPdfPreview(input: { buffer: Buffer; fileName: string }): Promise<{ contentType: 'application/pdf'; size: number; fileBase64: string }> {
  const baseUrl = (process.env.GOTENBERG_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new UserFacingError('PDF 预览服务未配置，请联系管理员。');
  }
  const form = new FormData();
  form.append('files', input.buffer, {
    filename: ensureDocxExtension(sanitizeFileName(input.fileName, '预览.docx')),
    contentType: DOCX_CONTENT_TYPE,
  });
  let response;
  try {
    response = await axios.post(`${baseUrl}/forms/libreoffice/convert`, form, {
      headers: form.getHeaders(),
      responseType: 'arraybuffer',
      timeout: getGotenbergTimeoutMs(),
      maxBodyLength: MAX_TEMPLATE_DOWNLOAD_BYTES,
      maxContentLength: MAX_TEMPLATE_DOWNLOAD_BYTES,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  } catch {
    throw new UserFacingError('PDF 预览生成失败，请稍后重试。');
  }
  const pdf = Buffer.from(response.data);
  return {
    contentType: 'application/pdf',
    size: pdf.length,
    fileBase64: pdf.toString('base64'),
  };
}

function allowPrivateTemplateUrls(): boolean { return process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS === 'true'; }

async function validateTemplateUrl(rawUrl: string): Promise<VerifiedTemplateUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UserFacingError('模板链接格式不正确。');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UserFacingError('模板链接只支持 HTTP 或 HTTPS。');
  }
  if (url.username || url.password) {
    throw new UserFacingError('模板链接不能包含用户名或密码。');
  }
  if (url.protocol !== 'https:' && !allowPrivateTemplateUrls()) {
    throw new UserFacingError('Docx 模板链接默认只允许 HTTPS。');
  }
  if (!allowPrivateTemplateUrls()) {
    let addresses;
    try {
      addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    } catch {
      throw new UserFacingError('Docx 模板链接无法访问，请检查链接是否正确。');
    }
    if (addresses.length === 0 || addresses.some((item) => isBlockedIpAddress(item.address))) {
      throw new UserFacingError('模板链接不能指向内网或本机地址。');
    }
    return {
      url,
      lookup: createFixedLookup(url.hostname, addresses),
    };
  }
  return { url };
}

export async function downloadTemplateDocx(rawUrl: string, redirectCount = 0): Promise<Buffer> {
  const target = await validateTemplateUrl(rawUrl);
  let response;
  try {
    response = await axios.get<ArrayBuffer>(target.url.toString(), {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: MAX_TEMPLATE_DOWNLOAD_BYTES,
      maxBodyLength: MAX_TEMPLATE_DOWNLOAD_BYTES,
      maxRedirects: 0,
      proxy: false,
      httpAgent: target.lookup ? new http.Agent({ lookup: target.lookup }) : undefined,
      httpsAgent: target.lookup ? new https.Agent({ lookup: target.lookup }) : undefined,
      validateStatus: (status) => (status >= 200 && status < 300) || (status >= 300 && status < 400),
    });
  } catch (error) {
    if (axios.isAxiosError(error) && String(error.message || '').includes('maxContentLength')) throw new UserFacingError('Docx 模板不能超过 20MB。');
    throw new UserFacingError('Docx 模板链接无法访问，请检查链接是否正确。');
  }

  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= MAX_TEMPLATE_REDIRECTS) {
      throw new UserFacingError('模板链接重定向次数过多。');
    }
    const location = response.headers.location;
    if (!location) {
      throw new UserFacingError('模板链接重定向缺少目标地址。');
    }
    return downloadTemplateDocx(new URL(String(location), target.url).toString(), redirectCount + 1);
  }

  return Buffer.from(response.data);
}

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

function extractPreviewTextFromDocumentXml(xml: string): string {
  const paragraphs = xml.match(/<w:p[\s\S]*?<\/w:p>/g) || [];
  if (paragraphs.length > 0) {
    return paragraphs
      .map((paragraph) => collectTextNodeSegments(paragraph).combinedText)
      .join('\n')
      .trim();
  }

  return collectTextNodeSegments(xml).combinedText.trim();
}

type TextNodeSegment = {
  contentStart: number;
  contentEnd: number;
  textStart: number;
  textEnd: number;
  text: string;
};

function collectTextNodeSegments(xml: string): { segments: TextNodeSegment[]; combinedText: string } {
  const segments: TextNodeSegment[] = [];
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let match: RegExpExecArray | null = null;
  let textCursor = 0;

  while ((match = pattern.exec(xml)) !== null) {
    const fullMatch = match[0];
    const rawText = match[1] || '';
    const openingEndOffset = fullMatch.indexOf('>') + 1;
    const contentStart = match.index + openingEndOffset;
    const contentEnd = contentStart + rawText.length;
    const text = unescapeXml(rawText);
    segments.push({
      contentStart,
      contentEnd,
      textStart: textCursor,
      textEnd: textCursor + text.length,
      text,
    });
    textCursor += text.length;
  }

  return {
    segments,
    combinedText: segments.map((segment) => segment.text).join(''),
  };
}

function replacePlaceholdersInTextNodes(xml: string, variables: Record<string, string>): {
  xml: string;
  found: string[];
} {
  let matchedParagraph = false;
  const foundSet = new Set<string>();
  const outputXml = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraphXml) => {
    matchedParagraph = true;
    const rendered = replacePlaceholdersInTextNodeScope(paragraphXml, variables);
    for (const name of rendered.found) foundSet.add(name);
    return rendered.xml;
  });
  if (matchedParagraph) {
    return { xml: outputXml, found: Array.from(foundSet) };
  }
  return replacePlaceholdersInTextNodeScope(xml, variables);
}

function replacePlaceholdersInTextNodeScope(xml: string, variables: Record<string, string>): {
  xml: string;
  found: string[];
} {
  const { segments, combinedText } = collectTextNodeSegments(xml);
  if (segments.length === 0) {
    return { xml, found: [] };
  }

  const found = extractVariablesFromText(combinedText).filter((name) => !isImagePlaceholderName(name));
  const operations: Array<{ start: number; end: number; replacement: string }> = [];
  const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(combinedText)) !== null) {
    const name = match[1]?.trim() || '';
    if (!Object.prototype.hasOwnProperty.call(variables, name)) {
      continue;
    }
    operations.push({
      start: match.index,
      end: match.index + match[0].length,
      replacement: variables[name],
    });
  }

  if (operations.length === 0) {
    return { xml, found };
  }

  const segmentOutputs = segments.map((segment) => {
    let output = '';
    let cursor = segment.textStart;

    for (const operation of operations) {
      if (operation.end <= segment.textStart || operation.start >= segment.textEnd) {
        continue;
      }

      const copyEnd = Math.min(operation.start, segment.textEnd);
      if (cursor < copyEnd) {
        output += combinedText.slice(cursor, copyEnd);
      }

      if (operation.start >= segment.textStart && operation.start < segment.textEnd) {
        output += operation.replacement;
      }

      cursor = Math.max(cursor, Math.min(operation.end, segment.textEnd));
    }

    if (cursor < segment.textEnd) {
      output += combinedText.slice(cursor, segment.textEnd);
    }

    return output;
  });

  let outputXml = '';
  let xmlCursor = 0;
  segments.forEach((segment, index) => {
    const replacement = segmentOutputs[index], prefix = xml.slice(xmlCursor, segment.contentStart);
    outputXml += /^\s|\s$/.test(replacement) && !prefix.includes('xml:space=') ? prefix.replace(/<w:t\b/, '<w:t xml:space="preserve"') : prefix;
    outputXml += escapeXml(replacement);
    xmlCursor = segment.contentEnd;
  });
  outputXml += xml.slice(xmlCursor);

  return { xml: outputXml, found };
}

// 把每个段落里构成 {{...}} 的相邻 run 的 rPr，统一为「变量名主体重叠字符最多的那个 run」的样式。
// easy-template-x 替换时取占位符起始 run 的样式，归一化后起始 run 已携带变量名样式，
// 从而彻底修复「Word 把占位符拆进不同样式 run 导致替换值样式丢失」的根因。
function normalizePlaceholderRuns(xml: string): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraphXml) => normalizeParagraphRuns(paragraphXml));
}

function normalizeParagraphRuns(paragraphXml: string): string {
  const runPattern = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
  const runs: Array<{ runXml: string; rPr: string; text: string; matchStart: number; matchEnd: number; charStart: number; charEnd: number }> = [];
  let runMatch: RegExpExecArray | null = null;
  let charCursor = 0;
  while ((runMatch = runPattern.exec(paragraphXml)) !== null) {
    const runXml = runMatch[0];
    const rPrMatch = runXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
    const rPr = rPrMatch ? rPrMatch[0] : '';
    const text = Array.from(runXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)).map((part) => unescapeXml(part[1] || '')).join('');
    runs.push({ runXml, rPr, text, matchStart: runMatch.index, matchEnd: runMatch.index + runXml.length, charStart: charCursor, charEnd: charCursor + text.length });
    charCursor += text.length;
  }
  if (runs.length === 0) return paragraphXml;
  const combinedText = runs.map((run) => run.text).join('');

  const placeholderPattern = /\{\{\s*[^{}]+?\s*\}\}/g;
  const repByRunIndex = new Map<number, string>();
  let placeholder: RegExpExecArray | null = null;
  while ((placeholder = placeholderPattern.exec(combinedText)) !== null) {
    const phStart = placeholder.index;
    const phEnd = placeholder.index + placeholder[0].length;
    const bodyStart = phStart + 2;
    const bodyEnd = phEnd - 2;
    const covered: number[] = [];
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].charStart < phEnd && runs[i].charEnd > phStart) covered.push(i);
    }
    if (covered.length === 0) continue;
    // 代表样式 = 与变量名主体 [bodyStart,bodyEnd) 重叠字符最多的那个 run 的 rPr
    let bestIndex = covered[0];
    let bestOverlap = -1;
    for (const i of covered) {
      const overlap = Math.min(runs[i].charEnd, bodyEnd) - Math.max(runs[i].charStart, bodyStart);
      if (overlap > bestOverlap) { bestOverlap = overlap; bestIndex = i; }
    }
    const representativeRPr = runs[bestIndex].rPr;
    for (const i of covered) repByRunIndex.set(i, representativeRPr);
  }
  if (repByRunIndex.size === 0) return paragraphXml;

  let output = paragraphXml;
  const indices = Array.from(repByRunIndex.keys()).sort((a, b) => b - a); // 从后往前改写，避免位置偏移
  for (const i of indices) {
    const run = runs[i];
    const representativeRPr = repByRunIndex.get(i) || '';
    let newRunXml: string;
    if (run.rPr) {
      newRunXml = run.runXml.replace(run.rPr, representativeRPr); // 代表样式为空时即删除原 rPr
    } else if (representativeRPr) {
      newRunXml = run.runXml.replace(/(<w:r\b[^>]*>)/, `$1${representativeRPr}`);
    } else {
      newRunXml = run.runXml;
    }
    output = output.slice(0, run.matchStart) + newRunXml + output.slice(run.matchEnd);
  }
  return output;
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

  // 收集模板里出现的文本变量名（用于 found/missing），并对各 word/*.xml 做 run 归一化
  const foundSet = new Set<string>();
  const xmlFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/') && name.endsWith('.xml'));
  for (const name of xmlFiles) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    for (const variableName of extractVariablesFromText(collectTextNodeSegments(xml).combinedText).filter((candidate) => !isImagePlaceholderName(candidate))) {
      foundSet.add(variableName);
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

  // easy-template-x 只处理正文/页眉/页脚等主体部件；对它未覆盖、仍残留占位符的部件
  // （如 footnotes.xml 脚注、endnotes.xml 尾注），用已归一化的 run 做兜底文本替换，
  // 保证脚注等位置的变量也被替换且样式保真，避免静默漏替换产出半成品。
  const finalZip = await JSZip.loadAsync(processedBuffer);
  let hasResidualPlaceholders = false;
  for (const name of Object.keys(finalZip.files).filter((n) => n.startsWith('word/') && n.endsWith('.xml'))) {
    const file = finalZip.file(name);
    if (!file) continue;
    let xml = await file.async('string');
    if (xml.includes('{{')) {
      xml = replacePlaceholdersInTextNodes(xml, variables).xml;
      finalZip.file(name, xml);
    }
    if (xml.includes('{{') || xml.includes('}}')) hasResidualPlaceholders = true;
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
    for (const name of rendered.found) {
      foundSet.add(name);
    }
    hasResidualPlaceholders ||= rendered.xml.includes('{{') || rendered.xml.includes('}}');
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
  if (unused.length > 0) throw new UnusedVariablesError(unused);
  const renderVariables = input.missingStrategy === 'blank' ? withBlankMissingVariables(variables, missing) : variables;
  const previewText = renderText(content, renderVariables);
  if (previewText.includes('{{') || previewText.includes('}}')) throw new UserFacingError('模板中仍有未替换的变量占位符，请检查模板。');

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
  if (unused.length > 0) throw new UnusedVariablesError(unused);
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
    const parsed = documentRenderSchema.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ ok: false, requestId, error: '请求参数不合法。' }); return; }

    try {
      response.json(await renderDocumentRequest(parsed.data, storage, requestId, templateResolver));
    } catch (error) {
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
