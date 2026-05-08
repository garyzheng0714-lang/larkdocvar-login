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

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'larkdocvar_session';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const UNAUTHORIZED_MESSAGE = '未登录或会话已过期，请重新登录。';
export const UNAUTHORIZED_TENANT_MESSAGE = '您的飞书账号不在 FBIF 授权范围内，请用 FBIF 账号登录或联系管理员。';

/**
 * Verify a Feishu tenant_key against FEISHU_ALLOWED_TENANT_KEYS allowlist.
 * Empty/unset env var means no restriction (development-friendly).
 * In production, set this to FBIF + partner tenant_keys.
 */
export function isAllowedTenant(tenantKey: string | undefined | null): boolean {
  const allowed = (process.env.FEISHU_ALLOWED_TENANT_KEYS || '').trim();
  if (!allowed) return true;
  if (!tenantKey) return false;
  const list = allowed.split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(tenantKey);
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

export function resolveSessionTokenFromRequest(request: express.Request): string {
  const cookies = parseCookies(request.headers.cookie);
  const cookieToken = (cookies[SESSION_COOKIE_NAME] || '').trim();
  if (cookieToken) return cookieToken;

  const headerToken = (request.header('X-Session-Token') || '').trim();
  if (headerToken) return headerToken;

  const bearerToken = parseBearerToken(request.headers.authorization);
  if (bearerToken) return bearerToken;

  const queryToken = typeof request.query.session_token === 'string'
    ? request.query.session_token.trim()
    : '';
  return queryToken;
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

function parseEpochMs(timestamp: string): number {
  if (!timestamp) return 0;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

function extractOAuthTokenData(body: Record<string, unknown>): Record<string, unknown> {
  const payload = body.data;
  if (payload && typeof payload === 'object') {
    return payload as Record<string, unknown>;
  }
  return body;
}

async function refreshUserAccessToken(session: AuthSessionRow): Promise<AuthSessionRow> {
  const appId = process.env.FEISHU_APP_ID || '';
  const appSecret = process.env.FEISHU_APP_SECRET || '';
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
  const sessionToken = resolveSessionTokenFromRequest(request);
  if (!sessionToken) return null;

  const rawSession = await getSessionByToken(sessionToken);
  if (!rawSession) return null;

  let session: AuthSessionRow;
  try {
    session = await ensureValidAccessToken(rawSession);
  } catch {
    await deleteSessionByToken(rawSession.token).catch(() => undefined);
    return null;
  }

  const user = await getUserByOpenId(session.open_id);
  if (!user) {
    await deleteSessionByToken(session.token).catch(() => undefined);
    return null;
  }

  return { session, user };
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
