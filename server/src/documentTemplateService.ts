import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { DOCX_CONTENT_TYPE, ensureDocxExtension, sanitizeFileName } from './documentRenderFile';
import { UserFacingError } from './documentRenderStorageErrors';
import { downloadTemplateDocx, renderDocx } from './documentRenderApi';
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
  createdAt: string;
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

function todayCompact(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function generateTemplateId(): string {
  return `tpl_${todayCompact()}_${randomBytes(4).toString('hex')}`;
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
    versions: record.versions.map(({ sourceUrl: _sourceUrl, ...version }) => ({ ...version })),
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
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createTemplate(input: CreateDocumentTemplateInput): Promise<PublicDocumentTemplateRecord> {
    return this.withMutationLock(async () => {
      const templateId = input.templateId?.trim() || generateTemplateId();
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
      record.description = cleanOptionalText(input.description, 1000) ?? record.description;
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

  private async createVersion(templateId: string, versionNumber: number, input: CreateDocumentTemplateInput | UpdateDocumentTemplateInput): Promise<DocumentTemplateVersion> {
    const sourceUrl = input.url?.trim() || '';
    const uploadedBuffer = decodeUploadedTemplate(input);
    if (!sourceUrl && !uploadedBuffer) throw new UserFacingError('模板链接或模板文件不能为空。');
    const downloadedBuffer = uploadedBuffer || await downloadTemplateDocx(sourceUrl);
    const annotated = await convertCommentAnnotationsToTemplate(downloadedBuffer);
    const buffer = annotated.buffer;
    const rendered = await renderDocx(buffer, {});
    const fileName = ensureDocxExtension(sanitizeFileName(input.fileName || input.name || '模板.docx', '模板.docx'));
    return {
      versionId: buildVersionId(templateId, versionNumber),
      versionNumber,
      storagePath: await this.store.putObject(versionKey(templateId, versionNumber), buffer, DOCX_CONTENT_TYPE),
      fileName,
      sourceUrl: sourceUrl || 'uploaded',
      sha256: sha256(buffer),
      size: buffer.length,
      variables: annotated.variables.length > 0 ? annotated.variables : rendered.found,
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
