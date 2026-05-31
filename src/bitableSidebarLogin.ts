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

interface BitableSelection {
  baseId?: string | null;
  tableId?: string | null;
}

interface BitableSidebarSdk {
  bridge: {
    getUserId(): Promise<string>;
    getBaseUserId(): Promise<string>;
    getTenantKey(): Promise<string>;
  };
  base: {
    getSelection(): Promise<BitableSelection | null>;
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
    throw new Error('请在飞书多维表格侧边栏中打开插件后再操作。');
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

  const [openId, selection, baseUserId, tenantKey] = await withTimeout(Promise.all([
    sdk.bridge.getUserId(),
    sdk.base.getSelection().catch(() => null),
    sdk.bridge.getBaseUserId().catch(() => ''),
    sdk.bridge.getTenantKey().catch(() => ''),
  ]), timeoutMs, '侧边栏身份读取超时。');

  const request = buildBitablePluginLoginRequest({
    openId,
    selection,
    baseUserId,
    tenantKey,
  });

  const response = await fetchImpl('/api/auth/plugin-login', {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: request.headers,
    body: request.body,
  });
  const payload = await response.json().catch(() => null) as {
    ok?: boolean;
    token?: string;
    session_token?: string;
    user?: BitableSidebarLoginUser;
    error?: string;
  } | null;
  const sessionToken = clean(payload?.session_token || payload?.token);
  if (!response.ok || payload?.ok === false || !sessionToken || !payload?.user) {
    throw new Error(payload?.error || '侧边栏自动登录失败。');
  }

  return {
    sessionToken,
    user: payload.user,
  };
}
