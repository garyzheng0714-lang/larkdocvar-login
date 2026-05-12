import express from 'express';
import axios from 'axios';
import OSS from 'ali-oss';
import dns from 'node:dns/promises';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LookupFunction } from 'node:net';
import JSZip from 'jszip';
import { z } from 'zod';
import { documentRenderJsonParser } from './documentRenderBodyParser';
import { DOCX_CONTENT_TYPE, buildContentDisposition, ensureDocxExtension, sanitizeFileName } from './documentRenderFile';
import { UserFacingError } from './documentRenderStorageErrors';
import { TosDocumentRenderStorage, type TosStorageConfig, normalizeTosEndpoint } from './documentRenderTosStorage';
import { createFixedLookup, isBlockedIpAddress } from './documentRenderUrlSafety';
import { imageVariableMapSchema, isImagePlaceholderName, replaceImagePlaceholdersInDocx, type DocumentRenderImageVariableInput, type RenderedImageVariable } from './documentRenderImages';
import type { DocumentTemplateResolver } from './documentTemplateApi';

const MAX_TEMPLATE_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_ZIP_ENTRIES = 1000;
const MAX_TEMPLATE_REDIRECTS = 3;
const DEFAULT_DOWNLOAD_TTL_MS = 60 * 60 * 1000;
const MAX_DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_GENERATED_FILES = 100;
const LOCAL_STORAGE_DIR = process.env.DOCUMENT_RENDER_STORAGE_DIR || path.join(os.tmpdir(), 'larkdocvar-document-renders');
const generatedFiles = new Map<string, {
  filePath: string;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: string;
  expiresAt: string;
}>();

export type DocumentRenderStorageKind = 'local' | 'oss' | 'tos';

export type SaveGeneratedDocxInput = {
  buffer: Buffer;
  fileName: string;
  requestId: string;
  ttlMs: number;
  ttlSeconds: number;
};

export type SavedGeneratedDocx = {
  url: string;
  path: string;
  fileName: string;
  contentType: string;
  size: number;
  storage: DocumentRenderStorageKind;
  createdAt: string;
  expiresAt: string;
};

export interface DocumentRenderStorage {
  saveDocx(input: SaveGeneratedDocxInput): Promise<SavedGeneratedDocx>;
}

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
  output: z.object({
    fileName: z.string().trim().max(255).optional(),
    expiresInSeconds: z.number().int().positive().max(7 * 24 * 60 * 60).optional(),
  }).optional(),
});

export type DocumentRenderRequest = z.infer<typeof documentRenderSchema>;
type VerifiedTemplateUrl = { url: URL; lookup?: LookupFunction };

class MissingVariablesError extends UserFacingError {
  constructor(readonly missingVariables: string[]) { super('还有变量没有填写，请补齐后再生成。'); }
}
class UnusedVariablesError extends UserFacingError {
  constructor(readonly unusedVariables: string[]) { super('有变量没有出现在模板中，请检查变量名。'); }
}
function throwIfMissingVariables(missingVariables: string[]): void {
  if (missingVariables.length > 0) throw new MissingVariablesError(missingVariables);
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
const getMaxGeneratedFiles = () => readPositiveIntegerEnv('DOCUMENT_RENDER_MAX_FILES', DEFAULT_MAX_GENERATED_FILES);

function buildDownloadUrl(downloadPath: string): string {
  const publicBaseUrl = (process.env.DOCUMENT_RENDER_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  return publicBaseUrl ? `${publicBaseUrl}${downloadPath}` : downloadPath;
}

function readFirstEnv(names: string[]): string {
  for (const name of names) {
    const value = (process.env[name] || '').trim();
    if (value) {
      return value;
    }
  }
  return '';
}

function normalizeOssRegion(region: string): string {
  return region.startsWith('oss-') ? region : `oss-${region}`;
}

function normalizeOssPrefix(prefix: string): string {
  const cleaned = prefix.split(/[\\/]+/).map((item) => item.trim()).filter((item) => item && item !== '.' && item !== '..').join('/');
  return cleaned ? `${cleaned}/` : '';
}

function sanitizeRequestId(input: string): string {
  const cleaned = input
    .trim()
    .slice(0, 256)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 128);
  return cleaned || randomUUID();
}

type OssConfig = {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  prefix: string;
};

type AliOssClient = Pick<OSS, 'put' | 'signatureUrl'>;
type ObjectStorageProvider = 'oss' | 'tos' | '';

class LocalDocumentRenderStorage implements DocumentRenderStorage {
  constructor(private readonly storageDir: string) {}

  async saveDocx(input: SaveGeneratedDocxInput): Promise<SavedGeneratedDocx> {
    await cleanupGeneratedFiles();
    await fs.mkdir(this.storageDir, { recursive: true });
    const id = randomUUID();
    const safeFileName = ensureDocxExtension(sanitizeFileName(input.fileName, '生成文档.docx'));
    const filePath = path.join(this.storageDir, `${id}.docx`);
    await fs.writeFile(filePath, input.buffer);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
    generatedFiles.set(id, {
      filePath,
      fileName: safeFileName,
      contentType: DOCX_CONTENT_TYPE,
      size: input.buffer.length,
      createdAt,
      expiresAt,
    });
    const downloadPath = `/api/v1/document-renders/downloads/${id}`;
    return {
      url: buildDownloadUrl(downloadPath),
      path: downloadPath,
      fileName: safeFileName,
      contentType: DOCX_CONTENT_TYPE,
      size: input.buffer.length,
      storage: 'local',
      createdAt,
      expiresAt,
    };
  }
}

class OssDocumentRenderStorage implements DocumentRenderStorage {
  constructor(
    private readonly client: AliOssClient,
    private readonly prefix: string,
  ) {}

  async saveDocx(input: SaveGeneratedDocxInput): Promise<SavedGeneratedDocx> {
    const safeFileName = ensureDocxExtension(sanitizeFileName(input.fileName, '生成文档.docx'));
    const safeRequestId = sanitizeRequestId(input.requestId);
    const objectName = `${this.prefix}${new Date().toISOString().slice(0, 10)}/${safeRequestId}.docx`;
    const contentDisposition = buildContentDisposition(safeFileName);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();

    try {
      await this.client.put(objectName, input.buffer, {
        mime: DOCX_CONTENT_TYPE,
        headers: {
          'Content-Type': DOCX_CONTENT_TYPE,
          'Content-Disposition': contentDisposition,
          'Cache-Control': 'private, max-age=0, no-cache',
        },
      });
    } catch {
      throw new UserFacingError('生成文件上传 OSS 失败，请检查 OSS 配置和权限。');
    }

    let url: string;
    try {
      url = this.client.signatureUrl(objectName, {
        expires: input.ttlSeconds,
        method: 'GET',
        response: {
          'content-type': DOCX_CONTENT_TYPE,
          'content-disposition': contentDisposition,
        },
      });
    } catch {
      throw new UserFacingError('OSS 下载链接生成失败，请检查 OSS 配置。');
    }

    return {
      url,
      path: objectName,
      fileName: safeFileName,
      contentType: DOCX_CONTENT_TYPE,
      size: input.buffer.length,
      storage: 'oss',
      createdAt,
      expiresAt,
    };
  }
}

class ConfigErrorDocumentRenderStorage implements DocumentRenderStorage {
  constructor(private readonly message: string) {}

  async saveDocx(): Promise<SavedGeneratedDocx> {
    throw new UserFacingError(this.message);
  }
}

function readOssConfig(): OssConfig | null | UserFacingError {
  const accessKeyId = readFirstEnv([
    'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID',
    'ALIYUN_OSS_ACCESS_KEY_ID',
    'OSS_ACCESS_KEY_ID',
  ]);
  const accessKeySecret = readFirstEnv([
    'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET',
    'ALIYUN_OSS_ACCESS_KEY_SECRET',
    'OSS_ACCESS_KEY_SECRET',
  ]);
  const bucket = readFirstEnv([
    'DOCUMENT_RENDER_OSS_BUCKET',
    'ALIYUN_OSS_BUCKET',
    'OSS_BUCKET',
  ]);
  const rawRegion = readFirstEnv([
    'DOCUMENT_RENDER_OSS_REGION',
    'ALIYUN_OSS_REGION',
    'OSS_REGION',
    'OSS_REGION_ID',
  ]);
  const values = [accessKeyId, accessKeySecret, bucket, rawRegion];
  const configuredCount = values.filter(Boolean).length;
  if (configuredCount === 0) {
    return null;
  }
  if (configuredCount !== values.length) {
    return new UserFacingError('OSS 配置不完整，请检查 AccessKey、Bucket 和 Region。');
  }
  return {
    accessKeyId,
    accessKeySecret,
    bucket,
    region: normalizeOssRegion(rawRegion),
    prefix: normalizeOssPrefix(process.env.DOCUMENT_RENDER_OSS_PREFIX || 'document-renders'),
  };
}

function readTosConfig(): TosStorageConfig | null | UserFacingError {
  const accessKeyId = readFirstEnv(['TOS_ACCESS_KEY', 'TOS_ACCESS_KEY_ID']);
  const accessKeySecret = readFirstEnv(['TOS_SECRET_KEY', 'TOS_SECRET_ACCESS_KEY']);
  const bucket = readFirstEnv(['TOS_BUCKET']);
  const region = readFirstEnv(['TOS_REGION']);
  const endpoint = readFirstEnv(['TOS_ENDPOINT']);
  const values = [accessKeyId, accessKeySecret, bucket, region];
  const configuredCount = values.filter(Boolean).length;
  if (configuredCount === 0 && !endpoint) {
    return null;
  }
  if (configuredCount !== values.length) {
    return new UserFacingError('TOS 配置不完整，请检查 AccessKey、Bucket 和 Region。');
  }
  return {
    accessKeyId,
    accessKeySecret,
    bucket,
    region,
    endpoint: normalizeTosEndpoint(region, endpoint),
    prefix: normalizeOssPrefix(process.env.DOCUMENT_RENDER_TOS_PREFIX || process.env.DOCUMENT_RENDER_OSS_PREFIX || 'document-renders'),
  };
}

function getObjectStorageProvider(): ObjectStorageProvider {
  const provider = (process.env.DOCUMENT_RENDER_STORAGE_PROVIDER || process.env.DOCUMENT_RENDER_OBJECT_STORAGE_PROVIDER || '').trim().toLowerCase();
  return provider === 'oss' || provider === 'tos' ? provider : '';
}

export function createConfiguredStorage(storageDir = LOCAL_STORAGE_DIR): DocumentRenderStorage {
  const provider = getObjectStorageProvider();
  const tosConfig = readTosConfig();
  const ossConfig = readOssConfig();
  if (provider === 'tos') {
    if (tosConfig instanceof UserFacingError) {
      return new ConfigErrorDocumentRenderStorage(tosConfig.message);
    }
    if (tosConfig) {
      return new TosDocumentRenderStorage(tosConfig);
    }
    return new ConfigErrorDocumentRenderStorage('TOS 配置不完整，请检查 AccessKey、Bucket 和 Region。');
  }
  if (ossConfig instanceof UserFacingError) {
    return new ConfigErrorDocumentRenderStorage(ossConfig.message);
  }
  if (ossConfig) {
    return new OssDocumentRenderStorage(new OSS({
      accessKeyId: ossConfig.accessKeyId,
      accessKeySecret: ossConfig.accessKeySecret,
      bucket: ossConfig.bucket,
      region: ossConfig.region,
      secure: true,
      timeout: 30000,
    }), ossConfig.prefix);
  }
  if (provider === 'oss') {
    return new ConfigErrorDocumentRenderStorage('生产环境必须配置 OSS，不能使用本地临时下载链接。');
  }
  if (tosConfig instanceof UserFacingError) {
    return new ConfigErrorDocumentRenderStorage(tosConfig.message);
  }
  if (tosConfig) {
    return new TosDocumentRenderStorage(tosConfig);
  }
  if (process.env.NODE_ENV === 'production') {
    return new ConfigErrorDocumentRenderStorage('生产环境必须配置 OSS，不能使用本地临时下载链接。');
  }
  return new LocalDocumentRenderStorage(storageDir);
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

export async function renderDocx(templateBuffer: Buffer, variables: Record<string, string>, imageVariables: Record<string, DocumentRenderImageVariableInput> = {}): Promise<{
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

  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new UserFacingError('Docx 模板缺少正文内容。');

  const foundSet = new Set<string>();
  let renderedDocumentXml = documentXml;
  let hasResidualPlaceholders = false;
  const renderedImages = await replaceImagePlaceholdersInDocx(zip, imageVariables);

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

async function removeGeneratedFile(id: string): Promise<void> {
  const file = generatedFiles.get(id);
  if (!file) return;
  generatedFiles.delete(id);
  await fs.unlink(file.filePath).catch(() => undefined);
}

async function cleanupGeneratedFiles(): Promise<void> {
  const now = Date.now();
  for (const [id, file] of generatedFiles) {
    if (Date.parse(file.expiresAt) <= now) {
      await removeGeneratedFile(id);
    }
  }

  const maxFiles = getMaxGeneratedFiles();
  while (generatedFiles.size >= maxFiles) {
    const oldest = generatedFiles.keys().next().value as string | undefined;
    if (!oldest) break;
    await removeGeneratedFile(oldest);
  }
}

function buildDocResponse(input: DocumentRenderRequest, requestId: string) {
  const content = input.template.content ?? '';
  const variables = normalizeVariables(input.variables);
  const found = extractVariablesFromText(content);
  const missing = found.filter((name) => !Object.prototype.hasOwnProperty.call(variables, name));
  throwIfMissingVariables(missing);
  const unused = getUnusedVariables(found, variables);
  if (unused.length > 0) throw new UnusedVariablesError(unused);
  const previewText = renderText(content, variables);
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

async function buildDocxResponse(input: DocumentRenderRequest, storage: DocumentRenderStorage, requestId: string, templateResolver?: DocumentTemplateResolver) {
  if (!input.template.url && !input.template.templateId) {
    throw new UserFacingError('Docx 模板必须提供 template.url 文档链接。');
  }

  const variables = normalizeVariables(input.variables);
  const imageVariables = input.imageVariables || {};
  const loadedTemplate = input.template.templateId
    ? await templateResolver?.loadTemplate(input.template.templateId, input.template.versionId)
    : undefined;
  if (input.template.templateId && !loadedTemplate) throw new UserFacingError('模板服务未配置。');
  const templateBuffer = loadedTemplate?.buffer || await downloadTemplateDocx(input.template.url || '');
  const rendered = await renderDocx(templateBuffer, variables, imageVariables);
  throwIfMissingVariables(rendered.missing);
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
    download: saved,
  };
  return rendered.images.found.length > 0 || Object.keys(imageVariables).length > 0
    ? { ...response, images: { ...rendered.images, provided: Object.keys(imageVariables), unused: unusedImageVariables.map((name) => name.replace(/^image:/, '')) } }
    : response;
}

export async function renderDocumentRequest(input: DocumentRenderRequest, storage: DocumentRenderStorage, requestId: string, templateResolver?: DocumentTemplateResolver) {
  return input.template.format === 'doc'
    ? buildDocResponse(input, requestId)
    : buildDocxResponse(input, storage, requestId, templateResolver);
}

function getRequestId(request: express.Request): string {
  const headerValue = request.headers['x-request-id'];
  const requestId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof requestId === 'string' && requestId.trim() ? sanitizeRequestId(requestId) : randomUUID();
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
    const file = generatedFiles.get(id);
    if (!file || Date.parse(file.expiresAt) <= Date.now() || !existsSync(file.filePath)) {
      await removeGeneratedFile(id);
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
  isBlockedIpAddress,
  normalizeOssPrefix, createFixedLookup, readOssConfig, readTosConfig, OssDocumentRenderStorage, sanitizeRequestId, validateTemplateUrl,
};
