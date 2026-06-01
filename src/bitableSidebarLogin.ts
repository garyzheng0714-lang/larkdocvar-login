import { bitable } from '@lark-base-open/js-sdk';

export interface BitableSidebarLoginUser {
  open_id: string;
  name: string;
  en_name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

export interface BitableSidebarLoginResult {
  sessionToken: string;
  user: BitableSidebarLoginUser;
}

export interface BitableSidebarLoginDiagnostics {
  stage: string;
  message: string;
  hasBitable: boolean;
  hasBridge: boolean;
  hasBase: boolean;
  hasOpenId?: boolean;
  hasBaseId?: boolean;
  hasTableId?: boolean;
  responseStatus?: number;
  responseError?: string;
  isIframe?: boolean;
  referrerOrigin?: string;
  userAgent?: string;
}

export class BitableSidebarLoginError extends Error {
  diagnostics: BitableSidebarLoginDiagnostics;

  constructor(diagnostics: BitableSidebarLoginDiagnostics) {
    super(diagnostics.message);
    this.name = 'BitableSidebarLoginError';
    this.diagnostics = diagnostics;
  }
}

interface BitableSelection {
  baseId?: string | null;
  tableId?: string | null;
}

interface BitableTableLike {
  id?: string | null;
}

interface BitableSidebarSdk {
  bridge: {
    getUserId(): Promise<string>;
    getBaseUserId(): Promise<string>;
    getTenantKey(): Promise<string>;
  };
  base: {
    getSelection(): Promise<BitableSelection | null>;
    getActiveTable?(): Promise<BitableTableLike | null>;
  };
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
    task.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getReferrerOrigin(): string {
  if (typeof document === 'undefined') return '';
  try {
    return document.referrer ? new URL(document.referrer).origin : '';
  } catch {
    return '';
  }
}

function isIframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function getRuntimeDiagnostics(
  sdk: Partial<BitableSidebarSdk> | null | undefined,
): Pick<BitableSidebarLoginDiagnostics, 'hasBitable' | 'hasBridge' | 'hasBase' | 'isIframe' | 'referrerOrigin' | 'userAgent'> {
  return {
    hasBitable: Boolean(sdk),
    hasBridge: Boolean(sdk?.bridge),
    hasBase: Boolean(sdk?.base),
    isIframe: isIframe(),
    referrerOrigin: getReferrerOrigin(),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent.slice(0, 240),
  };
}

function createLoginError(
  stage: string,
  message: string,
  sdk: Partial<BitableSidebarSdk> | null | undefined,
  details: Partial<BitableSidebarLoginDiagnostics> = {},
): BitableSidebarLoginError {
  return new BitableSidebarLoginError({
    stage,
    message,
    ...getRuntimeDiagnostics(sdk),
    ...details,
  });
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '侧边栏自动登录失败。');
}

export function getBitableSidebarLoginDiagnostics(error: unknown): BitableSidebarLoginDiagnostics {
  if (error instanceof BitableSidebarLoginError) {
    return error.diagnostics;
  }
  return {
    stage: 'unknown',
    message: toMessage(error),
    ...getRuntimeDiagnostics(bitable as unknown as Partial<BitableSidebarSdk>),
  };
}

export function buildBitablePluginLoginRequest(input: {
  openId: string;
  selection: BitableSelection | null;
  baseUserId?: string;
  tenantKey?: string;
}): { headers: Record<string, string>; body: string } {
  const openId = clean(input.openId);
  const baseId = clean(input.selection?.baseId);
  const tableId = clean(input.selection?.tableId);
  if (!openId || !baseId || !tableId) {
    throw createLoginError(
      'missing_sidebar_context',
      '请在飞书多维表格侧边栏中打开插件后再操作。',
      bitable as unknown as Partial<BitableSidebarSdk>,
      {
        hasOpenId: Boolean(openId),
        hasBaseId: Boolean(baseId),
        hasTableId: Boolean(tableId),
      },
    );
  }

  return {
    headers: {
      'Content-Type': 'application/json',
      'X-Bitable-Base-Id': baseId,
      'X-Bitable-Table-Id': tableId,
      ...(clean(input.baseUserId) ? { 'X-Bitable-Base-User-Id': clean(input.baseUserId) } : {}),
      ...(clean(input.tenantKey) ? { 'X-Bitable-Tenant-Key': clean(input.tenantKey) } : {}),
    },
    body: JSON.stringify({ open_id: openId }),
  };
}

export async function loginWithBitableSidebar(options: {
  sdk?: BitableSidebarSdk;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<BitableSidebarLoginResult> {
  const sdk = options.sdk ?? bitable;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3500;

  let openId = '';
  let selection: BitableSelection | null = null;
  let baseUserId = '';
  let tenantKey = '';
  try {
    const [nextOpenId, nextSelection, nextActiveTable, nextBaseUserId, nextTenantKey] = await withTimeout(Promise.all([
      sdk.bridge.getUserId(),
      sdk.base.getSelection().catch(() => null),
      sdk.base.getActiveTable ? sdk.base.getActiveTable().catch(() => null) : Promise.resolve(null),
      sdk.bridge.getBaseUserId().catch(() => ''),
      sdk.bridge.getTenantKey().catch(() => ''),
    ]), timeoutMs, '侧边栏身份读取超时。');

    openId = nextOpenId;
    selection = {
      ...(nextSelection ?? {}),
      tableId: clean(nextSelection?.tableId) || clean(nextActiveTable?.id) || null,
    };
    baseUserId = nextBaseUserId;
    tenantKey = nextTenantKey;
  } catch (error) {
    if (error instanceof BitableSidebarLoginError) throw error;
    throw createLoginError('sdk_identity_unavailable', toMessage(error), sdk);
  }

  const request = buildBitablePluginLoginRequest({
    openId,
    selection,
    baseUserId,
    tenantKey,
  });

  let response: Response;
  try {
    response = await fetchImpl('/api/auth/plugin-login', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: request.headers,
      body: request.body,
    });
  } catch (error) {
    throw createLoginError('plugin_login_network', toMessage(error), sdk, {
      hasOpenId: Boolean(clean(openId)),
      hasBaseId: Boolean(clean(selection?.baseId)),
      hasTableId: Boolean(clean(selection?.tableId)),
    });
  }
  const payload = await response.json().catch(() => null) as {
    ok?: boolean;
    token?: string;
    session_token?: string;
    user?: BitableSidebarLoginUser;
    error?: string;
  } | null;
  const sessionToken = clean(payload?.session_token || payload?.token);
  if (!response.ok || payload?.ok === false || !sessionToken || !payload?.user) {
    const responseError = clean(payload?.error);
    throw createLoginError('plugin_login_rejected', responseError || '侧边栏自动登录失败。', sdk, {
      hasOpenId: Boolean(clean(openId)),
      hasBaseId: Boolean(clean(selection?.baseId)),
      hasTableId: Boolean(clean(selection?.tableId)),
      responseStatus: response.status,
      responseError,
    });
  }

  return {
    sessionToken,
    user: payload.user,
  };
}
