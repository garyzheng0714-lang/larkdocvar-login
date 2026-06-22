import { createHash } from 'node:crypto';
import path from 'node:path';
import { DOCX_CONTENT_TYPE, ensureDocxExtension, sanitizeFileName } from './documentRenderFile';
import { UserFacingError } from './documentRenderStorageErrors';
import { downloadTemplateDocx, renderDocx } from './documentRenderApi';
import { isImagePlaceholderName } from './documentRenderImages';
import { convertCommentAnnotationsToTemplate } from './documentTemplateAnnotations';
import { TemplateObjectNotFoundError, createConfiguredTemplateObjectStore, type TemplateObjectStore } from './documentTemplateStorage';

const TEMPLATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/;
const TEMPLATE_METADATA_CONTENT_TYPE = 'application/json; charset=utf-8';
const TEMPLATE_INDEX_CONTENT_TYPE = 'application/json; charset=utf-8';

export type DocumentTemplateVersion = {
  versionId: string;
  versionNumber: number;
  storagePath: string;
  fileName: string;
  sourceUrl: string;
  sha256: string;
  size: number;
  variables: string[];
  thumbnail?: DocumentTemplateThumbnail;
  createdAt: string;
};

export type DocumentTemplateThumbnailLine = {
  text: string;
  role: 'title' | 'body';
};

export type DocumentTemplateThumbnail = {
  kind: 'docx-outline';
  pageRatio: number;
  lines: DocumentTemplateThumbnailLine[];
  variableNames: string[];
  hasImagePlaceholders: boolean;
};

export type DocumentTemplateRecord = {
  templateId: string;
  name: string;
  category?: string;
  visibility?: 'private' | 'shared';
  description?: string;
  createdByOpenId?: string;
  updatedByOpenId?: string;
  status: 'active' | 'deleted';
  activeVersionId: string;
  versions: DocumentTemplateVersion[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type PublicDocumentTemplateVersion = Omit<DocumentTemplateVersion, 'sourceUrl'>;
export type PublicDocumentTemplateRecord = Omit<DocumentTemplateRecord, 'versions'> & {
  versions: PublicDocumentTemplateVersion[];
};

export type DocumentTemplateIndexItem = {
  templateId: string;
  name: string;
  category?: string;
  visibility?: 'private' | 'shared';
  description?: string;
  createdByOpenId?: string;
  updatedByOpenId?: string;
  status: 'active' | 'deleted';
  activeVersionId: string;
  versionCount: number;
  variables: string[];
  thumbnail?: DocumentTemplateThumbnail;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type LoadedDocumentTemplate = {
  record: DocumentTemplateRecord;
  version: DocumentTemplateVersion;
  buffer: Buffer;
};

export type CreateDocumentTemplateInput = {
  templateId?: string;
  name?: string;
  url?: string;
  fileBase64?: string;
  fileName?: string;
  category?: string;
  visibility?: 'private' | 'shared';
  description?: string;
  createdByOpenId?: string;
  updatedByOpenId?: string;
};

type UpdateDocumentTemplateInput = Omit<CreateDocumentTemplateInput, 'templateId' | 'createdByOpenId'>;

const MAX_UPLOADED_TEMPLATE_BYTES = 20 * 1024 * 1024;

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function assertTemplateId(templateId: string): void {
  if (!TEMPLATE_ID_PATTERN.test(templateId)) {
    throw new UserFacingError('模板编号只能包含字母、数字、下划线和中划线，长度 3 到 80。');
  }
}

function metadataKey(templateId: string): string {
  return `${templateId}/metadata.json`;
}

function indexKey(): string {
  return '_index.json';
}

function versionKey(templateId: string, versionNumber: number): string {
  return `${templateId}/versions/v${String(versionNumber).padStart(3, '0')}/source.docx`;
}

function buildVersionId(templateId: string, versionNumber: number): string {
  return `${templateId}_v${String(versionNumber).padStart(3, '0')}`;
}

function normalizeRecord(input: unknown): DocumentTemplateRecord {
  const record = input as DocumentTemplateRecord;
  if (!record || typeof record !== 'object' || !record.templateId || !Array.isArray(record.versions)) {
    throw new UserFacingError('模板记录损坏，请联系管理员处理。');
  }
  return record;
}

function cleanOptionalText(value: string | undefined, maxLength: number): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function decodeUploadedTemplate(input: CreateDocumentTemplateInput | UpdateDocumentTemplateInput): Buffer | null {
  const raw = input.fileBase64?.trim();
  if (!raw) return null;
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw new UserFacingError('模板文件内容不合法，请重新上传。');
  }
  if (buffer.length === 0) throw new UserFacingError('模板文件为空，请重新上传。');
  if (buffer.length > MAX_UPLOADED_TEMPLATE_BYTES) throw new UserFacingError('Docx 模板不能超过 20MB。');
  return buffer;
}

function publicTemplate(record: DocumentTemplateRecord): PublicDocumentTemplateRecord {
  return {
    ...record,
    versions: record.versions.map(({ sourceUrl: _sourceUrl, ...version }) => ({
      ...version,
      thumbnail: version.thumbnail || buildTemplateThumbnail(record.name, version.variables),
    })),
  };
}

function stripImagePrefix(input: string): string {
  return input.trim().replace(/^(image:|图片:)/i, '').trim();
}

function normalizeThumbnailText(input: string): string {
  return input
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawName: string) => stripImagePrefix(rawName))
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(input: string, maxLength: number): string {
  return input.length > maxLength ? `${input.slice(0, maxLength - 3)}...` : input;
}

function buildTemplateThumbnail(previewText: string, variables: string[]): DocumentTemplateThumbnail {
  const lines = previewText
    .split(/\r?\n/)
    .map((line) => truncateText(normalizeThumbnailText(line), 42))
    .filter(Boolean)
    .slice(0, 8)
    .map((text, index): DocumentTemplateThumbnailLine => ({
      text,
      role: index === 0 && text.length <= 24 ? 'title' : 'body',
    }));
  const variableNames = variables
    .filter((name) => !isImagePlaceholderName(name))
    .map(stripImagePrefix)
    .filter(Boolean)
    .slice(0, 6);

  return {
    kind: 'docx-outline',
    pageRatio: 1.414,
    lines: lines.length > 0 ? lines : variableNames.slice(0, 3).map((text) => ({ text, role: 'body' })),
    variableNames,
    hasImagePlaceholders: variables.some(isImagePlaceholderName),
  };
}

function indexItemWithThumbnail(item: DocumentTemplateIndexItem): DocumentTemplateIndexItem {
  return {
    ...item,
    thumbnail: item.thumbnail || buildTemplateThumbnail(item.name, item.variables || []),
  };
}

export class DocumentTemplateService {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly store: TemplateObjectStore = createConfiguredTemplateObjectStore()) {}

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async listTemplates(options: { includeDeleted?: boolean } = {}): Promise<DocumentTemplateIndexItem[]> {
    const index = await this.readIndex();
    return index
      .filter((item) => options.includeDeleted || item.status !== 'deleted')
      .map(indexItemWithThumbnail)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createTemplate(input: CreateDocumentTemplateInput): Promise<PublicDocumentTemplateRecord> {
    return this.withMutationLock(async () => {
      const templateId = input.templateId?.trim() || await this.generateTemplateId();
      assertTemplateId(templateId);
      const existing = await this.getTemplateOrNull(templateId);
      if (existing) throw new UserFacingError('模板编号已存在，请换一个编号或新增版本。');
      const now = new Date().toISOString();
      const version = await this.createVersion(templateId, 1, input);
      const actorOpenId = cleanOptionalText(input.createdByOpenId, 128);
      const record: DocumentTemplateRecord = {
        templateId,
        name: input.name?.trim() || path.basename(version.fileName, '.docx') || templateId,
        category: cleanOptionalText(input.category, 64),
        visibility: input.visibility,
        description: cleanOptionalText(input.description, 1000),
        createdByOpenId: actorOpenId,
        updatedByOpenId: cleanOptionalText(input.updatedByOpenId, 128) || actorOpenId,
        status: 'active',
        activeVersionId: version.versionId,
        versions: [version],
        createdAt: now,
        updatedAt: now,
      };
      await this.writeRecord(record);
      await this.upsertIndex(record);
      return publicTemplate(record);
    });
  }

  async addVersion(templateId: string, input: UpdateDocumentTemplateInput): Promise<PublicDocumentTemplateRecord> {
    return this.withMutationLock(async () => {
      const record = await this.getTemplateInternal(templateId);
      if (record.status === 'deleted') throw new UserFacingError('模板已删除，不能新增版本。');
      const versionNumber = Math.max(...record.versions.map((version) => version.versionNumber), 0) + 1;
      const version = await this.createVersion(record.templateId, versionNumber, input);
      record.versions.push(version);
      record.activeVersionId = version.versionId;
      record.name = input.name?.trim() || record.name;
      record.category = cleanOptionalText(input.category, 64) || record.category;
      record.visibility = input.visibility || record.visibility;
      if (Object.prototype.hasOwnProperty.call(input, 'description')) {
        record.description = cleanOptionalText(input.description, 1000);
      }
      record.updatedByOpenId = cleanOptionalText(input.updatedByOpenId, 128) || record.updatedByOpenId;
      record.updatedAt = new Date().toISOString();
      await this.writeRecord(record);
      await this.upsertIndex(record);
      return publicTemplate(record);
    });
  }

  async getTemplate(templateId: string): Promise<PublicDocumentTemplateRecord> {
    return publicTemplate(await this.getTemplateInternal(templateId));
  }

  private async getTemplateInternal(templateId: string): Promise<DocumentTemplateRecord> {
    assertTemplateId(templateId);
    const record = await this.getTemplateOrNull(templateId);
    if (!record) throw new UserFacingError('模板不存在。');
    return record;
  }

  async loadTemplate(templateId: string, versionId?: string): Promise<LoadedDocumentTemplate> {
    const record = await this.getTemplateInternal(templateId);
    if (record.status === 'deleted') throw new UserFacingError('模板已删除，不能用于生成。');
    const targetVersionId = versionId?.trim() || record.activeVersionId;
    const version = record.versions.find((item) => item.versionId === targetVersionId);
    if (!version) throw new UserFacingError('模板版本不存在。');
    const buffer = await this.store.getObject(version.storagePath);
    return { record, version, buffer };
  }

  async deleteTemplate(templateId: string, options: { purge?: boolean } = {}): Promise<PublicDocumentTemplateRecord> {
    return this.withMutationLock(async () => {
      const record = await this.getTemplateInternal(templateId);
      if (options.purge) {
        await Promise.all(record.versions.map((version) => this.store.deleteObject(version.storagePath).catch(() => undefined)));
        await this.store.deleteObject(this.store.objectName(metadataKey(record.templateId))).catch(() => undefined);
        await this.removeFromIndex(record.templateId);
        return publicTemplate({ ...record, status: 'deleted', deletedAt: new Date().toISOString() });
      }
      record.status = 'deleted';
      record.deletedAt = new Date().toISOString();
      record.updatedAt = record.deletedAt;
      await this.writeRecord(record);
      await this.upsertIndex(record);
      return publicTemplate(record);
    });
  }

  private async getTemplateOrNull(templateId: string): Promise<DocumentTemplateRecord | null> {
    assertTemplateId(templateId);
    try {
      const buffer = await this.store.getObject(this.store.objectName(metadataKey(templateId)));
      return normalizeRecord(JSON.parse(buffer.toString('utf8')));
    } catch (error) {
      if (error instanceof TemplateObjectNotFoundError) return null;
      throw error;
    }
  }

  private async generateTemplateId(): Promise<string> {
    const index = await this.readIndex();
    const used = new Set(index.map((item) => item.templateId));
    let maxSerial = 0;
    for (const item of index) {
      const match = item.templateId.match(/^tpl_(\d+)$/);
      if (!match) continue;
      maxSerial = Math.max(maxSerial, Number(match[1]));
    }

    for (let serial = maxSerial + 1; serial < 1_000_000; serial += 1) {
      const templateId = `tpl_${String(serial).padStart(3, '0')}`;
      if (used.has(templateId)) continue;
      if (await this.getTemplateOrNull(templateId)) continue;
      return templateId;
    }

    throw new UserFacingError('模板编号已用尽，请手动指定模板编号。');
  }

  private async createVersion(templateId: string, versionNumber: number, input: CreateDocumentTemplateInput | UpdateDocumentTemplateInput): Promise<DocumentTemplateVersion> {
    const sourceUrl = input.url?.trim() || '';
    const uploadedBuffer = decodeUploadedTemplate(input);
    if (!sourceUrl && !uploadedBuffer) throw new UserFacingError('模板链接或模板文件不能为空。');
    const downloadedBuffer = uploadedBuffer || await downloadTemplateDocx(sourceUrl);
    const annotated = await convertCommentAnnotationsToTemplate(downloadedBuffer);
    const buffer = annotated.buffer;
    const rendered = await renderDocx(buffer, {});
    const variables = annotated.variables.length > 0 ? annotated.variables : rendered.found;
    // 缩略图预览：用变量名自身作为值再渲染一次，让占位符显示为变量名。
    // （renderDocx 对未提供的变量会替换成空串，直接用空变量渲染会丢失占位符文本。）
    const previewVariables: Record<string, string> = {};
    for (const name of variables) {
      if (!isImagePlaceholderName(name)) previewVariables[name] = stripImagePrefix(name);
    }
    const preview = Object.keys(previewVariables).length > 0
      ? await renderDocx(buffer, previewVariables)
      : rendered;
    const fileName = ensureDocxExtension(sanitizeFileName(input.fileName || input.name || '模板.docx', '模板.docx'));
    return {
      versionId: buildVersionId(templateId, versionNumber),
      versionNumber,
      storagePath: await this.store.putObject(versionKey(templateId, versionNumber), buffer, DOCX_CONTENT_TYPE),
      fileName,
      sourceUrl: sourceUrl || 'uploaded',
      sha256: sha256(buffer),
      size: buffer.length,
      variables,
      thumbnail: buildTemplateThumbnail(preview.previewText, variables),
      createdAt: new Date().toISOString(),
    };
  }

  private async writeRecord(record: DocumentTemplateRecord): Promise<void> {
    await this.store.putObject(
      metadataKey(record.templateId),
      Buffer.from(JSON.stringify(record, null, 2)),
      TEMPLATE_METADATA_CONTENT_TYPE,
    );
  }

  private toIndexItem(record: DocumentTemplateRecord): DocumentTemplateIndexItem {
    const activeVersion = record.versions.find((version) => version.versionId === record.activeVersionId) || record.versions[record.versions.length - 1];
    return {
      templateId: record.templateId,
      name: record.name,
      category: record.category,
      visibility: record.visibility,
      description: record.description,
      createdByOpenId: record.createdByOpenId,
      updatedByOpenId: record.updatedByOpenId,
      status: record.status,
      activeVersionId: record.activeVersionId,
      versionCount: record.versions.length,
      variables: activeVersion?.variables || [],
      thumbnail: activeVersion?.thumbnail || buildTemplateThumbnail(record.name, activeVersion?.variables || []),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt,
    };
  }

  private async readIndex(): Promise<DocumentTemplateIndexItem[]> {
    try {
      const buffer = await this.store.getObject(this.store.objectName(indexKey()));
      const parsed = JSON.parse(buffer.toString('utf8')) as { templates?: unknown };
      return Array.isArray(parsed.templates)
        ? parsed.templates.filter((item): item is DocumentTemplateIndexItem => Boolean(item && typeof item === 'object' && (item as DocumentTemplateIndexItem).templateId))
        : [];
    } catch (error) {
      if (error instanceof TemplateObjectNotFoundError) return [];
      throw error;
    }
  }

  private async writeIndex(templates: DocumentTemplateIndexItem[]): Promise<void> {
    await this.store.putObject(
      indexKey(),
      Buffer.from(JSON.stringify({ templates }, null, 2)),
      TEMPLATE_INDEX_CONTENT_TYPE,
    );
  }

  private async upsertIndex(record: DocumentTemplateRecord): Promise<void> {
    const item = this.toIndexItem(record);
    const index = await this.readIndex();
    const next = [item, ...index.filter((existing) => existing.templateId !== record.templateId)];
    await this.writeIndex(next);
  }

  private async removeFromIndex(templateId: string): Promise<void> {
    const index = await this.readIndex();
    await this.writeIndex(index.filter((item) => item.templateId !== templateId));
  }
}
