const FEISHU_H5_SDK_URL = 'https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.44.js';
const FEISHU_QR_SDK_URL =
  'https://lf-package-cn.feishucdn.com/obj/feishu-static/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.3.js';

declare global {
  interface Window {
    h5sdk?: {
      ready: (callback: () => void) => void;
      error?: (callback: (error: unknown) => void) => void;
    };
    tt?: {
      requestAccess?: (options: {
        appID: string;
        scopeList: string[];
        success: (response: { code?: string }) => void;
        fail: (error: unknown) => void;
      }) => void;
      requestAuthCode?: (options: {
        appId: string;
        success: (response: { code?: string }) => void;
        fail: (error: unknown) => void;
      }) => void;
    };
    QRLogin?: (options: {
      id: string;
      goto: string;
      width?: string;
      height?: string;
      style?: string;
    }) => unknown;
  }
}

class FeishuClientLoginUnavailableError extends Error {
  stage: string;

  constructor(message: string, stage: string) {
    super(message);
    this.name = 'FeishuClientLoginUnavailableError';
    this.stage = stage;
  }
}

let h5SdkLoadPromise: Promise<void> | null = null;
let qrSdkLoadPromise: Promise<void> | null = null;

function isLikelyFeishuRuntime(): boolean {
  const userAgent = navigator.userAgent.toLowerCase();
  const referrer = document.referrer.toLowerCase();
  if (
    userAgent.includes('feishu') ||
    userAgent.includes('lark') ||
    referrer.includes('feishu.cn') ||
    referrer.includes('larksuite.com')
  ) {
    return true;
  }
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function getReferrerOrigin(): string {
  try {
    return document.referrer ? new URL(document.referrer).origin : '';
  } catch {
    return '';
  }
}

function getErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const raw = (error as { errno?: unknown; errNo?: unknown; code?: unknown }).errno
    ?? (error as { errNo?: unknown }).errNo
    ?? (error as { code?: unknown }).code;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string, stage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new FeishuClientLoginUnavailableError(message, stage)),
      timeoutMs,
    );
    task.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 10000): Promise<{
  response: Response;
  data: T;
}> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      credentials: 'include',
      signal: init?.signal ?? controller.signal,
    });
    const data = await response.json().catch(() => ({})) as T;
    return { response, data };
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function hasTrustedSession(): Promise<boolean> {
  const { response, data } = await fetchJson<{ loggedIn?: boolean; profile?: unknown }>(
    '/api/auth/session',
    { cache: 'no-store' },
  );
  return response.ok && Boolean(data.loggedIn || data.profile);
}

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${url}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('script load failed')), { once: true });
      if (existing.dataset.loaded === '1') resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      script.dataset.loaded = '1';
      resolve();
    };
    script.onerror = () => reject(new Error('script load failed'));
    document.head.appendChild(script);
  });
}

async function loadFeishuH5Sdk(): Promise<void> {
  if (window.h5sdk && (window.tt?.requestAccess || window.tt?.requestAuthCode)) return;
  if (!h5SdkLoadPromise) h5SdkLoadPromise = loadScript(FEISHU_H5_SDK_URL);
  await h5SdkLoadPromise;
}

function waitForH5SdkReady(): Promise<void> {
  if (!window.h5sdk) {
    throw new FeishuClientLoginUnavailableError('当前环境不支持飞书客户端内授权。', 'h5sdk_missing');
  }
  return withTimeout(new Promise((resolve, reject) => {
    try {
      window.h5sdk?.error?.((error) => reject(error));
      window.h5sdk?.ready(() => resolve());
    } catch (error) {
      reject(error);
    }
  }), 5000, '飞书客户端授权组件未就绪。', 'h5sdk_ready_timeout');
}

async function requestClientCode(appId: string): Promise<string> {
  if (!window.tt?.requestAccess && !window.tt?.requestAuthCode) {
    throw new FeishuClientLoginUnavailableError('当前环境不支持飞书客户端内授权。', 'auth_api_missing');
  }

  const requestAuthCode = (): Promise<string> => withTimeout(new Promise((resolve, reject) => {
    window.tt?.requestAuthCode?.({
      appId,
      success: (response) => {
        const code = response.code?.trim() || '';
        code ? resolve(code) : reject(new FeishuClientLoginUnavailableError('飞书客户端授权未返回授权码。', 'request_auth_code_no_code'));
      },
      fail: () => reject(new FeishuClientLoginUnavailableError('飞书客户端授权失败。', 'request_auth_code_failed')),
    });
  }), 10000, '飞书客户端授权超时。', 'request_auth_code_timeout');

  const requestAccess = (): Promise<string> => withTimeout(new Promise((resolve, reject) => {
    window.tt?.requestAccess?.({
      appID: appId,
      scopeList: [],
      success: (response) => {
        const code = response.code?.trim() || '';
        code ? resolve(code) : reject(new FeishuClientLoginUnavailableError('飞书客户端授权未返回授权码。', 'request_access_no_code'));
      },
      fail: (error) => {
        if (getErrorCode(error) === 103 && window.tt?.requestAuthCode) {
          requestAuthCode().then(resolve, reject);
          return;
        }
        reject(new FeishuClientLoginUnavailableError('飞书客户端授权失败。', 'request_access_failed'));
      },
    });
  }), 10000, '飞书客户端授权超时。', 'request_access_timeout');

  if (window.tt?.requestAuthCode) {
    return requestAuthCode().catch((error) => {
      if (error instanceof FeishuClientLoginUnavailableError && error.stage === 'request_auth_code_timeout') throw error;
      if (!window.tt?.requestAccess) throw error;
      return requestAccess();
    });
  }
  return requestAccess();
}

function reportClientLoginUnavailable(error: unknown): void {
  void fetch('/api/auth/feishu/fbif/client-diagnostics', {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stage: error instanceof FeishuClientLoginUnavailableError ? error.stage : 'non_unavailable_error',
      message: error instanceof Error ? error.message : String(error),
      hasH5Sdk: Boolean(window.h5sdk),
      hasTt: Boolean(window.tt),
      hasRequestAccess: Boolean(window.tt?.requestAccess),
      hasRequestAuthCode: Boolean(window.tt?.requestAuthCode),
      userAgentHasWebApp: navigator.userAgent.includes('WebApp'),
      isIframe: (() => {
        try {
          return window.self !== window.top;
        } catch {
          return true;
        }
      })(),
      userAgent: navigator.userAgent.slice(0, 240),
      referrerOrigin: getReferrerOrigin(),
    }),
  }).catch(() => undefined);
}

export interface TrustedLoginResult {
  ok: boolean;
  /** 诊断阶段标识，与服务端 client-diagnostics 一致，便于排查。 */
  stage?: string;
  /** 给终端用户看的人话原因（失败时一定有）。 */
  reason?: string;
  /** 环境诊断摘要（h5sdk/tt/iframe 等），失败时直接显示，便于定位容器能力。 */
  detail?: string;
}

// 抓当前容器能力快照——Base 扩展侧边栏没有 h5sdk/tt，这里一眼能看出来。
function captureClientEnv(): string {
  const tt = window.tt;
  let iframe = 'Y';
  try { iframe = window.self !== window.top ? 'Y' : 'N'; } catch { iframe = 'Y'; }
  const ua = navigator.userAgent;
  const marks = [
    `h5sdk=${window.h5sdk ? 'Y' : 'N'}`,
    `tt=${tt ? 'Y' : 'N'}`,
    `reqAccess=${tt?.requestAccess ? 'Y' : 'N'}`,
    `reqAuthCode=${tt?.requestAuthCode ? 'Y' : 'N'}`,
    `iframe=${iframe}`,
    `lark=${/lark/i.test(ua) ? 'Y' : 'N'}`,
    `webapp=${ua.includes('WebApp') ? 'Y' : 'N'}`,
  ];
  return marks.join(' · ');
}

// stage → 人话原因。规则十二「显式失败」：免登失败必须给用户看得懂的理由，
// 而不是静默返回 false 让上层弹回一张"登录态没有接上"的死卡片。
const STAGE_REASONS: Record<string, string> = {
  not_feishu_runtime: '当前不在飞书客户端内，无法免登。请改用扫码登录。',
  config_unavailable: '免登服务未就绪（缺少应用配置），请改用扫码登录。',
  sdk_load_timeout: '飞书免登组件加载超时，请检查网络后重试，或改用扫码登录。',
  h5sdk_missing: '当前飞书环境不支持客户端内免登，请改用扫码登录。',
  h5sdk_ready_timeout: '飞书免登组件未就绪，请重试，或改用扫码登录。',
  auth_api_missing: '当前飞书环境未提供授权接口，请改用扫码登录。',
  request_access_timeout: '飞书免登授权超时，请重试，或改用扫码登录。',
  request_auth_code_timeout: '飞书免登授权超时，请重试，或改用扫码登录。',
  request_access_failed: '飞书免登授权失败或被拒绝，请重试，或改用扫码登录。',
  request_auth_code_failed: '飞书免登授权失败或被拒绝，请重试，或改用扫码登录。',
  request_access_no_code: '飞书免登未返回授权码，请重试，或改用扫码登录。',
  request_auth_code_no_code: '飞书免登未返回授权码，请重试，或改用扫码登录。',
  exchange_failed: '飞书免登换取登录态失败，请重试，或改用扫码登录。',
};

function reasonForStage(stage: string | undefined): string {
  return (stage && STAGE_REASONS[stage]) || '飞书免登未能完成，请重试，或改用扫码登录。';
}

function loginFailure(stage: string): TrustedLoginResult {
  return { ok: false, stage, reason: reasonForStage(stage), detail: `${stage} | ${captureClientEnv()}` };
}

export async function tryFeishuClientTrustedLogin(): Promise<TrustedLoginResult> {
  if (await hasTrustedSession()) return { ok: true };
  // 注意：不再按 UA 预先短路桌面端。CLAUDE.md 要求飞书桌面侧边栏优先走 client-code 免登；
  // 桌面端确实跑不动时，由下面的超时 + 显式 stage 响亮兜底，而不是静默跳过。
  if (!isLikelyFeishuRuntime()) return loginFailure('not_feishu_runtime');

  try {
    const config = await fetchJson<{ ok?: boolean; app_id?: string; error?: string }>(
      '/api/auth/feishu/fbif/client-config',
      { cache: 'no-store' },
    );
    if (!config.response.ok || config.data.ok === false || !config.data.app_id) {
      return loginFailure('config_unavailable');
    }
    await withTimeout(loadFeishuH5Sdk(), 5000, '飞书客户端授权组件加载超时。', 'sdk_load_timeout');
    await waitForH5SdkReady();
    const code = await requestClientCode(config.data.app_id);
    const login = await fetchJson<{ ok?: boolean; error?: string }>(
      '/api/auth/feishu/fbif/client-code',
      {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      },
      70000,
    );
    if (login.response.ok && login.data.ok !== false && await hasTrustedSession()) {
      return { ok: true };
    }
    return loginFailure('exchange_failed');
  } catch (error) {
    reportClientLoginUnavailable(error);
    const stage = error instanceof FeishuClientLoginUnavailableError ? error.stage : 'exchange_failed';
    return loginFailure(stage);
  }
}

export async function fetchTrustedLoginQrGoto(): Promise<string> {
  const { response, data } = await fetchJson<{ ok?: boolean; goto?: string; error?: string }>(
    '/auth/feishu/fbif/qr-config',
    { cache: 'no-store' },
  );
  if (!response.ok || data.ok === false || !data.goto) {
    throw new Error(data.error || '登录二维码准备失败，请稍后重试。');
  }
  return data.goto;
}

export async function mountTrustedLoginQr(elementId: string, goto: string): Promise<void> {
  if (!qrSdkLoadPromise) qrSdkLoadPromise = loadScript(FEISHU_QR_SDK_URL);
  await qrSdkLoadPromise;
  if (!window.QRLogin) {
    throw new Error('登录二维码组件加载失败，请稍后重试。');
  }
  window.QRLogin({
    id: elementId,
    goto,
    width: '220',
    height: '220',
    style: 'width:220px;height:220px;border:0;',
  });
}
