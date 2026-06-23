// 渲染审计：把每次单份/批量 Docx 生成的运行时元数据写入 render_audit，供出问题时回溯。
// 设计约束：
//  - fire-and-forget：DATABASE_URL 没配则跳过，写入失败只 log，绝不影响渲染响应。
//  - 不存变量值本身（隐私），只存模板、状态、变量计数、下载位置、调用方。
import { insertRenderAudit } from './storage';

export type RenderAuditSource = 'single' | 'batch';
export type RenderAuditStatus = 'success' | 'failed';

export interface RenderAuditEntry {
  requestId: string;
  templateId: string | null;
  versionId: string | null;
  source: RenderAuditSource;
  status: RenderAuditStatus;
  errorMessage: string | null;
  variableCount: number | null;
  missingCount: number | null;
  storage: string | null;
  downloadPath: string | null;
  sizeBytes: number | null;
  caller: string | null;
}

interface RenderAuditResultLike {
  variables?: { provided?: string[]; missing?: string[] };
  download?: { storage?: string; path?: string; size?: number };
}

export interface BuildRenderAuditParams {
  requestId: string;
  source: RenderAuditSource;
  status: RenderAuditStatus;
  templateId?: string | null;
  versionId?: string | null;
  error?: unknown;
  result?: RenderAuditResultLike | null;
  caller?: string | null;
}

export function buildRenderAuditEntry(params: BuildRenderAuditParams): RenderAuditEntry {
  const variables = params.result?.variables;
  const download = params.result?.download;
  return {
    requestId: params.requestId,
    templateId: params.templateId ?? null,
    versionId: params.versionId ?? null,
    source: params.source,
    status: params.status,
    // 约定：渲染异常的 message 只含字段名/占位符/模板 ID/计数，不含变量值本身（隐私）。
    // 新增异常类型时必须遵守此约定，否则会把用户数据写进审计表。
    errorMessage:
      params.error === undefined || params.error === null
        ? null
        : params.error instanceof Error
          ? params.error.message
          : String(params.error),
    variableCount: Array.isArray(variables?.provided) ? variables!.provided!.length : null,
    missingCount: Array.isArray(variables?.missing) ? variables!.missing!.length : null,
    storage: download?.storage ?? null,
    downloadPath: download?.path ?? null,
    sizeBytes: typeof download?.size === 'number' ? download.size : null,
    caller: params.caller ?? null,
  };
}

export async function recordRenderAudit(entry: RenderAuditEntry): Promise<void> {
  // DATABASE_URL 没配（本地无库）则直接跳过，不尝试连接。
  if (!(process.env.DATABASE_URL || '').trim()) return;
  try {
    await insertRenderAudit(entry);
  } catch (error) {
    // 审计失败绝不能影响渲染：只记日志，不抛出。
    // eslint-disable-next-line no-console
    console.error(
      `[render-audit:${entry.requestId}:${entry.source}:${entry.status}] 审计写入失败`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

// 调用方类型：带 API Key 头视为 api-key（业务系统/工作流），否则视为侧边栏会话。
export function readAuditCaller(headers: {
  'x-api-key'?: string | string[];
  authorization?: string | string[];
}): string {
  // Express 对重复请求头会给出 string[]，取首个值再判断，避免数组被误判为无凭据。
  const apiKeyRaw = headers['x-api-key'];
  const apiKey = Array.isArray(apiKeyRaw) ? apiKeyRaw[0] : apiKeyRaw;
  const authorizationRaw = headers.authorization;
  const authorization = Array.isArray(authorizationRaw) ? authorizationRaw[0] : authorizationRaw;
  const hasApiKey = typeof apiKey === 'string' && apiKey.trim().length > 0;
  const hasBearer = typeof authorization === 'string' && /^Bearer\s+/i.test(authorization);
  return hasApiKey || hasBearer ? 'api-key' : 'session';
}
