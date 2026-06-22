import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createTosPresignedGetUrl,
  deleteTosObject,
  buildTosPrefix,
  normalizeTosEndpoint,
  normalizeTosPrefix,
  putTosObject,
  type TosStorageConfig,
} from './documentRenderTosStorage';
import { UserFacingError } from './documentRenderStorageErrors';

const DEFAULT_TEMPLATE_STORAGE_DIR = path.join(os.tmpdir(), 'larkdocvar-document-templates');
const DEFAULT_TEMPLATE_STORAGE_PREFIX = 'document-templates';

export type TemplateObjectStore = {
  objectName(key: string): string;
  putObject(key: string, body: Buffer, contentType: string): Promise<string>;
  putObjectIfAbsent(key: string, body: Buffer, contentType: string): Promise<string>;
  getObject(objectName: string): Promise<Buffer>;
  deleteObject(objectName: string): Promise<void>;
};

export class TemplateObjectNotFoundError extends Error {
  constructor() {
    super('template object not found');
  }
}

export class TemplateObjectAlreadyExistsError extends Error {
  constructor() {
    super('template object already exists');
  }
}

function readFirstEnv(names: string[]): string {
  for (const name of names) {
    const value = (process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function normalizeObjectKey(input: string): string {
  const cleaned = input
    .split(/[\\/]+/)
    .map((item) => item.trim())
    .filter((item) => item && item !== '.' && item !== '..')
    .join('/');
  if (!cleaned) throw new UserFacingError('模板存储路径不合法。');
  return cleaned;
}

function normalizePrefix(input: string): string {
  return normalizeTosPrefix(input || DEFAULT_TEMPLATE_STORAGE_PREFIX);
}

export function readTemplateTosConfig(): TosStorageConfig | null | UserFacingError {
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
      process.env.DOCUMENT_TEMPLATE_TOS_PREFIX || process.env.DOCUMENT_RENDER_TOS_PREFIX || DEFAULT_TEMPLATE_STORAGE_PREFIX,
    ),
  };
}

export class LocalTemplateObjectStore implements TemplateObjectStore {
  constructor(
    private readonly rootDir = process.env.DOCUMENT_TEMPLATE_STORAGE_DIR || DEFAULT_TEMPLATE_STORAGE_DIR,
    private readonly prefix = normalizePrefix(process.env.DOCUMENT_TEMPLATE_LOCAL_PREFIX || DEFAULT_TEMPLATE_STORAGE_PREFIX),
  ) {}

  objectName(key: string): string {
    return `${this.prefix}${normalizeObjectKey(key)}`;
  }

  private filePath(objectName: string): string {
    return path.join(this.rootDir, normalizeObjectKey(objectName));
  }

  async putObject(key: string, body: Buffer): Promise<string> {
    const objectName = this.objectName(key);
    const filePath = this.filePath(objectName);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    return objectName;
  }

  async putObjectIfAbsent(key: string, body: Buffer): Promise<string> {
    const objectName = this.objectName(key);
    const filePath = this.filePath(objectName);
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      await writeFile(filePath, body, { flag: 'wx' });
      return objectName;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TemplateObjectAlreadyExistsError();
      throw error;
    }
  }

  async getObject(objectName: string): Promise<Buffer> {
    try {
      return await readFile(this.filePath(objectName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TemplateObjectNotFoundError();
      throw error;
    }
  }

  async deleteObject(objectName: string): Promise<void> {
    await rm(this.filePath(objectName), { force: true });
  }
}

export class TosTemplateObjectStore implements TemplateObjectStore {
  constructor(private readonly config: TosStorageConfig) {}

  objectName(key: string): string {
    return `${this.config.prefix}${normalizeObjectKey(key)}`;
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<string> {
    const objectName = this.objectName(key);
    await putTosObject(this.config, objectName, body, {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    return objectName;
  }

  async putObjectIfAbsent(key: string, body: Buffer, contentType: string): Promise<string> {
    const objectName = this.objectName(key);
    try {
      await putTosObject(this.config, objectName, body, {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'If-None-Match': '*',
      });
      return objectName;
    } catch (error) {
      const status = (error as { tos?: { status?: number } }).tos?.status;
      if (status === 409 || status === 412) throw new TemplateObjectAlreadyExistsError();
      throw error;
    }
  }

  async getObject(objectName: string): Promise<Buffer> {
    const response = await fetch(createTosPresignedGetUrl(this.config, objectName, 300));
    if (response.status === 404) throw new TemplateObjectNotFoundError();
    if (!response.ok) throw new UserFacingError('模板文件读取失败，请检查模板是否存在。');
    return Buffer.from(await response.arrayBuffer());
  }

  async deleteObject(objectName: string): Promise<void> {
    await deleteTosObject(this.config, objectName);
  }
}

export function createConfiguredTemplateObjectStore(): TemplateObjectStore {
  const provider = (process.env.DOCUMENT_TEMPLATE_STORAGE_PROVIDER || process.env.DOCUMENT_RENDER_STORAGE_PROVIDER || '').trim().toLowerCase();
  const tosConfig = readTemplateTosConfig();
  if (provider === 'tos') {
    if (tosConfig instanceof UserFacingError) throw tosConfig;
    if (!tosConfig) throw new UserFacingError('TOS 配置不完整，请检查 AccessKey、Bucket 和 Region。');
    return new TosTemplateObjectStore(tosConfig);
  }
  if (tosConfig instanceof UserFacingError) throw tosConfig;
  if (tosConfig) return new TosTemplateObjectStore(tosConfig);
  if (process.env.NODE_ENV === 'production') {
    throw new UserFacingError('生产环境必须配置 TOS 模板存储，不能使用本地临时模板存储。');
  }
  return new LocalTemplateObjectStore();
}
