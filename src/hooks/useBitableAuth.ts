import { useCallback, useEffect, useState } from 'react';
import { bitable } from '@lark-base-open/js-sdk';

interface AuthUser {
  openId: string;
  name: string;
  avatarUrl?: string;
}

interface UseBitableAuthResult {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  logout: () => Promise<void>;
}

const API_BASE = '/api';
const TOKEN_KEY = 'larkdocvar_session_token';

export function useBitableAuth(): UseBitableAuthResult {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getToken = useCallback(() => {
    return localStorage.getItem(TOKEN_KEY);
  }, []);

  const setToken = useCallback((token: string) => {
    localStorage.setItem(TOKEN_KEY, token);
  }, []);

  const clearToken = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
  }, []);

  const fetchWithAuth = useCallback(async (path: string, options: RequestInit = {}) => {
    const token = getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }, [getToken]);

  const checkSession = useCallback(async () => {
    try {
      const data = await fetchWithAuth('/auth/session');
      if (data.ok && data.loggedIn && data.user) {
        setUser({
          openId: data.user.open_id,
          name: data.user.name,
          avatarUrl: data.user.avatar_url,
        });
        return true;
      }
    } catch {
      // session 无效
    }
    return false;
  }, [fetchWithAuth]);

  const pluginLogin = useCallback(async (openId: string) => {
    const data = await fetchWithAuth('/auth/plugin-login', {
      method: 'POST',
      body: JSON.stringify({ open_id: openId }),
    });
    if (data.token) {
      setToken(data.token);
      setUser({
        openId: data.user.open_id,
        name: data.user.name,
        avatarUrl: data.user.avatar_url,
      });
    }
  }, [fetchWithAuth, setToken]);

  const logout = useCallback(async () => {
    try {
      await fetchWithAuth('/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    clearToken();
    setUser(null);
  }, [fetchWithAuth, clearToken]);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      setLoading(true);
      setError(null);

      // 1. 检查现有 session
      const hasSession = await checkSession();
      if (cancelled) return;
      if (hasSession) {
        setLoading(false);
        return;
      }

      // 2. 尝试通过 Bitable SDK 获取 open_id
      try {
        const userId = await Promise.race([
          bitable.bridge.getUserId(),
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error('SDK timeout')), 3000),
          ),
        ]);
        if (cancelled) return;
        if (userId) {
          await pluginLogin(userId);
          if (cancelled) return;
          setLoading(false);
          return;
        }
      } catch {
        // Bitable SDK 不可用，降级到 OAuth
      }

      // 3. 降级：检查 URL hash 中的 token
      const hash = window.location.hash;
      const match = hash.match(/session_token=([^&]+)/);
      if (match) {
        setToken(match[1]);
        window.location.hash = '';
        const hasSession = await checkSession();
        if (cancelled) return;
        if (hasSession) {
          setLoading(false);
          return;
        }
      }

      // 4. 无登录态
      if (!cancelled) {
        setLoading(false);
      }
    };

    init();
    return () => { cancelled = true; };
  }, [checkSession, pluginLogin, setToken]);

  return { user, loading, error, logout };
}
