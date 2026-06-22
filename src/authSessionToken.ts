const EMBEDDED_SESSION_TOKEN_KEY = 'fbif_docgen_session_token';

function canUseStorage(): boolean {
  try {
    return typeof window !== 'undefined' && Boolean(window.localStorage);
  } catch {
    return false;
  }
}

export function getStoredEmbeddedAuthToken(): string {
  if (!canUseStorage()) return '';
  return window.localStorage.getItem(EMBEDDED_SESSION_TOKEN_KEY) || '';
}

export function setStoredEmbeddedAuthToken(token: string): void {
  if (!canUseStorage()) return;
  const trimmed = token.trim();
  if (trimmed) {
    window.localStorage.setItem(EMBEDDED_SESSION_TOKEN_KEY, trimmed);
  }
}

export function clearStoredEmbeddedAuthToken(): void {
  if (!canUseStorage()) return;
  window.localStorage.removeItem(EMBEDDED_SESSION_TOKEN_KEY);
}

export function consumeEmbeddedAuthTokenFromHash(): boolean {
  if (typeof window === 'undefined') return false;
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  const token = params.get('session_token');
  if (!token) return false;
  setStoredEmbeddedAuthToken(token);
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return true;
}

export function withEmbeddedAuthHeader(init: RequestInit = {}): RequestInit {
  const token = getStoredEmbeddedAuthToken();
  if (!token) return init;
  const headers = new Headers(init.headers);
  if (!headers.has('X-Session-Token')) {
    headers.set('X-Session-Token', token);
  }
  return { ...init, headers };
}

let installed = false;

export function installEmbeddedAuthFetchFallback(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const sameOrigin = (() => {
      try {
        return new URL(requestUrl, window.location.href).origin === window.location.origin;
      } catch {
        return false;
      }
    })();
    const nextInit = sameOrigin ? withEmbeddedAuthHeader(init || {}) : init;
    const response = await nativeFetch(input, nextInit);
    if (sameOrigin) {
      const refreshed = response.headers.get('X-Session-Token');
      if (refreshed) {
        setStoredEmbeddedAuthToken(refreshed);
      }
    }
    if (response.status === 401) {
      clearStoredEmbeddedAuthToken();
    }
    return response;
  };
}
