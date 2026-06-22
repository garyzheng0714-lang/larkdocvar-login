import express from 'express';
import axios from 'axios';
import crypto from 'node:crypto';
import {
  deleteSessionByToken,
  upsertSession,
  upsertUser,
} from '../storage';
import {
  consumeOAuthStateCookie,
  exchangeCodeV1,
  getAppAccessToken,
  getFeishuAppCredentials,
  isAllowedTenant,
  normalizeFeishuOAuthAppKey,
  peekSessionForRequest,
  resolveSessionTokenCandidatesFromRequest,
  setOAuthStateCookie,
  UNAUTHORIZED_TENANT_MESSAGE,
} from '../auth';
import type { FeishuOAuthAppKey, OAuthV1TokenResult } from '../auth';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'larkdocvar_session';
const AUTH_DISABLED_MESSAGE = '当前侧边栏不再使用 OAuth 登录入口，请直接在飞书多维表格侧边栏内操作。';
const CONFIG_LOGIN_ERROR = '登录服务配置不完整，请联系管理员。';
const GENERIC_LOGIN_ERROR = '飞书登录失败，请重新点击登录。';
const QR_STATE_COOKIE_PREFIX = 'feishu_qr_state';
const QR_STATE_TTL_SECONDS = 10 * 60;
const PUBLIC_CALLBACK_PATH = '/auth/feishu';

type FeishuUserInfoPayload = {
  open_id?: string;
  name?: string;
  en_name?: string;
  email?: string;
  avatar_url?: string;
  tenant_key?: string;
};

type OAuthStatePayload = {
  v: 1;
  appKey: FeishuOAuthAppKey;
  kind: 'qr';
  nonce: string;
  exp: number;
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
  if (explicit.trim()) return trimTrailingSlash(explicit.trim());

  return (
    originFromUrl(process.env.FRONTEND_POST_LOGIN_URL || '') ||
    originFromUrl(process.env.FEISHU_OAUTH_REDIRECT_URI || '')
  );
}

function buildQrRedirectUri(appKey: FeishuOAuthAppKey): string {
  const prefix = appEnvPrefix(appKey);
  const direct = process.env[`${prefix}_QR_REDIRECT_URI`] || process.env[`${prefix}_QR_OAUTH_REDIRECT_URI`];
  if (direct?.trim()) return direct.trim();

  const publicBase = inferPublicCallbackBaseUrl();
  if (publicBase) return `${publicBase}${PUBLIC_CALLBACK_PATH}/${appKey}/qr-callback`;

  const legacyRedirectUri = process.env.FEISHU_OAUTH_REDIRECT_URI || '';
  if (appKey === 'fbif' && legacyRedirectUri) {
    return legacyRedirectUri.replace(/\/callback$/, '/qr-callback');
  }
  return '';
}

function getSessionCookieOptions(): express.CookieOptions {
  const secure = (process.env.SESSION_COOKIE_SECURE || 'false').toLowerCase() === 'true';
  const rawSameSite = (process.env.SESSION_COOKIE_SAMESITE || (secure ? 'none' : 'lax')).toLowerCase();
  const sameSite = rawSameSite === 'strict' || rawSameSite === 'none' ? rawSameSite : 'lax';
  return {
    httpOnly: true,
    secure,
    sameSite: sameSite === 'none' && !secure ? 'lax' : sameSite,
    maxAge: Number(process.env.SESSION_MAX_AGE_SECONDS || 604800) * 1000,
    path: '/',
  };
}

function signStateBody(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

function createSignedQrState(appKey: FeishuOAuthAppKey, appSecret: string, appId: string): string {
  const payload: OAuthStatePayload = {
    v: 1,
    appKey,
    kind: 'qr',
    nonce: crypto.randomBytes(24).toString('base64url'),
    exp: Math.floor(Date.now() / 1000) + QR_STATE_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${signStateBody(body, process.env.OAUTH_STATE_SIGNING_SECRET || appSecret || appId)}`;
}

function verifySignedQrState(
  state: string,
  appKey: FeishuOAuthAppKey,
  appSecret: string,
  appId: string,
): boolean {
  if (!state) return false;
  const [body, signature] = state.split('.');
  if (!body || !signature) return false;

  const expected = signStateBody(body, process.env.OAUTH_STATE_SIGNING_SECRET || appSecret || appId);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return false;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<OAuthStatePayload>;
    return (
      payload.v === 1 &&
      payload.appKey === appKey &&
      payload.kind === 'qr' &&
      typeof payload.exp === 'number' &&
      payload.exp >= Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}

function resolveRouteAppKey(request: express.Request, response: express.Response): FeishuOAuthAppKey | null {
  const appKey = normalizeFeishuOAuthAppKey(request.params.appKey || 'fbif');
  if (!appKey) {
    response.status(404).json({ ok: false, error: '未知的飞书登录入口。' });
    return null;
  }
  return appKey;
}

function sendMissingAuthConfig(response: express.Response, appKey: FeishuOAuthAppKey, missing: string): void {
  // eslint-disable-next-line no-console
  console.error(`[auth] missing ${appKey} client auth config: ${missing}`);
  response.status(500).set('Cache-Control', 'no-store').json({ ok: false, error: CONFIG_LOGIN_ERROR });
}

function safeAuthErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as { code?: unknown; msg?: unknown; message?: unknown } | undefined;
    const code = body?.code !== undefined ? `[code=${String(body.code)}] ` : '';
    const msg = String(body?.msg || body?.message || error.message || 'request failed');
    const status = error.response?.status ? `HTTP ${error.response.status} ` : '';
    return `${status}${code}${msg}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function sanitizeDiagnosticValue(value: unknown): string | boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 240);
  if (value === null || value === undefined) return null;
  return String(value).slice(0, 240);
}

function redirectToFrontendWithAuthError(response: express.Response, message: string): void {
  const target = process.env.FRONTEND_POST_LOGIN_URL || '/';
  try {
    if (target.startsWith('http://') || target.startsWith('https://')) {
      const url = new URL(target);
      url.searchParams.set('auth_error', message);
      response.redirect(url.toString());
      return;
    }
  } catch {
    // Fall through to a safe relative redirect.
  }
  response.redirect(`/?auth_error=${encodeURIComponent(message)}`);
}

async function finalizeTrustedLogin(
  response: express.Response,
  tokens: OAuthV1TokenResult,
  appKey: FeishuOAuthAppKey,
  responseMode: 'json' | 'redirect',
): Promise<void> {
  const failLogin = (message: string): void => {
    if (responseMode === 'json') {
      response.status(401).set('Cache-Control', 'no-store').json({ ok: false, error: message });
      return;
    }
    redirectToFrontendWithAuthError(response, message);
  };

  const userInfoResponse = await axios.get(
    'https://open.feishu.cn/open-apis/authen/v1/user_info',
    { headers: { Authorization: `Bearer ${tokens.accessToken}` }, timeout: 20000 },
  );
  const userInfoBody = userInfoResponse.data as Record<string, unknown>;
  if (typeof userInfoBody.code === 'number' && userInfoBody.code !== 0) {
    failLogin(GENERIC_LOGIN_ERROR);
    return;
  }

  const userInfo = (userInfoBody.data && typeof userInfoBody.data === 'object'
    ? userInfoBody.data
    : userInfoBody) as FeishuUserInfoPayload;
  if (!userInfo.open_id) {
    failLogin(GENERIC_LOGIN_ERROR);
    return;
  }
  if (!isAllowedTenant(userInfo.tenant_key)) {
    failLogin(UNAUTHORIZED_TENANT_MESSAGE);
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
  await upsertSession({
    token: sessionToken,
    oauthAppKey: appKey,
    openId: userInfo.open_id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    expiresAt: new Date(now + (tokens.expiresIn > 0 ? tokens.expiresIn : 7200) * 1000).toISOString(),
    refreshExpiresAt: tokens.refreshExpiresIn > 0
      ? new Date(now + tokens.refreshExpiresIn * 1000).toISOString()
      : '',
  });

  response.cookie(SESSION_COOKIE_NAME, sessionToken, getSessionCookieOptions());

  if (responseMode === 'json') {
    response.set('Cache-Control', 'no-store').json({
      ok: true,
      loggedIn: true,
      profile: {
        openId: userInfo.open_id,
        name: userInfo.name ?? '',
        enName: userInfo.en_name ?? null,
        email: userInfo.email ?? null,
        avatarUrl: userInfo.avatar_url ?? null,
      },
    });
    return;
  }

  response.redirect(process.env.FRONTEND_POST_LOGIN_URL || '/');
}

function clearSessionCookie(response: express.Response): void {
  const common = { path: '/' };
  response.clearCookie(SESSION_COOKIE_NAME, { ...common, sameSite: 'none', secure: true });
  response.clearCookie(SESSION_COOKIE_NAME, { ...common, sameSite: 'lax' });
}

function sendAuthEntryDisabled(_request: express.Request, response: express.Response): void {
  response.setHeader('Cache-Control', 'no-store');
  response.status(410).json({ ok: false, error: AUTH_DISABLED_MESSAGE });
}

export function registerAuthSessionRoutes(app: express.Express): void {
  app.get('/api/auth/session', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const session = await peekSessionForRequest(request);
      if (!session) {
        response.json({ ok: true, loggedIn: false });
        return;
      }
      response.json({
        ok: true,
        loggedIn: true,
        profile: session.profile,
      });
    } catch {
      response.json({ ok: true, loggedIn: false });
    }
  });

  app.post('/api/auth/logout', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const tokens = resolveSessionTokenCandidatesFromRequest(request);
    await Promise.all(tokens.map((token) => deleteSessionByToken(token).catch(() => false)));
    clearSessionCookie(response);
    response.json({ ok: true });
  });

  app.get('/api/auth/feishu/:appKey/client-config', (request, response) => {
    const appKey = resolveRouteAppKey(request, response);
    if (!appKey) return;
    const config = getFeishuAppCredentials(appKey);
    if (!config.appId || !config.appSecret) {
      sendMissingAuthConfig(
        response,
        appKey,
        !config.appId ? `${appEnvPrefix(appKey)}_APP_ID` : `${appEnvPrefix(appKey)}_APP_SECRET`,
      );
      return;
    }
    response.set('Cache-Control', 'no-store').json({ ok: true, app_id: config.appId });
  });

  app.post('/api/auth/feishu/:appKey/client-diagnostics', express.json({ limit: '16kb' }), (request, response) => {
    const appKey = resolveRouteAppKey(request, response);
    if (!appKey) return;
    const body = request.body && typeof request.body === 'object'
      ? request.body as Record<string, unknown>
      : {};
    // eslint-disable-next-line no-console
    console.warn('[auth] Feishu client-side login unavailable:', JSON.stringify({
      appKey,
      stage: sanitizeDiagnosticValue(body.stage),
      message: sanitizeDiagnosticValue(body.message),
      hasH5Sdk: sanitizeDiagnosticValue(body.hasH5Sdk),
      hasTt: sanitizeDiagnosticValue(body.hasTt),
      hasRequestAccess: sanitizeDiagnosticValue(body.hasRequestAccess),
      hasRequestAuthCode: sanitizeDiagnosticValue(body.hasRequestAuthCode),
      userAgentHasWebApp: sanitizeDiagnosticValue(body.userAgentHasWebApp),
      isIframe: sanitizeDiagnosticValue(body.isIframe),
      referrerOrigin: sanitizeDiagnosticValue(body.referrerOrigin),
      userAgent: sanitizeDiagnosticValue(body.userAgent),
    }));
    response.set('Cache-Control', 'no-store').json({ ok: true });
  });

  app.post('/api/auth/feishu/:appKey/client-code', express.json({ limit: '16kb' }), async (request, response) => {
    const appKey = resolveRouteAppKey(request, response);
    if (!appKey) return;

    const config = getFeishuAppCredentials(appKey);
    if (!config.appId || !config.appSecret) {
      sendMissingAuthConfig(
        response,
        appKey,
        !config.appId ? `${appEnvPrefix(appKey)}_APP_ID` : `${appEnvPrefix(appKey)}_APP_SECRET`,
      );
      return;
    }

    const code = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
    if (!code || code.length > 512) {
      response.status(400).set('Cache-Control', 'no-store').json({ ok: false, error: '飞书客户端授权码无效，请重新登录。' });
      return;
    }

    try {
      const appAccessToken = await getAppAccessToken(config.appId, config.appSecret);
      const tokens = await exchangeCodeV1(code, appAccessToken);
      await finalizeTrustedLogin(response, tokens, appKey, 'json');
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Feishu client-side login error:', safeAuthErrorMessage(error));
      response.status(401).set('Cache-Control', 'no-store').json({ ok: false, error: GENERIC_LOGIN_ERROR });
    }
  });

  app.get('/auth/feishu/:appKey/qr-config', (request, response) => {
    const appKey = resolveRouteAppKey(request, response);
    if (!appKey) return;

    const config = getFeishuAppCredentials(appKey);
    const qrRedirectUri = buildQrRedirectUri(appKey);
    if (!config.appId || !config.appSecret || !qrRedirectUri) {
      sendMissingAuthConfig(
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

    const state = createSignedQrState(appKey, config.appSecret, config.appId);
    setOAuthStateCookie(response, `${QR_STATE_COOKIE_PREFIX}_${appKey}`, state);
    const params = new URLSearchParams({
      client_id: config.appId,
      redirect_uri: qrRedirectUri,
      response_type: 'code',
      state,
    });

    response.set('Cache-Control', 'no-store').json({
      ok: true,
      goto: `https://passport.feishu.cn/suite/passport/oauth/authorize?${params.toString()}`,
      expires_in: 300,
    });
  });

  app.get('/auth/feishu/:appKey/qr-callback', async (request, response) => {
    const appKey = resolveRouteAppKey(request, response);
    if (!appKey) return;

    const config = getFeishuAppCredentials(appKey);
    const code = typeof request.query.code === 'string' ? request.query.code.trim() : '';
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    if (!code || !config.appId || !config.appSecret) {
      redirectToFrontendWithAuthError(response, GENERIC_LOGIN_ERROR);
      return;
    }
    const cookieOk = consumeOAuthStateCookie(request, response, `${QR_STATE_COOKIE_PREFIX}_${appKey}`, state);
    if (!cookieOk && !verifySignedQrState(state, appKey, config.appSecret, config.appId)) {
      redirectToFrontendWithAuthError(response, '登录状态已失效，请重新扫码。');
      return;
    }

    try {
      const appAccessToken = await getAppAccessToken(config.appId, config.appSecret);
      const tokens = await exchangeCodeV1(code, appAccessToken);
      await finalizeTrustedLogin(response, tokens, appKey, 'redirect');
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Feishu QR login error:', safeAuthErrorMessage(error));
      redirectToFrontendWithAuthError(response, GENERIC_LOGIN_ERROR);
    }
  });

  app.all(/^\/auth\/feishu\/[^/]+(?:\/.*)?$/, sendAuthEntryDisabled);
  app.all(/^\/api\/auth\/feishu\/[^/]+(?:\/.*)?$/, sendAuthEntryDisabled);
}
