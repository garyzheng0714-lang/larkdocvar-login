import axios, { AxiosError, AxiosInstance, Method } from 'axios';
import FormData from 'form-data';
import type { LookupAddress } from 'node:dns';
import dns from 'node:dns/promises';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import sharp from 'sharp';

const FEISHU_OPEN_API = 'https://open.feishu.cn/open-apis';
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_FEISHU_CODES = new Set([99991400, 1061045, 1063006, 1254290, 1254291]);
const MAX_IMAGE_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DOWNLOAD_REDIRECTS = 3;
const MAX_IMAGE_INPUT_PIXELS = 36_000_000;
const ALLOWED_UPLOAD_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const ALLOWED_DECODED_IMAGE_FORMATS = new Set([
  'png',
  'jpeg',
  'webp',
  'gif',
]);
const DEFAULT_IMAGE_DOWNLOAD_ALLOWED_HOSTS = [
  'feishu.cn',
  'feishuapp.cn',
  'feishucdn.com',
  'larksuite.com',
  'larksuitecdn.com',
  'larkoffice.com',
  'bytecdn.cn',
  'bytegoofy.com',
  'byteimg.com',
  'byteoversea.com',
  'bytescm.com',
  'bytedance.net',
  'pstatp.com',
];
const IMAGE_DOWNLOAD_ALLOWED_HOSTS = (
  process.env.FEISHU_IMAGE_DOWNLOAD_ALLOWED_HOSTS || DEFAULT_IMAGE_DOWNLOAD_ALLOWED_HOSTS.join(',')
)
  .split(',')
  .map((host) => host.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, ''))
  .filter(Boolean);
const UPDATABLE_TEXT_KEYS = new Set([
  'page',
  'text',
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading5',
  'heading6',
  'heading7',
  'heading8',
  'heading9',
  'bullet',
  'ordered',
  'code',
  'quote',
  'todo'
]);

type PermissionMode = 'tenant_readable' | 'tenant_editable' | 'closed';
type OwnerMemberType = 'userid' | 'openid' | 'email';

interface FeishuEnvelope<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

interface ExtractTemplateResult {
  documentId: string;
  templateTitle: string;
  variables: string[];
}

interface GenerateRecordInput {
  recordId: string;
  variables: Record<string, string>;
  imageVariables?: Record<string, { urls: string[]; width: number }>;
  title?: string;
}

interface OwnerTransferInput {
  memberType: OwnerMemberType;
  memberId: string;
  needNotification?: boolean;
  removeOldOwner?: boolean;
  stayPut?: boolean;
  oldOwnerPerm?: 'view' | 'edit' | 'full_access';
}

interface CollaboratorInput {
  memberType: 'openid' | 'email' | 'userid';
  memberId: string;
  perm: 'view' | 'edit' | 'full_access';
}

interface GenerateInput {
  templateUrl: string;
  records: GenerateRecordInput[];
  permissionMode: PermissionMode;
  ownerTransfer?: OwnerTransferInput;
  collaborators?: CollaboratorInput[];
}

interface GenerateResult {
  recordId: string;
  status: 'success' | 'failed';
  docUrl?: string;
  documentId?: string;
  documentTitle?: string;
  replacedBlocks?: number;
  warnings?: string[];
  error?: string;
}

interface SearchUserResult {
  openId: string;
  userId?: string;
  name: string;
  enName?: string;
  nickname?: string;
  email?: string;
  avatar72?: string;
  departmentIds?: string[];
  departments?: string[];
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

interface RootFolderPayload {
  token: string;
}

interface DocumentInfoPayload {
  document?: {
    title?: string;
  };
}

interface RawContentPayload {
  content: string;
}

interface CopyFilePayload {
  file?: {
    token?: string;
    url?: string;
  };
}

interface DocumentBlocksPage {
  items?: Array<Record<string, unknown>>;
  has_more?: boolean;
  page_token?: string;
}

interface DepartmentChildrenPage {
  items?: Array<{
    open_department_id?: string;
    department_id?: string;
    name?: string;
    i18n_name?: {
      zh_cn?: string;
      en_us?: string;
      ja_jp?: string;
    };
  }>;
  has_more?: boolean;
  page_token?: string;
}

interface ContactUsersPage {
  items?: Array<{
    open_id?: string;
    user_id?: string;
    name?: string;
    en_name?: string;
    nickname?: string;
    email?: string;
    department_ids?: string[];
    avatar?: {
      avatar_72?: string;
    };
  }>;
  has_more?: boolean;
  page_token?: string;
}

interface SearchUsersPage {
  users?: Array<{
    open_id?: string;
    user_id?: string;
    name?: string;
    department_ids?: string[];
    avatar?: {
      avatar_72?: string;
    };
  }>;
  has_more?: boolean;
  page_token?: string;
}

interface VerifiedImageDownloadTarget {
  url: URL;
  lookup: LookupFunction;
}

interface FeishuClientOptions {
  appId: string;
  appSecret: string;
}

class FeishuApiError extends Error {
  code?: number;
  status?: number;
  logId?: string;

  constructor(message: string, options?: { code?: number; status?: number; logId?: string }) {
    super(message);
    this.name = 'FeishuApiError';
    this.code = options?.code;
    this.status = options?.status;
    this.logId = options?.logId;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeKeyword(value: string): string {
  return value.trim().toLowerCase();
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof FeishuApiError) {
    if (error.status && RETRYABLE_HTTP_STATUS.has(error.status)) {
      return true;
    }
    return error.code !== undefined && RETRYABLE_FEISHU_CODES.has(error.code);
  }
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (status && RETRYABLE_HTTP_STATUS.has(status)) {
      return true;
    }
  }
  return false;
}

function sanitizeTitle(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\[\]]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 180) || '文档副本';
}

function ipv4ToNumber(address: string): number {
  return address
    .split('.')
    .reduce((acc, item) => (acc << 8) + Number(item), 0) >>> 0;
}

function isIpv4InRange(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}

function isBlockedIpAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, bits]) => isIpv4InRange(address, String(base), Number(bits)));
  }

  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice('::ffff:'.length);
      if (net.isIP(mapped) === 4) {
        return isBlockedIpAddress(mapped);
      }
      const parts = mapped.split(':');
      if (parts.length === 2 && parts.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) {
        const first = Number.parseInt(parts[0], 16);
        const second = Number.parseInt(parts[1], 16);
        if (Number.isFinite(first) && Number.isFinite(second)) {
          return isBlockedIpAddress(
            [
              (first >> 8) & 0xff,
              first & 0xff,
              (second >> 8) & 0xff,
              second & 0xff,
            ].join('.'),
          );
        }
      }
    }
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab][0-9a-f]?:/i.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    );
  }

  return true;
}

function isAllowedImageHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return IMAGE_DOWNLOAD_ALLOWED_HOSTS.some(
    (allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`),
  );
}

function buildPinnedLookup(expectedHostname: string, addresses: LookupAddress[]): LookupFunction {
  const normalizedHost = expectedHostname.toLowerCase().replace(/\.$/, '');
  return ((hostname: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb !== 'function') {
      throw new Error('lookup callback is required');
    }

    if (hostname.toLowerCase().replace(/\.$/, '') !== normalizedHost) {
      cb(new Error('图片下载域名与校验域名不一致。'));
      return;
    }

    const opts = typeof options === 'object' && options !== null ? options as { family?: number; all?: boolean } : {};
    const requestedFamily = typeof options === 'number' ? options : opts.family || 0;
    const candidates = requestedFamily
      ? addresses.filter((item) => item.family === requestedFamily)
      : addresses;

    if (candidates.length === 0) {
      cb(new Error('图片链接没有可用的已校验解析地址。'));
      return;
    }

    if (opts.all) {
      cb(null, candidates);
      return;
    }

    cb(null, candidates[0].address, candidates[0].family);
  }) as LookupFunction;
}

async function validateImageDownloadUrl(rawUrl: string): Promise<VerifiedImageDownloadTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('图片链接格式不合法。');
  }

  if (url.protocol !== 'https:') {
    throw new Error('图片链接只允许 HTTPS。');
  }
  if (url.username || url.password) {
    throw new Error('图片链接不能包含用户名或密码。');
  }
  if (!isAllowedImageHost(url.hostname)) {
    throw new Error(`图片链接域名不在允许范围内：${url.hostname}`);
  }

  const literalIpFamily = net.isIP(url.hostname);
  if (literalIpFamily) {
    if (isBlockedIpAddress(url.hostname)) {
      throw new Error('图片链接不能指向内网或保留 IP。');
    }
    return {
      url,
      lookup: buildPinnedLookup(url.hostname, [{ address: url.hostname, family: literalIpFamily as 4 | 6 }]),
    };
  }

  const addresses = await dns.lookup(url.hostname, { all: true });
  if (addresses.length === 0) {
    throw new Error('图片链接域名解析失败。');
  }
  for (const item of addresses) {
    if (isBlockedIpAddress(item.address)) {
      throw new Error('图片链接域名解析到内网或保留 IP。');
    }
  }

  return {
    url,
    lookup: buildPinnedLookup(url.hostname, addresses),
  };
}

function normalizeContentType(contentType: unknown): string {
  const raw = Array.isArray(contentType) ? contentType[0] : contentType;
  return String(raw || 'image/png').split(';')[0].trim().toLowerCase();
}

function imageFormatToUploadInfo(format: string | undefined): { contentType: string; extension: string } {
  const normalized = String(format || '').toLowerCase();
  if (!ALLOWED_DECODED_IMAGE_FORMATS.has(normalized)) {
    throw new Error('图片真实格式不支持。');
  }
  if (normalized === 'jpeg') {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  return { contentType: `image/${normalized}`, extension: normalized };
}

async function prepareImageForUpload(
  image: { buffer: Buffer; contentType: string },
  targetWidth: number,
): Promise<{ buffer: Buffer; contentType: string; extension: string }> {
  const width = Number.isFinite(targetWidth) ? Math.max(0, Math.min(2000, Math.floor(targetWidth))) : 0;
  const metadata = await sharp(image.buffer, { limitInputPixels: MAX_IMAGE_INPUT_PIXELS }).metadata();
  const uploadInfo = imageFormatToUploadInfo(metadata.format);
  const original = {
    buffer: image.buffer,
    ...uploadInfo,
  };
  if (width <= 0) {
    return original;
  }

  const resized = await sharp(image.buffer, { limitInputPixels: MAX_IMAGE_INPUT_PIXELS })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .png()
    .toBuffer();
  return { buffer: resized, contentType: 'image/png', extension: 'png' };
}

function replacePlaceholders(input: string, variables: Record<string, string>): string {
  let output = input;
  const entries = Object.entries(variables).filter(([, value]) => value !== undefined);
  for (const [name, value] of entries) {
    const pattern = new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`, 'g');
    output = output.replace(pattern, value ?? '');
  }
  return output;
}

function extractVariablesFromText(rawContent: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const regexp = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null = null;
  while ((match = regexp.exec(rawContent)) !== null) {
    const variable = match[1]?.trim();
    if (!variable || seen.has(variable)) {
      continue;
    }
    seen.add(variable);
    result.push(variable);
  }
  return result;
}

function extractDocumentId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('模板文档链接为空。');
  }
  if (/^[a-zA-Z0-9_]{10,}$/.test(trimmed) && !trimmed.startsWith('http')) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/(?:docx|docs)\/([a-zA-Z0-9_]+)/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    const match = trimmed.match(/\/(?:docx|docs)\/([a-zA-Z0-9_]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  throw new Error('无法从模板链接中解析 document_id，请确认链接格式。');
}

function buildDocumentTitle(templateTitle: string): string {
  return sanitizeTitle(templateTitle || '模板文档');
}

function getTextElements(block: Record<string, unknown>): unknown[] | null {
  for (const key of Object.keys(block)) {
    if (!UPDATABLE_TEXT_KEYS.has(key)) {
      continue;
    }
    const value = block[key] as { elements?: unknown[] } | undefined;
    if (value && Array.isArray(value.elements)) {
      return value.elements;
    }
  }
  return null;
}

function hasOwnVariable(variables: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(variables, name);
}

function replaceKnownPlaceholders(input: string, variables: Record<string, string>): string {
  return input.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawName: string) => {
    const name = rawName.trim();
    return hasOwnVariable(variables, name) ? variables[name] ?? '' : match;
  });
}

function isTextRunElement(element: unknown): element is Record<string, any> & { text_run: { content: string } } {
  const current = element as Record<string, any>;
  return typeof current?.text_run?.content === 'string';
}

function cloneTextRunElement(element: Record<string, any>, content: string): Record<string, any> {
  return {
    ...element,
    text_run: {
      ...element.text_run,
      content,
    },
  };
}

function replaceTextRunGroup(
  group: Array<Record<string, any> & { text_run: { content: string } }>,
  variables: Record<string, string>,
): { changed: boolean; elements: unknown[] } {
  const segments = group.map((element, index) => ({
    element,
    index,
    content: element.text_run.content,
    start: 0,
    end: 0,
  }));

  let cursor = 0;
  for (const segment of segments) {
    segment.start = cursor;
    cursor += segment.content.length;
    segment.end = cursor;
  }

  const combined = segments.map((segment) => segment.content).join('');
  const output: unknown[] = [];
  const appendOriginalRange = (start: number, end: number) => {
    if (end <= start) return;
    for (const segment of segments) {
      const from = Math.max(start, segment.start);
      const to = Math.min(end, segment.end);
      if (to <= from) continue;
      const content = segment.content.slice(from - segment.start, to - segment.start);
      if (content) {
        output.push(cloneTextRunElement(segment.element, content));
      }
    }
  };

  const findSourceElement = (offset: number): Record<string, any> => {
    return segments.find((segment) => offset >= segment.start && offset < segment.end)?.element ?? group[0];
  };

  let changed = false;
  let lastIndex = 0;
  const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(combined)) !== null) {
    const name = match[1]?.trim() || '';
    if (!hasOwnVariable(variables, name)) {
      continue;
    }

    changed = true;
    appendOriginalRange(lastIndex, match.index);
    const replacement = variables[name] ?? '';
    if (replacement) {
      output.push(cloneTextRunElement(findSourceElement(match.index), replacement));
    }
    lastIndex = match.index + match[0].length;
  }

  if (!changed) {
    return { changed: false, elements: group };
  }

  appendOriginalRange(lastIndex, combined.length);
  if (output.length === 0) {
    output.push(cloneTextRunElement(group[0], ''));
  }
  return { changed: true, elements: output };
}

function replaceElements(elements: unknown[], variables: Record<string, string>): { changed: boolean; elements: unknown[] } {
  let changed = false;
  const nextElements: unknown[] = [];
  let textRunGroup: Array<Record<string, any> & { text_run: { content: string } }> = [];

  const flushTextRunGroup = () => {
    if (textRunGroup.length === 0) return;
    const replaced = replaceTextRunGroup(textRunGroup, variables);
    if (replaced.changed) {
      changed = true;
    }
    nextElements.push(...replaced.elements);
    textRunGroup = [];
  };

  for (const element of elements) {
    const current = element as Record<string, any>;
    if (isTextRunElement(current)) {
      textRunGroup.push(current);
      continue;
    }
    if (current?.equation?.content && typeof current.equation.content === 'string') {
      flushTextRunGroup();
      const replaced = replaceKnownPlaceholders(current.equation.content, variables);
      if (replaced !== current.equation.content) {
        changed = true;
        nextElements.push({
          ...current,
          equation: {
            ...current.equation,
            content: replaced
          }
        });
        continue;
      }
    }
    flushTextRunGroup();
    nextElements.push(current);
  }
  flushTextRunGroup();
  return { changed, elements: nextElements };
}

export class FeishuTemplateService {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly client: AxiosInstance;
  private tokenCache: CachedToken | null = null;
  private rootFolderToken: string | null = null;
  private userDirectoryCache: { users: SearchUserResult[]; expiresAt: number } | null = null;
  private searchApiUnavailable = false;

  constructor(options: FeishuClientOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.client = axios.create({
      baseURL: FEISHU_OPEN_API,
      timeout: 30000
    });
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.value;
    }
    const response = await this.client.post<TenantTokenResponse>('/auth/v3/tenant_access_token/internal', {
      app_id: this.appId,
      app_secret: this.appSecret
    });
    const payload = response.data;
    if (!payload?.tenant_access_token || payload.code !== 0) {
      throw new FeishuApiError(`获取 tenant_access_token 失败：${payload?.msg ?? '未知错误'}`, {
        code: payload?.code,
        status: response.status,
        logId: response.headers['x-tt-logid']
      });
    }
    const expiresIn = Math.max(60, payload.expire - 120);
    this.tokenCache = {
      value: payload.tenant_access_token,
      expiresAt: Date.now() + expiresIn * 1000
    };
    return payload.tenant_access_token;
  }

  private async request<T>(
    method: Method,
    path: string,
    options?: {
      params?: Record<string, string | number | boolean>;
      data?: unknown;
      retries?: number;
    }
  ): Promise<T> {
    const retries = options?.retries ?? 2;
    let attempt = 0;
    while (true) {
      try {
        const token = await this.getTenantAccessToken();
        const response = await this.client.request<FeishuEnvelope<T>>({
          method,
          url: path,
          params: options?.params,
          data: options?.data,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8'
          }
        });
        const payload = response.data;
        if (payload.code !== 0) {
          throw new FeishuApiError(`飞书接口返回错误：${payload.msg}`, {
            code: payload.code,
            status: response.status,
            logId: response.headers['x-tt-logid']
          });
        }
        return payload.data;
      } catch (error) {
        const shouldRetry = attempt < retries && isRetryableError(error);
        if (!shouldRetry) {
          if (error instanceof FeishuApiError) {
            throw error;
          }
          if (error instanceof AxiosError) {
            const message = error.response?.data?.msg || error.message;
            throw new FeishuApiError(`飞书接口请求失败：${message}`, {
              status: error.response?.status,
              code: error.response?.data?.code,
              logId: error.response?.headers?.['x-tt-logid']
            });
          }
          throw error;
        }
        attempt += 1;
        await sleep(300 * 2 ** attempt);
      }
    }
  }

  private async getRootFolderToken(): Promise<string> {
    if (this.rootFolderToken) {
      return this.rootFolderToken;
    }
    const data = await this.request<RootFolderPayload>('GET', '/drive/explorer/v2/root_folder/meta');
    if (!data.token) {
      throw new Error('无法读取 root folder token。');
    }
    this.rootFolderToken = data.token;
    return data.token;
  }

  private async getDocumentTitle(documentId: string): Promise<string> {
    const data = await this.request<DocumentInfoPayload>('GET', `/docx/v1/documents/${documentId}`);
    return data.document?.title?.trim() || '模板文档';
  }

  private async getDocumentRawContent(documentId: string): Promise<string> {
    const data = await this.request<RawContentPayload>('GET', `/docx/v1/documents/${documentId}/raw_content`);
    return data.content || '';
  }

  private async copyDocumentFile(documentId: string, newName: string): Promise<{ token: string; url: string }> {
    const folderToken = await this.getRootFolderToken();
    const data = await this.request<CopyFilePayload>('POST', `/drive/v1/files/${documentId}/copy`, {
      data: {
        name: sanitizeTitle(newName),
        type: 'docx',
        folder_token: folderToken
      }
    });
    const token = data.file?.token;
    if (!token) {
      throw new Error('复制模板文档失败，未返回 token。');
    }
    return {
      token,
      url: data.file?.url || `https://feishu.cn/docx/${token}`
    };
  }

  private async listAllBlocks(documentId: string): Promise<Array<Record<string, unknown>>> {
    const all: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;
    while (true) {
      const data = await this.request<DocumentBlocksPage>('GET', `/docx/v1/documents/${documentId}/blocks`, {
        params: {
          page_size: 500,
          page_token: pageToken || ''
        }
      });
      all.push(...(data.items || []));
      if (!data.has_more || !data.page_token) {
        break;
      }
      pageToken = data.page_token;
    }
    return all;
  }

  private async replaceVariablesInDocument(documentId: string, variables: Record<string, string>): Promise<number> {
    if (Object.keys(variables).length === 0) {
      return 0;
    }
    const blocks = await this.listAllBlocks(documentId);
    const requests: Array<{ block_id: string; update_text_elements: { elements: unknown[] } }> = [];

    for (const block of blocks) {
      const blockId = block.block_id as string | undefined;
      if (!blockId) {
        continue;
      }
      const elements = getTextElements(block);
      if (!elements) {
        continue;
      }
      const replaced = replaceElements(elements, variables);
      if (!replaced.changed) {
        continue;
      }
      requests.push({
        block_id: blockId,
        update_text_elements: {
          elements: replaced.elements
        }
      });
    }

    for (const chunk of chunkArray(requests, 20)) {
      await this.request('PATCH', `/docx/v1/documents/${documentId}/blocks/batch_update`, {
        data: {
          requests: chunk
        }
      });
    }
    return requests.length;
  }

  private async downloadImage(url: string, redirectCount = 0): Promise<{ buffer: Buffer; contentType: string }> {
    const target = await validateImageDownloadUrl(url);
    const response = await axios.get(target.url.toString(), {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: MAX_IMAGE_DOWNLOAD_BYTES,
      maxBodyLength: MAX_IMAGE_DOWNLOAD_BYTES,
      maxRedirects: 0,
      proxy: false,
      httpsAgent: new https.Agent({ lookup: target.lookup }),
      validateStatus: (status) => (status >= 200 && status < 300) || (status >= 300 && status < 400),
    });

    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= MAX_IMAGE_DOWNLOAD_REDIRECTS) {
        throw new Error('图片下载重定向次数过多。');
      }
      const location = response.headers.location;
      if (!location) {
        throw new Error('图片下载重定向缺少 Location。');
      }
      const redirectUrl = new URL(String(location), target.url);
      return this.downloadImage(redirectUrl.toString(), redirectCount + 1);
    }

    const contentType = normalizeContentType(response.headers['content-type']);
    if (!ALLOWED_UPLOAD_IMAGE_TYPES.has(contentType)) {
      throw new Error(`图片链接返回的格式不支持：${contentType || 'unknown'}`);
    }

    return {
      buffer: Buffer.from(response.data),
      contentType
    };
  }

  private async uploadImageToDocxBlock(
    documentId: string,
    parentBlockId: string,
    insertIndex: number,
    imageBuffer: Buffer,
    fileName: string,
    contentType: string
  ): Promise<string> {
    const token = await this.getTenantAccessToken();

    const createResponse = await this.request<{ children?: Array<{ block_id?: string }> }>(
      'POST',
      `/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children`,
      { data: { index: insertIndex, children: [{ block_type: 27, image: {} }] } }
    );
    const imageBlockId = createResponse.children?.[0]?.block_id;
    if (!imageBlockId) {
      throw new Error('创建图片块失败，未返回 block_id。');
    }

    const form = new FormData();
    form.append('file_name', fileName);
    form.append('parent_type', 'docx_image');
    form.append('parent_node', imageBlockId);
    form.append('size', String(imageBuffer.length));
    form.append('file', imageBuffer, { filename: fileName, contentType });

    const uploadResponse = await this.client.post<{ code: number; data?: { file_token?: string }; msg?: string }>(
      '/drive/v1/medias/upload_all',
      form,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...form.getHeaders()
        },
        maxContentLength: 25 * 1024 * 1024,
        maxBodyLength: 25 * 1024 * 1024,
        timeout: 60000
      }
    );

    const fileToken = uploadResponse.data?.data?.file_token;
    if (!fileToken || uploadResponse.data?.code !== 0) {
      throw new Error(`上传图片失败：${uploadResponse.data?.msg || '未返回 file_token'}`);
    }

    await this.request('PATCH', `/docx/v1/documents/${documentId}/blocks/${imageBlockId}`, {
      data: { replace_image: { token: fileToken } }
    });

    return imageBlockId;
  }

  private async replaceImageVariablesInDocument(
    documentId: string,
    imageVariables: Record<string, { urls: string[]; width: number }>
  ): Promise<{ insertedCount: number; warnings: string[] }> {
    const variableNames = Object.keys(imageVariables);
    if (variableNames.length === 0) {
      return { insertedCount: 0, warnings: [] };
    }

    let blocks = await this.listAllBlocks(documentId);
    let insertedCount = 0;
    const warnings: string[] = [];

    for (const varName of variableNames) {
      const imageInfo = imageVariables[varName];
      if (!imageInfo.urls.length) continue;

      let matchedAny = false;
      let processedMatches = 0;
      const maxMatchesPerVariable = 20;

      while (processedMatches < maxMatchesPerVariable) {
        const placeholderPattern = new RegExp(`\\{\\{\\s*${escapeRegExp(varName)}\\s*\\}\\}`);
        let matchedBlock: { block: Record<string, unknown>; blockId: string; parentId: string; elements: unknown[] } | null = null;

        for (const block of blocks) {
          const blockId = block.block_id as string | undefined;
          const parentId = block.parent_id as string | undefined;
          if (!blockId || !parentId) continue;

          const elements = getTextElements(block);
          if (!elements) continue;

          const blockText = elements
            .map((el: any) => el?.text_run?.content || '')
            .join('');

          if (placeholderPattern.test(blockText)) {
            matchedBlock = { block, blockId, parentId, elements };
            break;
          }
        }

        if (!matchedBlock) {
          break;
        }

        matchedAny = true;
        processedMatches++;

        const { blockId, parentId, elements } = matchedBlock;
        const parentBlock = blocks.find((b) => (b.block_id as string) === parentId);
        const parentChildren = (parentBlock?.children as string[]) || [];
        const blockIndex = parentChildren.indexOf(blockId);
        const insertAt = blockIndex >= 0 ? blockIndex : -1;
        let insertedForBlock = 0;

        for (let i = 0; i < imageInfo.urls.length; i++) {
          try {
            const image = await this.downloadImage(imageInfo.urls[i]);
            const prepared = await prepareImageForUpload(image, imageInfo.width);
            const fileName = `${sanitizeTitle(varName)}_${i + 1}.${prepared.extension}`;
            await this.uploadImageToDocxBlock(
              documentId,
              parentId,
              insertAt >= 0 ? insertAt + 1 + i : -1,
              prepared.buffer,
              fileName,
              prepared.contentType
            );
            insertedCount++;
            insertedForBlock++;
          } catch (error) {
            logInternalError(`image-insert variable=${varName} index=${i + 1}`, error);
            warnings.push(`变量「${varName}」第 ${i + 1} 张图片插入失败，请检查图片是否可访问或格式是否支持。`);
          }
        }

        if (insertedForBlock === 0) {
          warnings.push(`变量「${varName}」没有成功插入图片，已保留原占位符。`);
          break;
        }

        if (blockIndex >= 0) {
          try {
            await this.request('DELETE', `/docx/v1/documents/${documentId}/blocks/${parentId}/children/batch_delete`, {
              data: { start_index: blockIndex, end_index: blockIndex + 1 }
            });
          } catch (deleteError) {
            logInternalError(`image-placeholder-delete variable=${varName}`, deleteError);
            warnings.push(`变量「${varName}」图片已插入，但原占位块未能自动删除。`);
            const replaced = replaceElements(elements, { [varName]: '' });
            if (replaced.changed) {
              try {
                await this.request('PATCH', `/docx/v1/documents/${documentId}/blocks/batch_update`, {
                  data: { requests: [{ block_id: blockId, update_text_elements: { elements: replaced.elements } }] }
                });
              } catch (patchError) {
                logInternalError(`image-placeholder-patch variable=${varName}`, patchError);
                warnings.push(`变量「${varName}」原占位符清理失败。`);
              }
            }
          }
        } else {
          const replaced = replaceElements(elements, { [varName]: '' });
          if (replaced.changed) {
            try {
              await this.request('PATCH', `/docx/v1/documents/${documentId}/blocks/batch_update`, {
                data: { requests: [{ block_id: blockId, update_text_elements: { elements: replaced.elements } }] }
              });
            } catch (patchError) {
              logInternalError(`image-placeholder-patch variable=${varName}`, patchError);
              warnings.push(`变量「${varName}」原占位符清理失败。`);
            }
          }
        }

        blocks = await this.listAllBlocks(documentId);
      }

      if (!matchedAny) {
        warnings.push(`变量「${varName}」未找到图片占位符，已跳过图片插入。`);
      } else if (processedMatches >= maxMatchesPerVariable) {
        warnings.push(`变量「${varName}」图片占位符数量过多，已停止继续处理。`);
      }
    }

    return { insertedCount, warnings };
  }

  private async updateDocumentPermission(documentId: string, permissionMode: PermissionMode): Promise<void> {
    let externalAccessEntity: 'open' | 'closed' = 'closed';
    let linkShareEntity: 'tenant_readable' | 'tenant_editable' | 'closed' = 'closed';

    switch (permissionMode) {
      case 'tenant_readable':
        externalAccessEntity = 'closed';
        linkShareEntity = 'tenant_readable';
        break;
      case 'tenant_editable':
        externalAccessEntity = 'closed';
        linkShareEntity = 'tenant_editable';
        break;
      case 'closed':
      default:
        externalAccessEntity = 'closed';
        linkShareEntity = 'closed';
        break;
    }

    await this.request('PATCH', `/drive/v2/permissions/${documentId}/public`, {
      params: {
        type: 'docx'
      },
      data: {
        external_access_entity: externalAccessEntity,
        link_share_entity: linkShareEntity,
        security_entity: 'anyone_can_view',
        comment_entity: 'anyone_can_view',
        share_entity: 'anyone',
        manage_collaborator_entity: 'collaborator_can_view',
        copy_entity: 'anyone_can_view'
      }
    });
  }

  private async transferDocumentOwner(documentId: string, ownerTransfer: OwnerTransferInput): Promise<void> {
    await this.request('POST', `/drive/v1/permissions/${documentId}/members/transfer_owner`, {
      params: {
        type: 'docx',
        need_notification: ownerTransfer.needNotification ?? true,
        remove_old_owner: ownerTransfer.removeOldOwner ?? false,
        stay_put: ownerTransfer.stayPut ?? false,
        old_owner_perm: ownerTransfer.oldOwnerPerm ?? 'full_access'
      },
      data: {
        member_type: ownerTransfer.memberType,
        member_id: ownerTransfer.memberId
      }
    });
  }

  private async addDocumentCollaborators(documentId: string, collaborators: CollaboratorInput[]): Promise<void> {
    if (collaborators.length === 0) return;
    const members = collaborators.map(c => ({
      member_type: c.memberType,
      member_id: c.memberId,
      perm: c.perm
    }));
    // Use single-add for 1 member, batch for multiple
    if (members.length === 1) {
      await this.request('POST', `/drive/v1/permissions/${documentId}/members`, {
        params: { type: 'docx', need_notification: false },
        data: members[0]
      });
    } else {
      await this.request('POST', `/drive/v1/permissions/${documentId}/members/batch_create`, {
        params: { type: 'docx', need_notification: false },
        data: { members }
      });
    }
  }

  private toSearchUser(
    value:
      | {
          open_id?: string;
          user_id?: string;
          name?: string;
          en_name?: string;
          nickname?: string;
          email?: string;
          department_ids?: string[];
          avatar?: { avatar_72?: string };
        }
      | {
          open_id?: string;
          user_id?: string;
          name?: string;
          department_ids?: string[];
          avatar?: { avatar_72?: string };
        },
    departmentNameById?: Map<string, string>,
    fallbackDepartmentId?: string
  ): SearchUserResult | null {
    if (!value.open_id) {
      return null;
    }
    const departmentIds = (value.department_ids || []).filter(Boolean);
    if (departmentIds.length === 0 && fallbackDepartmentId) {
      departmentIds.push(fallbackDepartmentId);
    }
    const departments = departmentIds
      .map((id) => departmentNameById?.get(id) || '')
      .filter((item) => !!item);
    return {
      openId: value.open_id,
      userId: value.user_id,
      name: value.name || value.user_id || value.open_id,
      enName: 'en_name' in value ? value.en_name : undefined,
      nickname: 'nickname' in value ? value.nickname : undefined,
      email: 'email' in value ? value.email : undefined,
      avatar72: value.avatar?.avatar_72,
      departmentIds,
      departments
    };
  }

  private sortAndUniqueUsers(users: SearchUserResult[]): SearchUserResult[] {
    const unique = new Map<string, SearchUserResult>();
    for (const user of users) {
      if (!unique.has(user.openId)) {
        unique.set(user.openId, user);
      }
    }
    return Array.from(unique.values()).sort((a, b) => {
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
  }

  private filterUsers(users: SearchUserResult[], keyword: string, limit: number): SearchUserResult[] {
    const normalizedKeyword = normalizeKeyword(keyword);
    if (!normalizedKeyword) {
      return users.slice(0, limit);
    }
    const filtered = users.filter((user) => {
      const text = [
        user.name,
        user.nickname,
        user.enName,
        user.email,
        user.userId,
        user.openId,
        ...(user.departments || [])
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return text.includes(normalizedKeyword);
    });
    return filtered.slice(0, limit);
  }

  private async listAllDepartments(): Promise<Map<string, string>> {
    const departmentNameById = new Map<string, string>();
    departmentNameById.set('0', '根部门');
    let pageToken: string | undefined;
    while (true) {
      const data = await this.request<DepartmentChildrenPage>('GET', '/contact/v3/departments/0/children', {
        params: {
          department_id_type: 'open_department_id',
          fetch_child: true,
          page_size: 50,
          page_token: pageToken || ''
        }
      });
      for (const item of data.items || []) {
        const id = item.open_department_id || item.department_id;
        if (!id) {
          continue;
        }
        const name = item.name || item.i18n_name?.zh_cn || item.i18n_name?.en_us || item.i18n_name?.ja_jp || '';
        departmentNameById.set(id, name);
      }
      if (!data.has_more || !data.page_token) {
        break;
      }
      pageToken = data.page_token;
    }
    return departmentNameById;
  }

  private async listUsersByDepartment(
    departmentId: string,
    departmentNameById: Map<string, string>
  ): Promise<SearchUserResult[]> {
    const users: SearchUserResult[] = [];
    let pageToken: string | undefined;
    while (true) {
      const data = await this.request<ContactUsersPage>('GET', '/contact/v3/users/find_by_department', {
        params: {
          user_id_type: 'open_id',
          department_id_type: 'open_department_id',
          department_id: departmentId,
          page_size: 50,
          page_token: pageToken || ''
        }
      });
      for (const item of data.items || []) {
        const user = this.toSearchUser(item, departmentNameById, departmentId);
        if (user) {
          users.push(user);
        }
      }
      if (!data.has_more || !data.page_token) {
        break;
      }
      pageToken = data.page_token;
    }
    return users;
  }

  private async buildDirectoryUsers(): Promise<SearchUserResult[]> {
    const departmentNameById = await this.listAllDepartments();
    const departmentIds = Array.from(departmentNameById.keys());
    
    // Batch process in parallel to avoid extremely slow sequential fetching, but limit concurrency to avoid rate limits
    const users: SearchUserResult[] = [];
    const concurrencyLimit = 5;
    
    for (let i = 0; i < departmentIds.length; i += concurrencyLimit) {
      const batch = departmentIds.slice(i, i + concurrencyLimit);
      const batchResults = await Promise.all(
        batch.map(deptId => this.listUsersByDepartment(deptId, departmentNameById).catch(() => [] as SearchUserResult[]))
      );
      for (const deptUsers of batchResults) {
        users.push(...deptUsers);
      }
    }
    
    return this.sortAndUniqueUsers(users);
  }

  private async getDirectoryUsers(): Promise<SearchUserResult[]> {
    if (this.userDirectoryCache && this.userDirectoryCache.expiresAt > Date.now()) {
      return this.userDirectoryCache.users;
    }
    const users = await this.buildDirectoryUsers();
    this.userDirectoryCache = {
      users,
      expiresAt: Date.now() + 15 * 60 * 1000 // Cache for 15 minutes
    };
    return users;
  }

  // Returns all users from the directory cache (building it if needed)
  async getAllUsers(limit = 200): Promise<SearchUserResult[]> {
    const users = await this.getDirectoryUsers();
    return users.slice(0, Math.min(Math.max(limit, 1), 200));
  }

  // Pre-warms the cache asynchronously so the first user query doesn't hang
  public prewarmDirectoryCache() {
    if (!this.userDirectoryCache || this.userDirectoryCache.expiresAt < Date.now()) {
      this.getDirectoryUsers().catch(err => console.error("Failed to prewarm user cache:", toErrorMessage(err)));
    }
  }

  private async trySearchUsersViaSearchApi(keyword: string, limit: number): Promise<SearchUserResult[]> {
    const departmentNameById = await this.listAllDepartments();
    const data = await this.request<SearchUsersPage>('GET', '/search/v1/user', {
      params: {
        query: keyword,
        page_size: Math.min(Math.max(limit, 1), 50)
      }
    });
    const users = (data.users || [])
      .map((item) => this.toSearchUser(item, departmentNameById))
      .filter((item): item is SearchUserResult => item !== null);
    return this.sortAndUniqueUsers(users).slice(0, limit);
  }

  async searchUsers(keyword: string, limit = 20): Promise<SearchUserResult[]> {
    const normalizedKeyword = normalizeKeyword(keyword);
    if (!normalizedKeyword) {
      return [];
    }

    const safeLimit = Math.min(Math.max(limit, 1), 50);

    // 1. Try to fetch from memory cache first if we already have it
    if (this.userDirectoryCache && this.userDirectoryCache.expiresAt > Date.now()) {
      const allUsers = this.userDirectoryCache.users;
      const matched = this.filterUsers(allUsers, normalizedKeyword, safeLimit);
      if (matched.length > 0) {
        return matched;
      }
    }

    // 2. Try the search API directly (if available) since it's much faster than iterating all departments
    if (!this.searchApiUnavailable) {
      try {
        const directUsers = await this.trySearchUsersViaSearchApi(normalizedKeyword, safeLimit);
        if (directUsers.length > 0) {
          // Merge to cache for future lookups
          if (this.userDirectoryCache) {
             const existingOpenIds = new Set(this.userDirectoryCache.users.map(u => u.openId));
             const newUsers = directUsers.filter(u => !existingOpenIds.has(u.openId));
             if (newUsers.length > 0) {
                 this.userDirectoryCache.users = this.sortAndUniqueUsers([...this.userDirectoryCache.users, ...newUsers]);
             }
          }
          return directUsers;
        }
      } catch {
        this.searchApiUnavailable = true;
      }
    }

    // 3. Fallback to full directory sync
    // If we didn't have cache, build it now
    let allUsers = await this.getDirectoryUsers();
    let matched = this.filterUsers(allUsers, normalizedKeyword, safeLimit);
    
    if (matched.length > 0) {
      return matched;
    }

    // 4. Force refresh if nothing found (maybe new user was added)
    this.userDirectoryCache = null;
    allUsers = await this.getDirectoryUsers();
    return this.filterUsers(allUsers, normalizedKeyword, safeLimit);
  }

  async extractTemplateVariables(templateUrl: string): Promise<ExtractTemplateResult> {
    const documentId = extractDocumentId(templateUrl);
    const [templateTitle, rawContent] = await Promise.all([
      this.getDocumentTitle(documentId),
      this.getDocumentRawContent(documentId)
    ]);
    const variables = extractVariablesFromText(rawContent);
    return {
      documentId,
      templateTitle,
      variables
    };
  }

  async generateDocuments(input: GenerateInput): Promise<GenerateResult[]> {
    const templateDocumentId = extractDocumentId(input.templateUrl);
    const templateTitle = await this.getDocumentTitle(templateDocumentId);
    const results: GenerateResult[] = [];

    for (const record of input.records) {
      const warnings: string[] = [];
      try {
        const title = record.title?.trim()
          ? sanitizeTitle(record.title.trim())
          : buildDocumentTitle(templateTitle);
        const copied = await this.copyDocumentFile(templateDocumentId, title);
        const replacedBlocks = await this.replaceVariablesInDocument(copied.token, record.variables);

        let insertedImages = 0;
        if (record.imageVariables && Object.keys(record.imageVariables).length > 0) {
          try {
            const imageResult = await this.replaceImageVariablesInDocument(copied.token, record.imageVariables);
            insertedImages = imageResult.insertedCount;
            warnings.push(...imageResult.warnings);
          } catch (error) {
            logInternalError(`image-replace record=${record.recordId}`, error);
            warnings.push('图片插入部分失败，请检查图片是否可访问或格式是否支持。');
          }
        }

        try {
          await this.updateDocumentPermission(copied.token, input.permissionMode);
        } catch (error) {
          logInternalError(`permission-update document=${copied.token}`, error);
          warnings.push('权限设置失败，请稍后重试或联系管理员。');
        }

        if (input.ownerTransfer?.memberId) {
          try {
            await this.transferDocumentOwner(copied.token, input.ownerTransfer);
          } catch (error) {
            logInternalError(`owner-transfer document=${copied.token}`, error);
            warnings.push('所有者转交失败，请稍后重试或联系管理员。');
          }
        }

        if (input.collaborators && input.collaborators.length > 0) {
          try {
            await this.addDocumentCollaborators(copied.token, input.collaborators);
          } catch (error) {
            logInternalError(`collaborator-permission document=${copied.token}`, error);
            warnings.push('协作者权限设置失败，请稍后重试或联系管理员。');
          }
        }

        results.push({
          recordId: record.recordId,
          status: 'success',
          docUrl: copied.url,
          documentId: copied.token,
          documentTitle: title,
          replacedBlocks,
          warnings
        });
      } catch (error) {
        logInternalError(`generate-record record=${record.recordId}`, error);
        results.push({
          recordId: record.recordId,
          status: 'failed',
          error: '生成失败，请稍后重试。',
          warnings
        });
      }
    }

    return results;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof FeishuApiError) {
    const logMessage = error.logId ? `（log_id: ${error.logId}）` : '';
    const codeMessage = error.code !== undefined ? `[code=${error.code}] ` : '';
    return `${codeMessage}${error.message}${logMessage}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function logInternalError(context: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[${context}]`, toErrorMessage(error));
}

export type { CollaboratorInput, GenerateInput, GenerateResult, OwnerMemberType, OwnerTransferInput, PermissionMode, SearchUserResult };

export const __test__ = {
  isBlockedIpAddress,
  isAllowedImageHost,
  replaceElements,
};
