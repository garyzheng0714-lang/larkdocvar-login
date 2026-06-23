import OSS from 'ali-oss';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DOCX_CONTENT_TYPE, buildContentDisposition, ensureDocxExtension, sanitizeFileName } from './documentRenderFile';
import { normalizeObjectPrefix, sanitizeObjectRequestId } from './objectStorageKeys';
import { UserFacingError } from './documentRenderStorageErrors';
import { TosDocumentRenderStorage, buildTosPrefix, type TosStorageConfig, normalizeTosEndpoint } from './documentRenderTosStorage';

const DEFAULT_MAX_GENERATED_FILES = 100;
const LOCAL_STORAGE_DIR = process.env.DOCUMENT_RENDER_STORAGE_DIR || path.join(os.tmpdir(), 'larkdocvar-document-renders');

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

export type GeneratedDocxFile = {
  filePath: string;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: string;
  expiresAt: string;
};

const generatedFiles = new Map<string, GeneratedDocxFile>();

type OssConfig = {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  prefix: string;
};

type AliOssClient = Pick<OSS, 'put' | 'signatureUrl'>;
type ObjectStorageProvider = 'oss' | 'tos' | '';

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || '');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getMaxGeneratedFiles(): number {
  return readPositiveIntegerEnv('DOCUMENT_RENDER_MAX_FILES', DEFAULT_MAX_GENERATED_FILES);
}

function buildDownloadUrl(downloadPath: string): string {
  const publicBaseUrl = (process.env.DOCUMENT_RENDER_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  return publicBaseUrl ? `${publicBaseUrl}${downloadPath}` : downloadPath;
}

function readFirstEnv(names: string[]): string {
  for (const name of names) {
    const value = (process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function normalizeOssRegion(region: string): string {
  return region.startsWith('oss-') ? region : `oss-${region}`;
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

export async function getGeneratedFileForDownload(id: string): Promise<GeneratedDocxFile | undefined> {
  const file = generatedFiles.get(id);
  if (!file || Date.parse(file.expiresAt) <= Date.now() || !existsSync(file.filePath)) {
    await removeGeneratedFile(id);
    return undefined;
  }
  return file;
}

export class LocalDocumentRenderStorage implements DocumentRenderStorage {
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

export class OssDocumentRenderStorage implements DocumentRenderStorage {
  constructor(
    private readonly client: AliOssClient,
    private readonly prefix: string,
  ) {}

  async saveDocx(input: SaveGeneratedDocxInput): Promise<SavedGeneratedDocx> {
    const safeFileName = ensureDocxExtension(sanitizeFileName(input.fileName, '生成文档.docx'));
    const safeRequestId = sanitizeObjectRequestId(input.requestId);
    const objectName = `${this.prefix}${new Date().toISOString().slice(0, 10)}/${safeRequestId}/${safeFileName}`;
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

export function readOssConfig(): OssConfig | null | UserFacingError {
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
  if (configuredCount === 0) return null;
  if (configuredCount !== values.length) {
    return new UserFacingError('OSS 配置不完整，请检查 AccessKey、Bucket 和 Region。');
  }
  return {
    accessKeyId,
    accessKeySecret,
    bucket,
    region: normalizeOssRegion(rawRegion),
    prefix: normalizeObjectPrefix(process.env.DOCUMENT_RENDER_OSS_PREFIX || 'document-renders'),
  };
}

export function readTosConfig(): TosStorageConfig | null | UserFacingError {
  const accessKeyId = readFirstEnv(['TOS_ACCESS_KEY', 'TOS_ACCESS_KEY_ID']);
  const accessKeySecret = readFirstEnv(['TOS_SECRET_KEY', 'TOS_SECRET_ACCESS_KEY']);
  const bucket = readFirstEnv(['TOS_BUCKET']);
  const region = readFirstEnv(['TOS_REGION']);
  const endpoint = readFirstEnv(['TOS_ENDPOINT']);
  const values = [accessKeyId, accessKeySecret, bucket, region];
  const configuredCount = values.filter(Boolean).length;
  if (configuredCount === 0 && !endpoint) return null;
  if (configuredCount !== values.length) {
    return new UserFacingError('TOS 配置不完整，请检查 AccessKey、Bucket 和 Region。');
  }
  return {
    accessKeyId,
    accessKeySecret,
    bucket,
    region,
    endpoint: normalizeTosEndpoint(region, endpoint),
    prefix: buildTosPrefix(
      process.env.DOCUMENT_TOS_ROOT_PREFIX || '',
      process.env.DOCUMENT_RENDER_TOS_PREFIX || process.env.DOCUMENT_RENDER_OSS_PREFIX || 'document-renders',
    ),
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
    if (tosConfig instanceof UserFacingError) return new ConfigErrorDocumentRenderStorage(tosConfig.message);
    if (tosConfig) return new TosDocumentRenderStorage(tosConfig);
    return new ConfigErrorDocumentRenderStorage('TOS 配置不完整，请检查 AccessKey、Bucket 和 Region。');
  }
  if (ossConfig instanceof UserFacingError) return new ConfigErrorDocumentRenderStorage(ossConfig.message);
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
  if (tosConfig instanceof UserFacingError) return new ConfigErrorDocumentRenderStorage(tosConfig.message);
  if (tosConfig) return new TosDocumentRenderStorage(tosConfig);
  if (process.env.NODE_ENV === 'production') {
    return new ConfigErrorDocumentRenderStorage('生产环境必须配置 OSS，不能使用本地临时下载链接。');
  }
  return new LocalDocumentRenderStorage(storageDir);
}
