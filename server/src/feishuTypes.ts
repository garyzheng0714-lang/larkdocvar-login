// feishuTypes.ts — 飞书 API 相关类型和常量定义

export const FEISHU_OPEN_API = 'https://open.feishu.cn/open-apis';
export const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);
export const RETRYABLE_FEISHU_CODES = new Set([99991400, 1061045, 1063006, 1254290, 1254291]);
export const MAX_IMAGE_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_DOWNLOAD_REDIRECTS = 3;
export const MAX_IMAGE_INPUT_PIXELS = 36_000_000;
export const ALLOWED_UPLOAD_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
export const ALLOWED_DECODED_IMAGE_FORMATS = new Set([
  'png',
  'jpeg',
  'webp',
  'gif',
]);
export const DEFAULT_IMAGE_DOWNLOAD_ALLOWED_HOSTS = [
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
export const IMAGE_DOWNLOAD_ALLOWED_HOSTS = (
  process.env.FEISHU_IMAGE_DOWNLOAD_ALLOWED_HOSTS || DEFAULT_IMAGE_DOWNLOAD_ALLOWED_HOSTS.join(',')
)
  .split(',')
  .map((host) => host.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, ''))
  .filter(Boolean);
export const UPDATABLE_TEXT_KEYS = new Set([
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
  'todo',
  'callout',
  'table_cell',
]);

export type PermissionMode = 'tenant_readable' | 'tenant_editable' | 'closed';
export type OwnerMemberType = 'userid' | 'openid' | 'email';

export interface FeishuEnvelope<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

export interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

export interface ExtractTemplateResult {
  documentId: string;
  templateTitle: string;
  variables: string[];
}

export interface GenerateRecordInput {
  recordId: string;
  variables: Record<string, string>;
  imageVariables?: Record<string, { urls: string[]; width: number }>;
  title?: string;
  folderToken?: string;
}

export interface OwnerTransferInput {
  memberType: OwnerMemberType;
  memberId: string;
  needNotification?: boolean;
  removeOldOwner?: boolean;
  stayPut?: boolean;
  oldOwnerPerm?: 'view' | 'edit' | 'full_access';
}

export interface CollaboratorInput {
  memberType: 'openid' | 'email' | 'userid';
  memberId: string;
  perm: 'view' | 'edit' | 'full_access';
}

export interface GenerateInput {
  templateUrl: string;
  records: GenerateRecordInput[];
  permissionMode: PermissionMode;
  ownerTransfer?: OwnerTransferInput;
  collaborators?: CollaboratorInput[];
}

export interface GenerateResult {
  recordId: string;
  status: 'success' | 'failed';
  docUrl?: string;
  documentId?: string;
  documentTitle?: string;
  replacedBlocks?: number;
  warnings?: string[];
  error?: string;
}

export interface SearchUserResult {
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

export interface CachedToken {
  value: string;
  expiresAt: number;
}

export interface RootFolderPayload {
  token: string;
}

export interface DocumentInfoPayload {
  document?: {
    title?: string;
  };
}

export interface RawContentPayload {
  content: string;
}

export interface CopyFilePayload {
  file?: {
    token?: string;
    url?: string;
  };
}

export interface DocumentBlocksPage {
  items?: Array<Record<string, unknown>>;
  has_more?: boolean;
  page_token?: string;
}

export interface DepartmentChildrenPage {
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

export interface ContactUsersPage {
  has_more?: boolean;
  page_token?: string;
  items?: Array<{
    open_id?: string;
    user_id?: string;
    name?: string;
    en_name?: string;
    nickname?: string;
    email?: string;
    department_ids?: string[];
    avatar?: { avatar_72?: string; avatar_240?: string; avatar_640?: string; avatar_origin?: string };
    tenant_key?: string;
  }>;
}

export interface SearchUsersPage {
  has_more?: boolean;
  page_token?: string;
  users?: Array<{
    open_id?: string;
    user_id?: string;
    name?: string;
    en_name?: string;
    nickname?: string;
    email?: string;
    department_ids?: string[];
    avatar?: { avatar_72?: string; avatar_240?: string; avatar_640?: string; avatar_origin?: string };
    tenant_key?: string;
  }>;
}

export interface VerifiedImageDownloadTarget {
  url: URL;
  lookup: import('node:net').LookupFunction;
}

export interface FeishuClientOptions {
  appId: string;
  appSecret: string;
}

export class FeishuApiError extends Error {
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
