import axios from 'axios';
import express from 'express';
import {
  getSessionByToken,
  getUserByOpenId,
  updateSessionTokens,
  deleteSessionByToken,
} from './storage';
import type { AuthSessionRow, UserRow } from './storage';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AuthContext = {
  openId: string;
  accessToken: string;
};

export type AuthProfile = {
  openId: string;
  name: string;
  enName: string | null;
  email: string | null;
  avatarUrl: string | null;
};

export type FeishuOAuthAppKey = 'fbif' | 'fude';

export type FeishuAppCredentials = {
  appKey: FeishuOAuthAppKey;
  appId: string;
  appSecret: string;
};

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'larkdocvar_session';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const UNAUTHORIZED_MESSAGE = '未登录或会话已过期，请重新登录。';
export const UNAUTHORIZED_TENANT_MESSAGE = '您的飞书账号不在 FBIF 授权范围内，请用 FBIF 账号登录或联系管理员。';

/**
 * Verify a Feishu tenant_key against FEISHU_ALLOWED_TENANT_KEYS allowlist.
 * Empty/unset env var is allowed only outside production.
 */
export function isAllowedTenant(tenantKey: string | undefined | null): boolean {
  const allowed = (process.env.FEISHU_ALLOWED_TENANT_KEYS || '').trim();
  if (!allowed) return process.env.NODE_ENV !== 'production';
  if (!tenantKey) return false;
  const list = allowed.split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(tenantKey);
}

export function normalizeFeishuOAuthAppKey(value: unknown): FeishuOAuthAppKey | null {
  if (value === 'fbif' || value === 'fude') {
    return value;
  }
  return null;
}

export function getFeishuAppCredentials(appKeyInput: unknown = 'fbif'): FeishuAppCredentials {
  const appKey = normalizeFeishuOAuthAppKey(appKeyInput) ?? 'fbif';
  const prefix = appKey === 'fude' ? 'FEISHU_FUDE' : 'FEISHU_FBIF';
  return {
    appKey,
    appId: process.env[`${prefix}_APP_ID`] || (appKey === 'fbif' ? process.env.FEISHU_APP_ID || '' : ''),
    appSecret:
      process.env[`${prefix}_APP_SECRET`] ||
      (appKey === 'fbif' ? process.env.FEISHU_APP_SECRET || '' : ''),
  };
}

export interface FeishuUserInfo {
  open_id: string;
  union_id?: string;
  name: string;
  en_name?: string;
  avatar_url?: string;
  email?: string;
}

export async function getUserInfoByOpenId(openId: string): Promise<FeishuUserInfo | null> {
  const { appId, appSecret } = getFeishuAppCredentials('fbif');
  if (!appId || !appSecret) return null;

  try {
    // Get tenant access token
    const tokenRes = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: appId,
      app_secret: appSecret,
    });
    const tenantToken = tokenRes.data.tenant_access_token;
    if (!tenantToken) return null;

    // Get user info
    const userRes = await axios.get(`https://open.feishu.cn/open-apis/contact/v3/users/${openId}`, {
      headers: { Authorization: `Bearer ${tenantToken}` },
      params: { user_id_type: 'open_id' },
    });
    if (userRes.data.code !== 0) return null;
    const u = userRes.data.data?.user;
    if (!u) return null;

    return {
      open_id: u.open_id,
      union_id: u.union_id,
      name: u.name,
      en_name: u.en_name,
      avatar_url: u.avatar?.avatar_origin || u.avatar?.avatar_72,
      email: u.email,
    };
  } catch {
    return null;
  }
}

const sessionRefreshInflight = new Map<string, Promise<AuthSessionRow>>();

// ---------------------------------------------------------------------------
// Cookie / header parsing
// ---------------------------------------------------------------------------

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function parseBearerToken(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

export function resolveSessionTokenCandidatesFromRequest(request: express.Request): string[] {
  const candidates: string[] = [];
  const addCandidate = (token: string): void => {
    const trimmed = token.trim();
    if (trimmed && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  const cookies = parseCookies(request.headers.cookie);
  const cookieToken = (cookies[SESSION_COOKIE_NAME] || '').trim();
  addCandidate(cookieToken);

  const headerToken = (request.header('X-Session-Token') || '').trim();
  addCandidate(headerToken);

  const bearerToken = parseBearerToken(request.headers.authorization);
  addCandidate(bearerToken);

  return candidates;
}

export function resolveSessionTokenFromRequest(request: express.Request): string {
  return resolveSessionTokenCandidatesFromRequest(request)[0] || '';
}

// ---------------------------------------------------------------------------
// OAuth state cookie helpers (CSRF protection for authorize -> callback flow)
// ---------------------------------------------------------------------------

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_COOKIE_PATH = '/';

function getCookieSecure(): boolean {
  return (process.env.SESSION_COOKIE_SECURE || 'false').toLowerCase() === 'true';
}

function normalizeSameSite(value: string | undefined, secure: boolean): 'lax' | 'strict' | 'none' {
  const raw = (value || '').toLowerCase();
  const sameSite = raw === 'strict' || raw === 'none' ? raw : 'lax';
  return sameSite === 'none' && !secure ? 'lax' : sameSite;
}

export function getOAuthStateCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge: number;
} {
  const secure = getCookieSecure();
  const sameSite = normalizeSameSite(
    process.env.OAUTH_STATE_COOKIE_SAMESITE ||
      (secure ? 'none' : 'lax'),
    secure,
  );
  return {
    httpOnly: true,
    secure,
    sameSite,
    path: OAUTH_STATE_COOKIE_PATH,
    maxAge: OAUTH_STATE_TTL_MS,
  };
}

export function setOAuthStateCookie(
  response: express.Response,
  name: string,
  value: string,
): void {
  response.cookie(name, value, getOAuthStateCookieOptions());
}

/**
 * Verifies the state cookie matches `expected` and clears it. Returns true on
 * match. Always clears the cookie (single-use).
 */
export function consumeOAuthStateCookie(
  request: express.Request,
  response: express.Response,
  name: string,
  expected: string | undefined,
): boolean {
  const cookies = parseCookies(request.headers.cookie);
  const stored = (cookies[name] || '').trim();
  const { maxAge: _maxAge, ...clearOptions } = getOAuthStateCookieOptions();
  response.clearCookie(name, clearOptions);
  if (!stored || !expected) return false;
  return stored === expected;
}

// ---------------------------------------------------------------------------
// Feishu v1 OAuth helpers (used by the QR-code login flow)
//   passport.feishu.cn issues codes that must be exchanged via the v1 endpoint
//   with an app_access_token. The v2 endpoint does NOT accept passport codes.
// ---------------------------------------------------------------------------

export async function getAppAccessToken(appId?: string, appSecret?: string): Promise<string> {
  const fallback = getFeishuAppCredentials('fbif');
  const resolvedAppId = appId || fallback.appId;
  const resolvedAppSecret = appSecret || fallback.appSecret;
  if (!resolvedAppId || !resolvedAppSecret) {
    throw new Error('服务未配置 FEISHU_APP_ID / FEISHU_APP_SECRET。');
  }

  const resp = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
    { app_id: resolvedAppId, app_secret: resolvedAppSecret },
    { headers: { 'Content-Type': 'application/json' }, timeout: 20000 },
  );
  const body = resp.data as { code?: number; msg?: string; app_access_token?: string };
  if (typeof body.code === 'number' && body.code !== 0) {
    throw new Error(`获取 app_access_token 失败：[code=${body.code}] ${body.msg || ''}`);
  }
  if (!body.app_access_token) {
    throw new Error('app_access_token 接口未返回 token。');
  }
  return body.app_access_token;
}

export type OAuthV1TokenResult = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  tokenType: string;
};

export async function exchangeCodeV1(
  code: string,
  appAccessToken: string,
): Promise<OAuthV1TokenResult> {
  const resp = await axios.post(
    'https://open.feishu.cn/open-apis/authen/v1/access_token',
    { grant_type: 'authorization_code', code },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${appAccessToken}`,
      },
      timeout: 20000,
    },
  );
  const body = resp.data as Record<string, unknown>;
  if (typeof body.code === 'number' && body.code !== 0) {
    throw new Error(`v1 access_token 接口失败：[code=${body.code}] ${body.msg || ''}`);
  }
  const data = (body.data && typeof body.data === 'object'
    ? body.data
    : body) as Record<string, unknown>;
  const accessToken = data.access_token as string | undefined;
  if (!accessToken) {
    throw new Error('v1 access_token 接口未返回 access_token。');
  }
  return {
    accessToken,
    refreshToken: (data.refresh_token as string | undefined) ?? '',
    expiresIn: Number(data.expires_in) || 0,
    refreshExpiresIn:
      Number(data.refresh_expires_in ?? data.refresh_token_expires_in) || 0,
    tokenType: (data.token_type as string | undefined) ?? 'Bearer',
  };
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

function parseEpochMs(timestamp: string): number {
  if (!timestamp) return 0;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

export function extractOAuthTokenData(body: Record<string, unknown>): Record<string, unknown> {
  const payload = body.data;
  if (payload && typeof payload === 'object') {
    return payload as Record<string, unknown>;
  }
  return body;
}

async function refreshUserAccessToken(session: AuthSessionRow): Promise<AuthSessionRow> {
  const { appId, appSecret } = getFeishuAppCredentials(session.oauth_app_key);
  if (!session.refresh_token) {
    throw new Error('refresh_token 不存在，请重新登录。');
  }
  if (!appId || !appSecret) {
    throw new Error('服务未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，无法刷新 token。');
  }

  const refreshExpiresAt = parseEpochMs(session.refresh_expires_at);
  if (refreshExpiresAt > 0 && refreshExpiresAt <= Date.now()) {
    throw new Error('refresh_token 已过期，请重新登录。');
  }

  const response = await axios.post(
    'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    {
      grant_type: 'refresh_token',
      client_id: appId,
      client_secret: appSecret,
      refresh_token: session.refresh_token,
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000,
    },
  );

  const body = response.data as Record<string, unknown>;
  if (typeof body.code === 'number' && body.code !== 0) {
    throw new Error(`刷新 token 失败：[code=${body.code}] ${body.msg || '未知错误'}，请重新登录。`);
  }

  const tokenData = extractOAuthTokenData(body);
  const newAccessToken = tokenData.access_token as string | undefined;
  if (!newAccessToken) {
    throw new Error('刷新 token 返回无效：缺少 access_token，请重新登录。');
  }

  const now = Date.now();
  const expiresIn = Number(tokenData.expires_in) || 7200;
  const refreshExpiresIn = Number(tokenData.refresh_expires_in ?? tokenData.refresh_token_expires_in) || 0;

  const updated = await updateSessionTokens({
    token: session.token,
    accessToken: newAccessToken,
    refreshToken: (tokenData.refresh_token as string) || session.refresh_token,
    expiresAt: new Date(now + expiresIn * 1000).toISOString(),
    refreshExpiresAt: refreshExpiresIn > 0 ? new Date(now + refreshExpiresIn * 1000).toISOString() : session.refresh_expires_at,
  });
  if (!updated) {
    throw new Error('会话不存在或已失效，请重新登录。');
  }

  return updated;
}

function refreshSessionWithLock(session: AuthSessionRow): Promise<AuthSessionRow> {
  const existing = sessionRefreshInflight.get(session.token);
  if (existing) return existing;

  const task = refreshUserAccessToken(session).finally(() => {
    sessionRefreshInflight.delete(session.token);
  });
  sessionRefreshInflight.set(session.token, task);
  return task;
}

async function ensureValidAccessToken(session: AuthSessionRow): Promise<AuthSessionRow> {
  const expiresAt = parseEpochMs(session.expires_at);
  if (expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return session;
  }
  return refreshSessionWithLock(session);
}

// ---------------------------------------------------------------------------
// Internal: resolve session + user atomically with cascading cleanup
// ---------------------------------------------------------------------------

async function resolveSession(
  request: express.Request,
): Promise<{ session: AuthSessionRow; user: UserRow } | null> {
  const sessionTokens = resolveSessionTokenCandidatesFromRequest(request);
  if (!sessionTokens.length) return null;

  for (const sessionToken of sessionTokens) {
    const rawSession = await getSessionByToken(sessionToken);
    if (!rawSession) continue;

    let session: AuthSessionRow;
    try {
      // Skip token refresh for plugin-login sessions (access_token is empty)
      if (!rawSession.access_token) {
        session = rawSession;
      } else {
        session = await ensureValidAccessToken(rawSession);
      }
    } catch {
      // 只在 refresh_token 确实过期时删除 session。
      // 网络瞬时失败或飞书 API 临时错误不应删除，让下一次请求重试刷新。
      const refreshExpiresAt = parseEpochMs(rawSession.refresh_expires_at);
      if (refreshExpiresAt > 0 && refreshExpiresAt <= Date.now()) {
        await deleteSessionByToken(rawSession.token).catch(() => undefined);
      }
      continue;
    }

    const user = await getUserByOpenId(session.open_id);
    if (!user) {
      await deleteSessionByToken(session.token).catch(() => undefined);
      continue;
    }

    return { session, user };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Business handlers: returns AuthContext or sends 401 + standard message.
 * Callers should `if (!ctx) return;` to short-circuit when 401 has been written.
 */
export async function requireAuth(
  request: express.Request,
  response: express.Response,
): Promise<AuthContext | null> {
  const auth = await resolveSession(request);
  if (!auth) {
    response.status(401).json({ ok: false, error: UNAUTHORIZED_MESSAGE });
    return null;
  }
  return {
    openId: auth.user.open_id,
    accessToken: auth.session.access_token,
  };
}

/**
 * Used by `/api/auth/session` to expose login state without sending 401.
 * Returns the user profile + the (possibly refreshed) session token so the
 * caller can re-issue the cookie.
 */
export async function peekSessionForRequest(
  request: express.Request,
): Promise<{ profile: AuthProfile; sessionToken: string } | null> {
  const auth = await resolveSession(request);
  if (!auth) return null;
  return {
    sessionToken: auth.session.token,
    profile: {
      openId: auth.user.open_id,
      name: auth.user.name,
      enName: auth.user.en_name,
      email: auth.user.email,
      avatarUrl: auth.user.avatar_url,
    },
  };
}
