import axios from 'axios';
import crypto from 'node:crypto';
import express from 'express';

import {
  setOAuthStateCookie,
  consumeOAuthStateCookie,
  getAppAccessToken,
  exchangeCodeV1,
  getFeishuAppCredentials,
  normalizeFeishuOAuthAppKey,
  isAllowedTenant,
  UNAUTHORIZED_TENANT_MESSAGE,
} from './auth';
import type { FeishuOAuthAppKey } from './auth';
import { upsertUser, upsertSession } from './storage';

// ---------------------------------------------------------------------------
// Env-derived configuration. All env reads happen at module-load (after
// dotenv.config() in index.ts) so handlers see stable values.
// ---------------------------------------------------------------------------

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

const OAUTH_BUTTON_STATE_COOKIE_PREFIX = 'feishu_oauth_state';
const OAUTH_QR_STATE_COOKIE_PREFIX = 'feishu_qr_state';
const PUBLIC_CALLBACK_PATH = '/auth/feishu';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractOAuthTokenData(body: Record<string, unknown>): Record<string, unknown> {
  const payload = body.data;
  if (payload && typeof payload === 'object') {
    return payload as Record<string, unknown>;
  }
  return body;
}

function safeOAuthErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as { code?: unknown; msg?: unknown; message?: unknown } | undefined;
    const code = body?.code !== undefined ? `[code=${String(body.code)}] ` : '';
    const msg = String(body?.msg || body?.message || error.message || 'request failed');
    const status = error.response?.status ? `HTTP ${error.response.status} ` : '';
    return `${status}${code}${msg}`.trim();
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

type FeishuOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  refreshExpiresIn: number;
};

type OAuthCallbackKind = 'button' | 'qr';

type OAuthAppConfig = {
  appKey: FeishuOAuthAppKey;
  appId: string;
  appSecret: string;
  redirectUri: string;
  qrRedirectUri: string;
  scope: string;
};

function appEnvPrefix(appKey: FeishuOAuthAppKey): 'FEISHU_FBIF' | 'FEISHU_FUDE' {
  return appKey === 'fude' ? 'FEISHU_FUDE' : 'FEISHU_FBIF';
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function originFromUrl(value: string): string {
  try {
    if (!value.startsWith('http://') && !value.startsWith('https://')) return '';
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function inferPublicCallbackBaseUrl(): string {
  const explicit =
    process.env.FEISHU_REDIRECT_BASE ||
    process.env.APP_PUBLIC_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    '';
  if (explicit.trim()) {
    return trimTrailingSlash(explicit.trim());
  }

  return (
    originFromUrl(FRONTEND_POST_LOGIN_URL) ||
    originFromUrl(process.env.FEISHU_OAUTH_REDIRECT_URI || '')
  );
}

export function buildFeishuOAuthRedirectUri(
  appKey: FeishuOAuthAppKey,
  kind: OAuthCallbackKind,
): string {
  const prefix = appEnvPrefix(appKey);
  const direct = kind === 'button'
    ? process.env[`${prefix}_OAUTH_REDIRECT_URI`]
    : process.env[`${prefix}_QR_REDIRECT_URI`] || process.env[`${prefix}_QR_OAUTH_REDIRECT_URI`];
  if (direct?.trim()) {
    return direct.trim();
  }

  const publicBase = inferPublicCallbackBaseUrl();
  if (publicBase) {
    const callbackPath = kind === 'button' ? 'callback' : 'qr-callback';
    return `${publicBase}${PUBLIC_CALLBACK_PATH}/${appKey}/${callbackPath}`;
  }

  const legacyRedirectUri = process.env.FEISHU_OAUTH_REDIRECT_URI || '';
  if (appKey === 'fbif' && legacyRedirectUri) {
    return kind === 'button'
      ? legacyRedirectUri
      : legacyRedirectUri.replace(/\/callback$/, '/qr-callback');
  }

  return '';
}

function getAppScope(appKey: FeishuOAuthAppKey): string {
  return process.env[`${appEnvPrefix(appKey)}_OAUTH_SCOPE`] || SCOPE;
}

function getOAuthAppConfig(appKey: FeishuOAuthAppKey): OAuthAppConfig {
  const credentials = getFeishuAppCredentials(appKey);
  return {
    ...credentials,
    redirectUri: buildFeishuOAuthRedirectUri(appKey, 'button'),
    qrRedirectUri: buildFeishuOAuthRedirectUri(appKey, 'qr'),
    scope: getAppScope(appKey),
  };
}

function stateCookieName(prefix: string, appKey: FeishuOAuthAppKey): string {
  return `${prefix}_${appKey}`;
}

function resolveRouteAppKey(
  request: express.Request,
  response: express.Response,
): FeishuOAuthAppKey | null {
  const appKey = normalizeFeishuOAuthAppKey(request.params.appKey || 'fbif');
  if (!appKey) {
    response.status(404).json({ ok: false, error: '未知的飞书登录入口。' });
    return null;
  }
  return appKey;
}

function sendMissingOAuthConfig(
  response: express.Response,
  appKey: FeishuOAuthAppKey,
  missing: string,
): void {
  response.status(500).json({
    ok: false,
    error: `${appKey === 'fude' ? '富的' : 'FBIF'}飞书登录配置不完整：缺少 ${missing}。`,
  });
}

/**
 * Common login finalization shared by button-mode v2 callback and QR-mode v1
 * qr-callback. Given OAuth tokens, fetches user_info, enforces tenant
 * allowlist, persists user + session, sets session cookie, and redirects to
 * the frontend. Writes 5xx/403 directly on failure.
 */
async function finalizeFeishuLogin(
  response: express.Response,
  tokens: FeishuOAuthTokens,
  appKey: FeishuOAuthAppKey,
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
    oauthAppKey: appKey,
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

  response.redirect(FRONTEND_POST_LOGIN_URL);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerOAuthRoutes(app: express.Express): void {
  // -------- Button mode: v2 OAuth (open.feishu.cn authorize + v2 token) --------

  function startButtonLogin(appKey: FeishuOAuthAppKey, response: express.Response): void {
    const config = getOAuthAppConfig(appKey);
    if (!config.appId || !config.redirectUri) {
      sendMissingOAuthConfig(
        response,
        appKey,
        !config.appId ? `${appEnvPrefix(appKey)}_APP_ID` : 'OAuth callback URL',
      );
      return;
    }
    const state = crypto.randomBytes(24).toString('hex');
    setOAuthStateCookie(response, stateCookieName(OAUTH_BUTTON_STATE_COOKIE_PREFIX, appKey), state);

    const params = new URLSearchParams({
      app_id: config.appId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: config.scope,
      state,
    });
    const authorizeUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?${params.toString()}`;
    response.redirect(authorizeUrl);
  }

  async function handleButtonCallback(
    appKey: FeishuOAuthAppKey,
    request: express.Request,
    response: express.Response,
  ): Promise<void> {
    try {
      const config = getOAuthAppConfig(appKey);
      const code = request.query.code as string | undefined;
      const state = typeof request.query.state === 'string' ? request.query.state : '';
      if (!code) {
        response.status(400).json({ ok: false, error: '缺少 code 参数。' });
        return;
      }
      if (!consumeOAuthStateCookie(
        request,
        response,
        stateCookieName(OAUTH_BUTTON_STATE_COOKIE_PREFIX, appKey),
        state,
      )) {
        response.status(403).send('登录安全校验失败（state mismatch），请重新登录。');
        return;
      }
      if (!config.appId || !config.appSecret || !config.redirectUri) {
        sendMissingOAuthConfig(
          response,
          appKey,
          !config.appId
            ? `${appEnvPrefix(appKey)}_APP_ID`
            : !config.appSecret
              ? `${appEnvPrefix(appKey)}_APP_SECRET`
              : 'OAuth callback URL',
        );
        return;
      }

      const tokenResponse = await axios.post(
        'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
        {
          grant_type: 'authorization_code',
          client_id: config.appId,
          client_secret: config.appSecret,
          code,
          redirect_uri: config.redirectUri,
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
      }, appKey);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Feishu OAuth callback error:', safeOAuthErrorMessage(error));
      response.status(500).json({
        ok: false,
        error: '飞书登录失败，请稍后重试。',
      });
    }
  }

  app.get('/auth/feishu/:appKey/login', (request, response) => {
    const appKey = resolveRouteAppKey(request, response);
    if (!appKey) return;
    startButtonLogin(appKey, response);
  });

  app.get('/api/auth/feishu/login', (_request, response) => {
    startButtonLogin('fbif', response);
  });

  app.get('/auth/feishu/:appKey/callback', async (request, response) => {
    const appKey = resolveRouteAppKey(request, response);
    if (!appKey) return;
    await handleButtonCallback(appKey, request, response);
  });

  app.get('/api/auth/feishu/callback', async (request, response) => {
    await handleButtonCallback('fbif', request, response);
  });

  // -------- QR mode: v1 OAuth (passport.feishu.cn + app_access_token + v1 token) --------

  function sendQrConfig(appKey: FeishuOAuthAppKey, response: express.Response): void {
    const config = getOAuthAppConfig(appKey);
    if (!config.appId || !config.appSecret || !config.qrRedirectUri) {
      sendMissingOAuthConfig(
        response,
        appKey,
        !config.appId
          ? `${appEnvPrefix(appKey)}_APP_ID`
          : !config.appSecret
            ? `${appEnvPrefix(appKey)}_APP_SECRET`
            : 'QR callback URL',
      );
      return;
    }
    const state = crypto.randomBytes(24).toString('hex');
    setOAuthStateCookie(response, stateCookieName(OAUTH_QR_STATE_COOKIE_PREFIX, appKey), state);

    const params = new URLSearchParams({
      client_id: config.appId,
      redirect_uri: config.qrRedirectUri,
      response_type: 'code',
      state,
    });

    response.set('Cache-Control', 'no-store').json({
      ok: true,
      goto: `https://passport.feishu.cn/suite/passport/oauth/authorize?${params.toString()}`,
      state,
      expires_in: 300,
    });
  }

  async function handleQrCallback(
    appKey: FeishuOAuthAppKey,
    request: express.Request,
    response: express.Response,
  ): Promise<void> {
    try {
      const config = getOAuthAppConfig(appKey);
      const code = request.query.code as string | undefined;
      const state = typeof request.query.state === 'string' ? request.query.state : '';
      if (!code) {
        response.status(400).json({ ok: false, error: '缺少 code 参数。' });
        return;
      }
      if (!consumeOAuthStateCookie(
        request,
        response,
        stateCookieName(OAUTH_QR_STATE_COOKIE_PREFIX, appKey),
        state,
      )) {
        response.status(403).send('登录安全校验失败（state mismatch），请重新登录。');
        return;
      }
      if (!config.appId || !config.appSecret) {
        sendMissingOAuthConfig(
          response,
          appKey,
          !config.appId ? `${appEnvPrefix(appKey)}_APP_ID` : `${appEnvPrefix(appKey)}_APP_SECRET`,
        );
        return;
      }

      const appAccessToken = await getAppAccessToken(config.appId, config.appSecret);
      const tokens = await exchangeCodeV1(code, appAccessToken);
      await finalizeFeishuLogin(response, tokens, appKey);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Feishu QR callback error:', safeOAuthErrorMessage(error));
      response.status(500).json({
        ok: false,
        error: '飞书扫码登录失败，请稍后重试。',
      });
    }
  }

  app.get('/auth/feishu/:appKey/qr-config', (request, response) => {
    const appKey = resolveRouteAppKey(request, response);
    if (!appKey) return;
    sendQrConfig(appKey, response);
  });

  app.get('/api/auth/feishu/qr-config', (_request, response) => {
    sendQrConfig('fbif', response);
  });

  app.get('/auth/feishu/:appKey/qr-callback', async (request, response) => {
    const appKey = resolveRouteAppKey(request, response);
    if (!appKey) return;
    await handleQrCallback(appKey, request, response);
  });

  app.get('/api/auth/feishu/qr-callback', async (request, response) => {
    await handleQrCallback('fbif', request, response);
  });
}
