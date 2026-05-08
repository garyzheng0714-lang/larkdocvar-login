import axios from 'axios';
import crypto from 'node:crypto';
import express from 'express';

import {
  setOAuthStateCookie,
  consumeOAuthStateCookie,
  getAppAccessToken,
  exchangeCodeV1,
  isAllowedTenant,
  UNAUTHORIZED_TENANT_MESSAGE,
} from './auth';
import { upsertUser, upsertSession } from './storage';

// ---------------------------------------------------------------------------
// Env-derived configuration. All env reads happen at module-load (after
// dotenv.config() in index.ts) so handlers see stable values.
// ---------------------------------------------------------------------------

const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const REDIRECT_URI = process.env.FEISHU_OAUTH_REDIRECT_URI || '';
const SCOPE = process.env.FEISHU_OAUTH_SCOPE || 'contact:user.base:readonly';
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'larkdocvar_session';
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === 'true';
const SESSION_MAX_AGE_SECONDS = Number(process.env.SESSION_MAX_AGE_SECONDS || 604800);
const SESSION_COOKIE_SAMESITE_RAW = (
  process.env.SESSION_COOKIE_SAMESITE || (SESSION_COOKIE_SECURE ? 'none' : 'lax')
).toLowerCase();
const SESSION_COOKIE_SAMESITE: 'lax' | 'strict' | 'none' =
  SESSION_COOKIE_SAMESITE_RAW === 'strict' || SESSION_COOKIE_SAMESITE_RAW === 'none'
    ? (SESSION_COOKIE_SAMESITE_RAW as 'strict' | 'none')
    : 'lax';
const FRONTEND_POST_LOGIN_URL = process.env.FRONTEND_POST_LOGIN_URL || '/';
const EMBEDDED_AUTH_HASH_PARAM =
  process.env.EMBEDDED_AUTH_HASH_PARAM || 'session_token';

const OAUTH_BUTTON_STATE_COOKIE = 'feishu_oauth_state';
const OAUTH_QR_STATE_COOKIE = 'feishu_qr_state';
const QR_REDIRECT_URI = REDIRECT_URI.replace(/\/callback$/, '/qr-callback');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendHashParamToUrl(baseUrl: string, key: string, value: string): string {
  const hashIndex = baseUrl.indexOf('#');
  const beforeHash = hashIndex >= 0 ? baseUrl.slice(0, hashIndex) : baseUrl;
  const rawHash = hashIndex >= 0 ? baseUrl.slice(hashIndex + 1) : '';
  const hashParams = new URLSearchParams(rawHash);
  hashParams.set(key, value);
  const nextHash = hashParams.toString();
  return nextHash ? `${beforeHash}#${nextHash}` : beforeHash;
}

function extractOAuthTokenData(body: Record<string, unknown>): Record<string, unknown> {
  const payload = body.data;
  if (payload && typeof payload === 'object') {
    return payload as Record<string, unknown>;
  }
  return body;
}

type FeishuOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  refreshExpiresIn: number;
};

/**
 * Common login finalization shared by button-mode v2 callback and QR-mode v1
 * qr-callback. Given OAuth tokens, fetches user_info, enforces tenant
 * allowlist, persists user + session, sets session cookie, and redirects to
 * the frontend. Writes 5xx/403 directly on failure.
 */
async function finalizeFeishuLogin(
  response: express.Response,
  tokens: FeishuOAuthTokens,
): Promise<void> {
  const userInfoResponse = await axios.get(
    'https://open.feishu.cn/open-apis/authen/v1/user_info',
    { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
  );

  const userInfoBody = userInfoResponse.data as Record<string, unknown>;
  if (typeof userInfoBody.code === 'number' && userInfoBody.code !== 0) {
    const errMsg = String(userInfoBody.msg || 'user_info request failed');
    response.status(500).json({
      ok: false,
      error: `飞书获取用户信息失败：[code=${userInfoBody.code}] ${errMsg}`,
    });
    return;
  }

  const userInfo = (userInfoBody.data && typeof userInfoBody.data === 'object'
    ? userInfoBody.data
    : userInfoBody) as {
    open_id?: string;
    name?: string;
    en_name?: string;
    email?: string;
    avatar_url?: string;
    tenant_key?: string;
  };

  if (!userInfo.open_id) {
    response.status(500).json({
      ok: false,
      error: '飞书获取用户信息返回无效：缺少 open_id。',
    });
    return;
  }

  if (!isAllowedTenant(userInfo.tenant_key)) {
    // eslint-disable-next-line no-console
    console.log(
      `[auth] login denied for tenant_key=${userInfo.tenant_key} open_id=${userInfo.open_id}`,
    );
    response.status(403).send(UNAUTHORIZED_TENANT_MESSAGE);
    return;
  }

  await upsertUser({
    openId: userInfo.open_id,
    name: userInfo.name ?? '',
    enName: userInfo.en_name ?? null,
    email: userInfo.email ?? null,
    avatarUrl: userInfo.avatar_url ?? null,
  });

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = tokens.expiresIn > 0
    ? new Date(now + tokens.expiresIn * 1000).toISOString()
    : new Date(now + 7200 * 1000).toISOString();
  const refreshExpiresAt = tokens.refreshExpiresIn > 0
    ? new Date(now + tokens.refreshExpiresIn * 1000).toISOString()
    : '';

  await upsertSession({
    token: sessionToken,
    openId: userInfo.open_id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    expiresAt,
    refreshExpiresAt,
  });

  response.cookie(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: SESSION_COOKIE_SECURE,
    sameSite: SESSION_COOKIE_SAMESITE,
    maxAge: SESSION_MAX_AGE_SECONDS * 1000,
    path: '/',
  });

  response.redirect(
    appendHashParamToUrl(FRONTEND_POST_LOGIN_URL, EMBEDDED_AUTH_HASH_PARAM, sessionToken),
  );
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerOAuthRoutes(app: express.Express): void {
  // -------- Button mode: v2 OAuth (open.feishu.cn authorize + v2 token) --------

  app.get('/api/auth/feishu/login', (_request, response) => {
    if (!APP_ID || !REDIRECT_URI) {
      response.status(500).json({
        ok: false,
        error: '服务未配置 FEISHU_APP_ID 或 FEISHU_OAUTH_REDIRECT_URI。',
      });
      return;
    }
    const state = crypto.randomBytes(24).toString('hex');
    setOAuthStateCookie(response, OAUTH_BUTTON_STATE_COOKIE, state);

    const params = new URLSearchParams({
      app_id: APP_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPE,
      state,
    });
    const authorizeUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?${params.toString()}`;
    response.redirect(authorizeUrl);
  });

  app.get('/api/auth/feishu/callback', async (request, response) => {
    try {
      const code = request.query.code as string | undefined;
      const state = typeof request.query.state === 'string' ? request.query.state : '';
      if (!code) {
        response.status(400).json({ ok: false, error: '缺少 code 参数。' });
        return;
      }
      if (!consumeOAuthStateCookie(request, response, OAUTH_BUTTON_STATE_COOKIE, state)) {
        response.status(403).send('登录安全校验失败（state mismatch），请重新登录。');
        return;
      }
      if (!APP_ID || !APP_SECRET || !REDIRECT_URI) {
        response.status(500).json({
          ok: false,
          error: '服务未配置 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_OAUTH_REDIRECT_URI。',
        });
        return;
      }

      const tokenResponse = await axios.post(
        'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
        {
          grant_type: 'authorization_code',
          client_id: APP_ID,
          client_secret: APP_SECRET,
          code,
          redirect_uri: REDIRECT_URI,
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

      const tokenBody = tokenResponse.data as Record<string, unknown>;
      if (typeof tokenBody.code === 'number' && tokenBody.code !== 0) {
        const errMsg = String(tokenBody.msg || tokenBody.message || 'token exchange failed');
        response.status(500).json({
          ok: false,
          error: `飞书 OAuth token 交换失败：[code=${tokenBody.code}] ${errMsg}`,
        });
        return;
      }

      const tokenData = extractOAuthTokenData(tokenBody);
      const oauthAccessToken = tokenData.access_token as string | undefined;
      if (!oauthAccessToken) {
        response.status(500).json({
          ok: false,
          error: '飞书 OAuth token 交换返回无效：缺少 access_token。',
        });
        return;
      }

      await finalizeFeishuLogin(response, {
        accessToken: oauthAccessToken,
        refreshToken: (tokenData.refresh_token as string | undefined) ?? '',
        tokenType: (tokenData.token_type as string | undefined) ?? 'Bearer',
        expiresIn: Number(tokenData.expires_in) || 0,
        refreshExpiresIn:
          Number(tokenData.refresh_expires_in ?? tokenData.refresh_token_expires_in) || 0,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Feishu OAuth callback error:', error);
      response.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // -------- QR mode: v1 OAuth (passport.feishu.cn + app_access_token + v1 token) --------

  app.get('/api/auth/feishu/qr-config', (_request, response) => {
    if (!APP_ID || !REDIRECT_URI) {
      response.status(500).json({
        ok: false,
        error: '服务未配置 FEISHU_APP_ID 或 FEISHU_OAUTH_REDIRECT_URI。',
      });
      return;
    }
    const state = crypto.randomBytes(24).toString('hex');
    setOAuthStateCookie(response, OAUTH_QR_STATE_COOKIE, state);

    const params = new URLSearchParams({
      client_id: APP_ID,
      redirect_uri: QR_REDIRECT_URI,
      response_type: 'code',
      state,
    });

    response.set('Cache-Control', 'no-store').json({
      ok: true,
      goto: `https://passport.feishu.cn/suite/passport/oauth/authorize?${params.toString()}`,
      state,
      expires_in: 300,
    });
  });

  app.get('/api/auth/feishu/qr-callback', async (request, response) => {
    try {
      const code = request.query.code as string | undefined;
      const state = typeof request.query.state === 'string' ? request.query.state : '';
      if (!code) {
        response.status(400).json({ ok: false, error: '缺少 code 参数。' });
        return;
      }
      if (!consumeOAuthStateCookie(request, response, OAUTH_QR_STATE_COOKIE, state)) {
        response.status(403).send('登录安全校验失败（state mismatch），请重新登录。');
        return;
      }
      if (!APP_ID || !APP_SECRET) {
        response.status(500).json({
          ok: false,
          error: '服务未配置 FEISHU_APP_ID / FEISHU_APP_SECRET。',
        });
        return;
      }

      const appAccessToken = await getAppAccessToken();
      const tokens = await exchangeCodeV1(code, appAccessToken);
      await finalizeFeishuLogin(response, tokens);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Feishu QR callback error:', error);
      response.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
