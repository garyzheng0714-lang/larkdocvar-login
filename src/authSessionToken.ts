const EMBEDDED_AUTH_SESSION_TOKEN_KEY = "larkdocvar_embed_session_token";
const EMBEDDED_AUTH_HASH_PARAM = "session_token";

declare global {
  interface Window {
    __larkdocvarAuthFetchInstalled?: boolean;
  }
}

export function getStoredEmbeddedAuthToken(): string {
  try {
    return window.localStorage.getItem(EMBEDDED_AUTH_SESSION_TOKEN_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

export function setStoredEmbeddedAuthToken(token: string): void {
  try {
    window.localStorage.setItem(EMBEDDED_AUTH_SESSION_TOKEN_KEY, token);
  } catch {
    // ignore storage failures in embedded runtime
  }
}

export function clearStoredEmbeddedAuthToken(): void {
  try {
    window.localStorage.removeItem(EMBEDDED_AUTH_SESSION_TOKEN_KEY);
  } catch {
    // ignore storage failures in embedded runtime
  }
}

export function consumeEmbeddedAuthTokenFromHash(): string {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash) return "";

  const params = new URLSearchParams(hash);
  const token = params.get(EMBEDDED_AUTH_HASH_PARAM)?.trim() || "";
  if (!token) return "";

  params.delete(EMBEDDED_AUTH_HASH_PARAM);
  const nextHash = params.toString();
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ""}`;
  try {
    window.history.replaceState(null, "", nextUrl);
  } catch {
    // ignore history API failures in embedded runtime
  }
  return token;
}

function isSameOriginRequest(input: RequestInfo | URL): boolean {
  if (typeof window === "undefined") return false;
  try {
    const url =
      typeof input === "string"
        ? new URL(input, window.location.href)
        : input instanceof URL
          ? input
          : new URL(input.url, window.location.href);
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

export function withEmbeddedAuthHeader(input: RequestInfo | URL, init?: RequestInit): RequestInit {
  const headers = new Headers(
    init?.headers ||
      (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined),
  );
  const token = isSameOriginRequest(input) ? getStoredEmbeddedAuthToken() : "";
  if (token && !headers.has("X-Session-Token")) {
    headers.set("X-Session-Token", token);
  }
  return {
    ...init,
    headers,
  };
}

export function installEmbeddedAuthFetchFallback(): void {
  if (typeof window === "undefined" || window.__larkdocvarAuthFetchInstalled) return;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isSameOriginRequest(input)) {
      return nativeFetch(input, init);
    }
    return nativeFetch(input, withEmbeddedAuthHeader(input, init));
  };
  window.__larkdocvarAuthFetchInstalled = true;
}
