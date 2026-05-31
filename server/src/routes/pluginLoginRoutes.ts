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
      if (!found) {
        response.status(403).json({ ok: false, error: 'user_not_found_in_tenant' });
        return;
      }

      const user = await upsertUser({
        openId: found.userInfo.open_id,
        name: found.userInfo.name,
        enName: found.userInfo.en_name,
        avatarUrl: found.userInfo.avatar_url,
        email: found.userInfo.email,
      });

      const sessionToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + options.maxAgeSeconds * 1000).toISOString();
      await upsertSession({
        token: sessionToken,
        oauthAppKey: found.appKey,
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
