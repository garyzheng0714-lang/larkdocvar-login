const FEISHU_H5_SDK_URL = "https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.44.js";
const GENERIC_LOGIN_ERROR = "飞书登录失败，请重新点击登录。";
const GENERIC_CONFIG_ERROR = "登录服务暂时不可用，请稍后重试。";

declare global {
  interface Window {
    h5sdk?: {
      ready: (callback: () => void) => void;
      error?: (callback: (error: unknown) => void) => void;
    };
    tt?: {
      requestAccess: (options: {
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
    lark?: unknown;
    ttJSBridge?: unknown;
    WebViewJavascriptBridge?: unknown;
    LarkWebViewJavaScriptBridge?: unknown;
    webkit?: {
      messageHandlers?: {
        invoke?: unknown;
      };
    };
  }
}

export class FeishuClientLoginUnavailableError extends Error {
  stage: string;

  constructor(message = "当前环境不支持飞书客户端内授权。", stage = "unknown") {
    super(message);
    this.name = "FeishuClientLoginUnavailableError";
    this.stage = stage;
  }
}

let sdkLoadPromise: Promise<void> | null = null;

function hasFeishuClientAuthApi(): boolean {
  return Boolean(window.tt?.requestAccess || window.tt?.requestAuthCode);
}

function isFeishuDesktopClientWithoutWebApp(): boolean {
  const userAgent = navigator.userAgent;
  const lower = userAgent.toLowerCase();
  const isFeishuClient = lower.includes("lark") || lower.includes("feishu");
  const isMobile = /(Android|Mobile|iPhone|iPad|iPod|iOS)/i.test(userAgent);
  return isFeishuClient && !isMobile && !userAgent.includes("WebApp");
}

export function isLikelyFeishuClientRuntime(): boolean {
  const userAgent = navigator.userAgent.toLowerCase();
  const referrer = document.referrer.toLowerCase();
  if (
    userAgent.includes("feishu") ||
    userAgent.includes("lark") ||
    referrer.includes("feishu.cn") ||
    referrer.includes("larksuite.com")
  ) {
    return true;
  }
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function getFeishuClientErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { errno?: unknown; errNo?: unknown; code?: unknown };
  const raw = value.errno ?? value.errNo ?? value.code;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string, stage = "timeout"): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new FeishuClientLoginUnavailableError(message, stage)), timeoutMs);
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
      signal: init?.signal ?? controller.signal,
    });
    let data: T;
    try {
      data = (await response.json()) as T;
    } catch {
      data = {} as T;
    }
    return { response, data };
  } finally {
    window.clearTimeout(timeout);
  }
}

function loadFeishuH5Sdk(): Promise<void> {
  if (window.h5sdk && hasFeishuClientAuthApi()) {
    return Promise.resolve();
  }
  if (sdkLoadPromise) return sdkLoadPromise;

  sdkLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${FEISHU_H5_SDK_URL}"]`,
    );
    if (existing) {
      if (window.h5sdk && hasFeishuClientAuthApi()) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new FeishuClientLoginUnavailableError("飞书客户端授权组件加载失败。", "sdk_load_error")),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.src = FEISHU_H5_SDK_URL;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      window.setTimeout(() => {
        resolve();
      }, 0);
    };
    script.onerror = () => {
      sdkLoadPromise = null;
      reject(new FeishuClientLoginUnavailableError("飞书客户端授权组件加载失败。", "sdk_load_error"));
    };
    document.head.appendChild(script);
  });

  return sdkLoadPromise;
}

function waitForH5SdkReady(): Promise<void> {
  const h5sdk = window.h5sdk;
  if (!h5sdk) {
    throw new FeishuClientLoginUnavailableError("当前环境不支持飞书客户端内授权。", "h5sdk_missing");
  }
  return withTimeout(new Promise((resolve, reject) => {
    try {
      h5sdk.error?.((error) => reject(error));
      h5sdk.ready(() => resolve());
    } catch (error) {
      reject(error);
    }
  }), 5000, "飞书客户端授权组件未就绪。", "h5sdk_ready_timeout");
}

async function fetchClientConfig(org: "fbif" | "fude"): Promise<{ appId: string }> {
  const { response, data } = await fetchJson<{ ok?: boolean; app_id?: string; error?: string }>(
    `/api/auth/feishu/${org}/client-config`,
    {
      credentials: "include",
      cache: "no-store",
    },
  );
  if (!response.ok || data.ok === false || !data.app_id) {
    throw new Error(GENERIC_CONFIG_ERROR);
  }
  return { appId: data.app_id };
}

function requestFeishuClientCode(appId: string): Promise<string> {
  if (!window.tt?.requestAccess && !window.tt?.requestAuthCode) {
    throw new FeishuClientLoginUnavailableError("当前环境不支持飞书客户端内授权。", "auth_api_missing");
  }

  const requestAuthCode = (): Promise<string> => withTimeout(new Promise((resolve, reject) => {
    window.tt?.requestAuthCode?.({
      appId,
      success: (response) => {
        const code = response.code?.trim() || "";
        if (!code) {
          reject(new FeishuClientLoginUnavailableError("飞书客户端授权未返回授权码。", "request_auth_code_no_code"));
          return;
        }
        resolve(code);
      },
      fail: () => reject(new FeishuClientLoginUnavailableError("飞书客户端授权失败。", "request_auth_code_failed")),
    });
  }), 10000, "飞书客户端授权超时，请重新点击登录。", "request_auth_code_timeout");

  const requestAccess = (): Promise<string> => {
    if (!window.tt?.requestAccess) {
      throw new FeishuClientLoginUnavailableError("当前环境不支持飞书客户端内授权。", "request_access_missing");
    }
    return withTimeout(new Promise((resolve, reject) => {
      window.tt?.requestAccess({
        appID: appId,
        scopeList: [],
        success: (response) => {
          const code = response.code?.trim() || "";
          if (!code) {
            reject(new FeishuClientLoginUnavailableError("飞书客户端授权未返回授权码。", "request_access_no_code"));
            return;
          }
          resolve(code);
        },
        fail: (error) => {
          if (getFeishuClientErrorCode(error) === 103 && window.tt?.requestAuthCode) {
            requestAuthCode().then(resolve, reject);
            return;
          }
          reject(new FeishuClientLoginUnavailableError("飞书客户端授权失败。", "request_access_failed"));
        },
      });
    }), 10000, "飞书客户端授权超时，请重新点击登录。", "request_access_timeout");
  };

  if (window.tt?.requestAuthCode) {
    return requestAuthCode().catch((error) => {
      if (error instanceof FeishuClientLoginUnavailableError && error.stage === "request_auth_code_timeout") {
        throw error;
      }
      if (!window.tt?.requestAccess) throw error;
      return requestAccess();
    });
  }

  return requestAccess();
}

export function isFeishuClientLoginUnavailable(error: unknown): boolean {
  return error instanceof FeishuClientLoginUnavailableError;
}

function getReferrerOrigin(): string {
  try {
    return document.referrer ? new URL(document.referrer).origin : "";
  } catch {
    return "";
  }
}

export function getFeishuClientLoginDiagnostics(error: unknown): Record<string, unknown> {
  return {
    stage: error instanceof FeishuClientLoginUnavailableError ? error.stage : "non_unavailable_error",
    message: error instanceof Error ? error.message : String(error),
    hasH5Sdk: Boolean(window.h5sdk),
    hasTt: Boolean(window.tt),
    hasRequestAccess: Boolean(window.tt?.requestAccess),
    hasRequestAuthCode: Boolean(window.tt?.requestAuthCode),
    hasLark: Boolean(window.lark),
    hasTtJSBridge: Boolean(window.ttJSBridge),
    hasWebkitInvoke: Boolean(window.webkit?.messageHandlers?.invoke),
    hasWebViewJavascriptBridge: Boolean(window.WebViewJavascriptBridge),
    hasLarkWebViewJavaScriptBridge: Boolean(window.LarkWebViewJavaScriptBridge),
    userAgentHasWebApp: navigator.userAgent.includes("WebApp"),
    isIframe: (() => {
      try {
        return window.self !== window.top;
      } catch {
        return true;
      }
    })(),
    userAgent: navigator.userAgent.slice(0, 240),
    referrerOrigin: getReferrerOrigin(),
  };
}

export async function loginWithFeishuClient(org: "fbif" | "fude"): Promise<string> {
  if (isFeishuDesktopClientWithoutWebApp()) {
    throw new FeishuClientLoginUnavailableError(
      "当前飞书客户端未提供端内授权容器。",
      "pc_lark_not_webapp_container",
    );
  }
  const { appId } = await fetchClientConfig(org);
  await withTimeout(loadFeishuH5Sdk(), 5000, "飞书客户端授权组件加载超时。", "sdk_load_timeout");
  if (!window.h5sdk || !hasFeishuClientAuthApi()) {
    throw new FeishuClientLoginUnavailableError("当前环境不支持飞书客户端内授权。", "auth_api_missing_after_ready");
  }
  await waitForH5SdkReady();
  const code = await requestFeishuClientCode(appId);

  const { response, data } = await fetchJson<{
    ok?: boolean;
    session_token?: string;
    error?: string;
  }>(`/api/auth/feishu/${org}/client-code`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  }, 70000);
  if (!response.ok || data.ok === false || !data.session_token) {
    throw new Error(data.error || GENERIC_LOGIN_ERROR);
  }
  return data.session_token;
}
