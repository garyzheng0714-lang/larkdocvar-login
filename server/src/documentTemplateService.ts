import path from 'node:path';
import { DOCX_CONTENT_TYPE } from './documentRenderFile';
import { UserFacingError } from './documentRenderStorageErrors';
import { analyzeTemplate, loadTemplateSource, type TemplateSource } from './documentTemplateAnalysis';
import { inspectTemplate, type TemplateInspection } from './documentTemplateInspect';
import { TemplateStoreMutex } from './documentTemplateStoreLock';
import { TemplateObjectNotFoundError, createConfiguredTemplateObjectStore, type TemplateObjectStore } from './documentTemplateStorage';
import { buildTemplateThumbnail, type DocumentTemplateThumbnail } from './documentTemplateThumbnail';
import { DocumentVariableStore } from './documentVariableDictionary';

export type { DocumentTemplateThumbnail, DocumentTemplateThumbnailLine } from './documentTemplateThumbnail';
export type { TemplateInspection } from './documentTemplateInspect';

// 内部版本后缀（如 -Ed0622）：上传模板时带上、仅供内部区分版本，不该展示给插件用户。
// 对外返回模板前在读取路径统一抹掉；对象存储里的原始 _index.json / metadata.json 不变。
// 将来换/加后缀只改这个常量即可，无需改数据。
const INTERNAL_TEMPLATE_NAME_SUFFIXES = ['-Ed0622'];

export function stripInternalTemplateNameSuffix(value: string): string {
  let result = value ?? '';
  for (const suffix of INTERNAL_TEMPLATE_NAME_SUFFIXES) {
    if (suffix) result = result.split(suffix).join('');
  }
  return result;
}

const TEMPLATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/;
const TEMPLATE_METADATA_CONTENT_TYPE = 'application/json; charset=utf-8';
const TEMPLATE_INDEX_CONTENT_TYPE = 'application/json; charset=utf-8';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type DocumentTemplateVersion = {
  versionId: string;
  versionNumber: number;
  storagePath: string;
  fileName: string;
  sourceUrl: string;
  sha256: string;
  // 上传前原文件的指纹（批注转变量之前）；老版本没有这个字段。
  sourceSha256?: string;
  size: number;
  variables: string[];
  thumbnail?: DocumentTemplateThumbnail;
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
  // 可选：「检查模板」返回的 sha256。传了就要求这次拿到的文件和检查时是同一份，防止检查后文件被换掉。
  expectedSha256?: string;
};

export type UpdateDocumentTemplateInput = Omit<CreateDocumentTemplateInput, 'templateId' | 'createdByOpenId'>;

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

function publicTemplate(record: DocumentTemplateRecord): PublicDocumentTemplateRecord {
  return {
    ...record,
    name: stripInternalTemplateNameSuffix(record.name),
    versions: record.versions.map(({ sourceUrl: _sourceUrl, ...version }) => ({
      ...version,
      thumbnail: version.thumbnail || buildTemplateThumbnail(record.name, version.variables),
    })),
  };
}

function indexItemWithThumbnail(item: DocumentTemplateIndexItem): DocumentTemplateIndexItem {
  return {
    ...item,
    name: stripInternalTemplateNameSuffix(item.name),
    thumbnail: item.thumbnail || buildTemplateThumbnail(item.name, item.variables || []),
  };
}

function assertExpectedSha256(source: TemplateSource, expected: string | undefined): void {
  const wanted = expected?.trim().toLowerCase();
  if (!wanted) return;
  if (!SHA256_PATTERN.test(wanted)) throw new UserFacingError('expectedSha256 格式不对，应是「检查模板」返回的 sha256。');
  if (wanted !== source.sourceSha256) throw new UserFacingError('模板文件和检查时不是同一份，请重新检查后再发布。');
}

export class DocumentTemplateService {
  private readonly mutex: TemplateStoreMutex;
  // 变量词典和模板放在同一个存储里，共用一把写锁。
  readonly variables: DocumentVariableStore;

  constructor(private readonly store: TemplateObjectStore = createConfiguredTemplateObjectStore()) {
    this.mutex = new TemplateStoreMutex(store);
    this.variables = new DocumentVariableStore(store, (operation) => this.mutex.run(operation));
  }

  private withTemplateMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutex.run(operation);
  }

  async listTemplates(options: { includeDeleted?: boolean } = {}): Promise<DocumentTemplateIndexItem[]> {
    const index = await this.readIndex();
    return index
      .filter((item) => options.includeDeleted || item.status !== 'deleted')
      .map(indexItemWithThumbnail)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createTemplate(input: CreateDocumentTemplateInput): Promise<PublicDocumentTemplateRecord> {
    return this.withTemplateMutationLock(async () => {
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
    return this.withTemplateMutationLock(async () => {
      const record = await this.getTemplateInternal(templateId);
      if (record.status === 'deleted') throw new UserFacingError('模板已删除，不能新增版本。');
      const versionNumber = Math.max(...record.versions.map((version) => version.versionNumber), 0) + 1;
      const version = await this.createVersion(record.templateId, versionNumber, input);
      record.versions.push(version);
      record.activeVersionId = version.versionId;
      this.applyMetadataUpdate(record, input);
      record.updatedAt = new Date().toISOString();
      await this.writeRecord(record);
      await this.upsertIndex(record);
      return publicTemplate(record);
    });
  }

  async updateTemplateMetadata(templateId: string, input: UpdateDocumentTemplateInput): Promise<PublicDocumentTemplateRecord> {
    return this.withTemplateMutationLock(async () => {
      const record = await this.getTemplateInternal(templateId);
      if (record.status === 'deleted') throw new UserFacingError('模板已删除，不能修改信息。');
      this.applyMetadataUpdate(record, input);
      record.updatedAt = new Date().toISOString();
      await this.writeRecord(record);
      await this.upsertIndex(record);
      return publicTemplate(record);
    });
  }

  // 把已有的某个版本设为现用版本：发布新版本后发现不对，用它退回旧版本。
  async publishVersion(templateId: string, versionId: string, actorOpenId?: string): Promise<PublicDocumentTemplateRecord> {
    return this.withTemplateMutationLock(async () => {
      const record = await this.getTemplateInternal(templateId);
      if (record.status === 'deleted') throw new UserFacingError('模板已删除，不能发布版本。');
      const targetVersionId = versionId.trim();
      if (!record.versions.some((version) => version.versionId === targetVersionId)) throw new UserFacingError('模板版本不存在。');
      if (record.activeVersionId === targetVersionId) return publicTemplate(record);
      record.activeVersionId = targetVersionId;
      record.updatedByOpenId = cleanOptionalText(actorOpenId, 128) || record.updatedByOpenId;
      record.updatedAt = new Date().toISOString();
      await this.writeRecord(record);
      await this.upsertIndex(record);
      return publicTemplate(record);
    });
  }

  async inspectTemplate(
    input: Parameters<typeof inspectTemplate>[0],
    options: { canRead?: (template: DocumentTemplateIndexItem) => boolean } = {},
  ): Promise<TemplateInspection> {
    return inspectTemplate(input, {
      listTemplates: async () => (await this.listTemplates()).filter((item) => !options.canRead || options.canRead(item)),
      getTemplate: (templateId) => this.getTemplateInternal(templateId),
      listVariables: () => this.variables.list(),
    });
  }

  private applyMetadataUpdate(record: DocumentTemplateRecord, input: UpdateDocumentTemplateInput): void {
    record.name = input.name?.trim() || record.name;
    if (Object.prototype.hasOwnProperty.call(input, 'category')) {
      record.category = cleanOptionalText(input.category, 64);
    }
    record.visibility = input.visibility || record.visibility;
    if (Object.prototype.hasOwnProperty.call(input, 'description')) {
      record.description = cleanOptionalText(input.description, 1000);
    }
    record.updatedByOpenId = cleanOptionalText(input.updatedByOpenId, 128) || record.updatedByOpenId;
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
    return this.withTemplateMutationLock(async () => {
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
    const source = await loadTemplateSource(input);
    assertExpectedSha256(source, input.expectedSha256);
    const analyzed = await analyzeTemplate(source, input);
    return {
      versionId: buildVersionId(templateId, versionNumber),
      versionNumber,
      storagePath: await this.store.putObject(versionKey(templateId, versionNumber), analyzed.buffer, DOCX_CONTENT_TYPE),
      fileName: analyzed.fileName,
      sourceUrl: source.sourceUrl || 'uploaded',
      sha256: analyzed.sha256,
      sourceSha256: source.sourceSha256,
      size: analyzed.size,
      variables: analyzed.variables,
      thumbnail: analyzed.thumbnail,
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

