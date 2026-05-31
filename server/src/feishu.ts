import axios, { AxiosError, AxiosInstance, Method } from 'axios';
import FormData from 'form-data';
import https from 'node:https';
import {
  FEISHU_OPEN_API,
  RETRYABLE_HTTP_STATUS,
  RETRYABLE_FEISHU_CODES,
  MAX_IMAGE_DOWNLOAD_BYTES,
  MAX_IMAGE_DOWNLOAD_REDIRECTS,
  ALLOWED_UPLOAD_IMAGE_TYPES,
  type FeishuEnvelope,
  type TenantTokenResponse,
  type ExtractTemplateResult,
  type GenerateRecordInput,
  type OwnerTransferInput,
  type CollaboratorInput,
  type GenerateInput,
  type GenerateResult,
  type SearchUserResult,
  type CachedToken,
  type RootFolderPayload,
  type DocumentInfoPayload,
  type RawContentPayload,
  type CopyFilePayload,
  type DocumentBlocksPage,
  type DepartmentChildrenPage,
  type ContactUsersPage,
  type SearchUsersPage,
  type FeishuClientOptions,
  type PermissionMode,
  type OwnerMemberType,
  FeishuApiError,
} from './feishuTypes';
import {
  validateImageDownloadUrl,
  prepareImageForUpload,
  normalizeContentType,
  __test__ as imageTest,
} from './feishuImageDownload';
import {
  replacePlaceholders,
  extractVariablesFromText,
  extractDocumentId,
  buildDocumentTitle,
  getTextElements,
  replaceElements,
  escapeRegExp,
  __test__ as replaceTest,
} from './feishuDocumentReplace';
import {
  toSearchUser,
  sortAndUniqueUsers,
  filterUsers,
  listAllDepartments,
  listUsersByDepartment,
  buildDirectoryUsers,
  trySearchUsersViaSearchApi,
  __test__ as userDirectoryTest,
} from './feishuUserDirectory';

// 常量、类型、接口已移到 feishuTypes.ts
// 图片下载相关函数已移到 feishuImageDownload.ts
// 文档替换相关函数已移到 feishuDocumentReplace.ts

// 保留 FeishuTemplateService 类使用的本地辅助函数
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

// 图片下载相关函数已移到 feishuImageDownload.ts
// 文档替换相关函数已移到 feishuDocumentReplace.ts

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

  // 用户目录搜索相关方法已移到 feishuUserDirectory.ts

  private async getDirectoryUsers(): Promise<SearchUserResult[]> {
    if (this.userDirectoryCache && this.userDirectoryCache.expiresAt > Date.now()) {
      return this.userDirectoryCache.users;
    }
    const users = await buildDirectoryUsers(this.request.bind(this));
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

  async searchUsers(keyword: string, limit = 20): Promise<SearchUserResult[]> {
    const normalizedKeyword = normalizeKeyword(keyword);
    if (!normalizedKeyword) {
      return [];
    }

    const safeLimit = Math.min(Math.max(limit, 1), 50);

    // 1. Try to fetch from memory cache first if we already have it
    if (this.userDirectoryCache && this.userDirectoryCache.expiresAt > Date.now()) {
      const allUsers = this.userDirectoryCache.users;
      const matched = filterUsers(allUsers, normalizedKeyword, safeLimit);
      if (matched.length > 0) {
        return matched;
      }
    }

    // 2. Try the search API directly (if available) since it's much faster than iterating all departments
    if (!this.searchApiUnavailable) {
      try {
        const directUsers = await trySearchUsersViaSearchApi(this.request.bind(this), normalizedKeyword, safeLimit);
        if (directUsers.length > 0) {
          // Merge to cache for future lookups
          if (this.userDirectoryCache) {
             const existingOpenIds = new Set(this.userDirectoryCache.users.map(u => u.openId));
             const newUsers = directUsers.filter(u => !existingOpenIds.has(u.openId));
             if (newUsers.length > 0) {
                 this.userDirectoryCache.users = sortAndUniqueUsers([...this.userDirectoryCache.users, ...newUsers]);
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
    let matched = filterUsers(allUsers, normalizedKeyword, safeLimit);

    if (matched.length > 0) {
      return matched;
    }

    // 4. Force refresh if nothing found (maybe new user was added)
    this.userDirectoryCache = null;
    allUsers = await this.getDirectoryUsers();
    return filterUsers(allUsers, normalizedKeyword, safeLimit);
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

export { FeishuApiError };
export type { CollaboratorInput, GenerateInput, GenerateResult, OwnerMemberType, OwnerTransferInput, PermissionMode, SearchUserResult };

export const __test__ = {
  isBlockedIpAddress: imageTest.isBlockedIpAddress,
  isAllowedImageHost: imageTest.isAllowedImageHost,
  replaceElements,
};
