import type express from 'express';
import crypto from 'node:crypto';
import {
  BITABLE_SIDEBAR_TOKEN_TYPE,
  getUserInfoByOpenId,
  normalizeFeishuOAuthAppKey,
} from '../auth';
import type { FeishuOAuthAppKey, FeishuUserInfo } from '../auth';
import { upsertSession, upsertUser } from '../storage';
import { sendInternalError } from './routeErrors';

interface PluginLoginRouteOptions {
  cookieName: string;
  cookieSecure: boolean;
  cookieSameSite: express.CookieOptions['sameSite'];
  maxAgeSeconds: number;
  requireBitableSidebarAuth: express.RequestHandler;
}

function normalizeOpenId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hashBitableIdentity(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function readHeader(request: express.Request, name: string): string {
  const value = request.headers[name.toLowerCase()];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

export function buildBitableSidebarFallbackUser(input: {
  sdkUserId: string;
  baseUserId?: string;
  tenantKey?: string;
  baseId?: string;
}): FeishuUserInfo | null {
  const sdkUserId = normalizeOpenId(input.sdkUserId);
  if (!sdkUserId) return null;

  const stableUserId = normalizeOpenId(input.baseUserId) || sdkUserId;
  const stableScope = normalizeOpenId(input.tenantKey) || normalizeOpenId(input.baseId) || 'unknown';
  const syntheticOpenId = `bitable:${hashBitableIdentity(`${stableScope}:${stableUserId}`)}`;
  return {
    open_id: syntheticOpenId,
    name: '飞书侧边栏用户',
  };
}

async function findUserInfo(openId: string, preferredAppKey: FeishuOAuthAppKey | null): Promise<{
  appKey: FeishuOAuthAppKey;
  userInfo: FeishuUserInfo;
} | null> {
  const appKeys: FeishuOAuthAppKey[] = preferredAppKey
    ? [preferredAppKey, preferredAppKey === 'fbif' ? 'fude' : 'fbif']
    : ['fbif', 'fude'];
  for (const appKey of appKeys) {
    const userInfo = await getUserInfoByOpenId(openId, appKey);
    if (userInfo) {
      return { appKey, userInfo };
    }
  }
  return null;
}

export function registerPluginLoginRoutes(app: express.Express, options: PluginLoginRouteOptions): void {
  app.post('/api/auth/plugin-login', options.requireBitableSidebarAuth, async (request, response) => {
    try {
      const openId = normalizeOpenId(request.body?.open_id);
      if (!openId) {
        response.status(400).json({ ok: false, error: 'open_id required' });
        return;
      }

      const preferredAppKey = normalizeFeishuOAuthAppKey(request.body?.app_key);
      const found = await findUserInfo(openId, preferredAppKey);
      const appKey = found?.appKey ?? preferredAppKey ?? 'fbif';
      const userInfo = found?.userInfo ?? buildBitableSidebarFallbackUser({
        sdkUserId: openId,
        baseUserId: readHeader(request, 'x-bitable-base-user-id'),
        tenantKey: readHeader(request, 'x-bitable-tenant-key'),
        baseId: readHeader(request, 'x-bitable-base-id'),
      });
      if (!userInfo) {
        response.status(403).json({ ok: false, error: 'bitable_user_unavailable' });
        return;
      }

      const user = await upsertUser({
        openId: userInfo.open_id,
        name: userInfo.name,
        enName: userInfo.en_name,
        avatarUrl: userInfo.avatar_url,
        email: userInfo.email,
      });

      const sessionToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + options.maxAgeSeconds * 1000).toISOString();
      await upsertSession({
        token: sessionToken,
        oauthAppKey: appKey,
        openId: user.open_id,
        accessToken: 'bitable-sidebar',
        refreshToken: '',
        tokenType: BITABLE_SIDEBAR_TOKEN_TYPE,
        expiresAt,
      });

      response.cookie(options.cookieName, sessionToken, {
        httpOnly: true,
        secure: options.cookieSecure,
        sameSite: options.cookieSameSite,
        maxAge: options.maxAgeSeconds * 1000,
        path: '/',
      });

      response.set('Cache-Control', 'no-store').json({
        ok: true,
        token: sessionToken,
        session_token: sessionToken,
        user: {
          open_id: user.open_id,
          name: user.name,
          en_name: user.en_name,
          email: user.email,
          avatar_url: user.avatar_url,
        },
      });
    } catch (error) {
      sendInternalError(response, 'plugin-login', error);
    }
  });
}
