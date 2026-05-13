import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DOCX_CONTENT_TYPE, buildContentDisposition, ensureDocxExtension, sanitizeFileName } from './documentRenderFile';
import { UserFacingError } from './documentRenderStorageErrors';
import type { DocumentRenderStorage, SaveGeneratedDocxInput, SavedGeneratedDocx } from './documentRenderApi';

export type TosStorageConfig = {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  endpoint: string;
  prefix: string;
};

type TosErrorSummary = {
  status?: number;
  code?: string;
  message?: string;
  requestId?: string | null;
};

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function hmacHex(key: Buffer | string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

function formatTosDate(date = new Date()): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function encodeTosPath(pathname: string): string {
  return pathname
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/[!*'()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

function getTosHost(config: TosStorageConfig): string {
  return `${config.bucket}.${config.endpoint}`;
}

export function normalizeTosEndpoint(region: string, endpoint = ''): string {
  const rawEndpoint = endpoint.trim() || `tos-${region}.volces.com`;
  return rawEndpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

export function normalizeTosPrefix(prefix: string): string {
  const cleaned = prefix.split(/[\\/]+/).map((item) => item.trim()).filter((item) => item && item !== '.' && item !== '..').join('/');
  return cleaned ? `${cleaned}/` : '';
}

export function buildTosPrefix(rootPrefix: string, prefix: string): string {
  return `${normalizeTosPrefix(rootPrefix)}${normalizeTosPrefix(prefix)}`;
}

export function formatTosDatePath(date = new Date()): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '/');
}

function createSigningKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(Buffer.from(secret, 'utf8'), date), region), 'tos'), 'request');
}

function buildScope(date: string, region: string): string {
  return `${date}/${region}/tos/request`;
}

function buildTosAuthorizationHeaders(config: TosStorageConfig, method: string, key: string, payload: Buffer, now = new Date()): Record<string, string> {
  const host = getTosHost(config);
  const dateTime = formatTosDate(now);
  const date = dateTime.slice(0, 8);
  const payloadHash = sha256Hex(payload);
  const headers: Record<string, string> = {
    host,
    'x-tos-content-sha256': payloadHash,
    'x-tos-date': dateTime,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${headers[name]}\n`).join('');
  const canonicalRequest = [
    method,
    `/${encodeTosPath(key)}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = buildScope(date, config.region);
  const stringToSign = [
    'TOS4-HMAC-SHA256',
    dateTime,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = hmacHex(createSigningKey(config.accessKeySecret, date, config.region), stringToSign);
  return {
    Host: host,
    'x-tos-content-sha256': payloadHash,
    'x-tos-date': dateTime,
    Authorization: `TOS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function createTosPresignedGetUrl(config: TosStorageConfig, key: string, expires: number, now = new Date()): string {
  const host = getTosHost(config);
  const dateTime = formatTosDate(now);
  const date = dateTime.slice(0, 8);
  const scope = buildScope(date, config.region);
  const params = new URLSearchParams();
  params.set('X-Tos-Algorithm', 'TOS4-HMAC-SHA256');
  params.set('X-Tos-Credential', `${config.accessKeyId}/${scope}`);
  params.set('X-Tos-Date', dateTime);
  params.set('X-Tos-Expires', String(expires));
  params.set('X-Tos-SignedHeaders', 'host');
  const canonicalQuery = Array.from(params.entries())
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .sort()
    .join('&');
  const canonicalRequest = [
    'GET',
    `/${encodeTosPath(key)}`,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'TOS4-HMAC-SHA256',
    dateTime,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = hmacHex(createSigningKey(config.accessKeySecret, date, config.region), stringToSign);
  return `https://${host}/${encodeTosPath(key)}?${canonicalQuery}&X-Tos-Signature=${signature}`;
}

function parseTosErrorXml(input: string): Pick<TosErrorSummary, 'code' | 'message'> {
  return {
    code: input.match(/<Code>([^<]+)<\/Code>/)?.[1]?.trim(),
    message: input.match(/<Message>([^<]+)<\/Message>/)?.[1]?.trim(),
  };
}

async function assertTosResponseOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  const parsed = parseTosErrorXml(text);
  const error = new Error(`${action} failed`) as Error & { tos?: TosErrorSummary };
  error.tos = {
    status: response.status,
    requestId: response.headers.get('x-tos-request-id'),
    code: parsed.code,
    message: parsed.message || text.slice(0, 300),
  };
  throw error;
}

export async function putTosObject(config: TosStorageConfig, key: string, body: Buffer, headers: Record<string, string> = {}): Promise<void> {
  const response = await fetch(`https://${getTosHost(config)}/${encodeTosPath(key)}`, {
    method: 'PUT',
    headers: {
      ...buildTosAuthorizationHeaders(config, 'PUT', key, body),
      ...headers,
    },
    body: new Uint8Array(body),
  });
  await assertTosResponseOk(response, 'put');
}

export async function deleteTosObject(config: TosStorageConfig, key: string): Promise<void> {
  const response = await fetch(`https://${getTosHost(config)}/${encodeTosPath(key)}`, {
    method: 'DELETE',
    headers: buildTosAuthorizationHeaders(config, 'DELETE', key, Buffer.alloc(0)),
  });
  await assertTosResponseOk(response, 'delete');
}

function sanitizeTosRequestId(input: string): string {
  const cleaned = input
    .trim()
    .slice(0, 256)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 128);
  return cleaned || randomUUID();
}

export class TosDocumentRenderStorage implements DocumentRenderStorage {
  constructor(private readonly config: TosStorageConfig) {}

  async saveDocx(input: SaveGeneratedDocxInput): Promise<SavedGeneratedDocx> {
    const safeFileName = ensureDocxExtension(sanitizeFileName(input.fileName, '生成文档.docx'));
    const safeRequestId = sanitizeTosRequestId(input.requestId);
    const objectName = `${this.config.prefix}${formatTosDatePath()}/${safeRequestId}.docx`;
    const contentDisposition = buildContentDisposition(safeFileName);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();

    try {
      await putTosObject(this.config, objectName, input.buffer, {
        'Content-Type': DOCX_CONTENT_TYPE,
        'Content-Disposition': contentDisposition,
        'Cache-Control': 'private, max-age=0, no-cache',
      });
    } catch {
      throw new UserFacingError('生成文件上传 TOS 失败，请检查 TOS 配置和权限。');
    }

    return {
      url: createTosPresignedGetUrl(this.config, objectName, input.ttlSeconds),
      path: objectName,
      fileName: safeFileName,
      contentType: DOCX_CONTENT_TYPE,
      size: input.buffer.length,
      storage: 'tos',
      createdAt,
      expiresAt,
    };
  }
}

export const __test__ = {
  buildTosPrefix,
  buildTosAuthorizationHeaders,
  createSigningKey,
  encodeTosPath,
  formatTosDatePath,
  formatTosDate,
  getTosHost,
  parseTosErrorXml,
};
