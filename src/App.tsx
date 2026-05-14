import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { FeishuLoginCard } from "./components/FeishuLoginCard";
import {
  DocumentGeneratorApp,
  useBitable,
  useTemplates,
  useGenerateMock,
  useGenerateReal,
  MOCK_FIELDS,
  MOCK_TEMPLATES,
  MOCK_ROWS,
} from "./components/document-generator";
import type { PrimaryState, RecordSpec } from "./components/document-generator";

function useMockMode(): boolean {
  return useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get("mock") === "1";
    } catch {
      return false;
    }
  }, []);
}

function useStandalonePreviewMode(): boolean {
  return useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get("standalone") === "1";
    } catch {
      return false;
    }
  }, []);
}

function V2MockRoute({ userMenu, standalone = false }: { userMenu: ReactNode; standalone?: boolean }) {
  const runner = useGenerateMock();
  const [mockFields, setMockFields] = useState(MOCK_FIELDS);
  const recordsFor = useCallback(
    (state: PrimaryState): RecordSpec[] =>
      standalone
        ? [{ id: 'manual-1', displayName: '手动生成' }]
        : MOCK_ROWS.slice(0, Math.min(state.selectedCount, MOCK_ROWS.length)).map(
            (r: (typeof MOCK_ROWS)[number], i: number): RecordSpec => ({
              id: `mock-${i + 1}`,
              displayName: r.客户名称,
            }),
          ),
    [standalone],
  );
  return (
    <DocumentGeneratorApp
      userMenu={userMenu}
      mode={standalone ? 'standalone' : 'bitable'}
      fields={standalone ? [] : mockFields}
      templates={MOCK_TEMPLATES}
      selectedCount={standalone ? 1 : 6}
      bitableAvailable={!standalone}
      createAttachmentField={async (name = '生成文档') => {
        const created = {
          id: `mock_attachment_${Date.now()}`,
          name,
          type: 'attachment' as const,
          icon: '',
        };
        setMockFields((prev) => [...prev, created]);
        return created;
      }}
      runner={runner}
      recordsFor={recordsFor}
    />
  );
}

function V2RealRoute({ userMenu }: { userMenu: ReactNode }) {
  const base = useBitable();
  const templates = useTemplates();
  const runner = useGenerateReal();
  const standalone = !base.loading && !base.available;
  const recordsFor = useCallback(
    (_state: PrimaryState): RecordSpec[] => {
      if (standalone) {
        return [{ id: 'manual-1', displayName: '手动生成' }];
      }
      const ids = base.selectedRecordIds.length > 0 ? base.selectedRecordIds : base.allRecordIds;
      return ids.map((id, i) => ({ id, displayName: `记录 ${i + 1}` }));
    },
    [standalone, base.selectedRecordIds, base.allRecordIds],
  );
  return (
    <DocumentGeneratorApp
      userMenu={userMenu}
      mode={standalone ? 'standalone' : 'bitable'}
      fields={standalone ? [] : base.fields}
      activeTableId={standalone ? null : base.activeTableId}
      templates={templates.items}
      selectedCount={standalone ? 1 : base.selectedCount || base.totalRecordCount || 0}
      bitableAvailable={base.available}
      bitableError={standalone ? null : base.error}
      templatesLoading={templates.loading}
      templatesError={templates.error}
      refreshTemplates={templates.refresh}
      createAttachmentField={base.createAttachmentField}
      runner={runner}
      recordsFor={recordsFor}
    />
  );
}

interface AccountMenuProps {
  user: AuthUser;
  onLogout: () => void;
}

function AccountMenu({ user, onLogout }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const name = user.name || "已登录用户";
  const avatarText = (user.name?.trim() || "U").slice(0, 1).toUpperCase();
  const avatarColor = useMemo(() => {
    const source = user.openId || name;
    let hash = 0;
    for (let i = 0; i < source.length; i += 1) {
      hash = source.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 42%)`;
  }, [user.openId, name]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-9 pl-1.5 pr-2 inline-flex items-center gap-2 rounded-full border border-[#dee0e3] bg-white hover:border-[#bfd0ff] transition-colors"
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover bg-gray-100" />
        ) : (
          <span
            className="w-7 h-7 rounded-full text-white text-[12px] font-semibold flex items-center justify-center"
            style={{ backgroundColor: avatarColor }}
          >
            {avatarText}
          </span>
        )}
        <span className="max-w-[96px] truncate text-[12px] font-medium text-[#1f2329]">{name}</span>
        <ChevronDown className={`w-[14px] h-[14px] text-[#8f959e] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="absolute right-0 top-[calc(100%+8px)] w-[180px] bg-white border border-[#dfe2e6] rounded-[10px] shadow-[0_10px_24px_rgba(0,0,0,0.12)] overflow-hidden z-40">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className="w-full px-4 py-3 text-left text-[15px] font-medium text-[#f54a45] hover:bg-[#fff4f4]"
          >
            退出登录
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface AuthUser {
  openId: string;
  name: string;
  enName?: string;
  email?: string;
  avatarUrl?: string;
}

interface AuthSessionResponse {
  ok: true;
  loggedIn?: boolean;
  user?: AuthUser;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatAuthFetchError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "登录检查超时，请稍后重试。";
  }
  return toErrorMessage(error);
}

async function apiFetch(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      credentials: "include",
      headers: new Headers(init?.headers),
      signal: init?.signal ?? controller.signal,
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

export default function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authPendingUntil, setAuthPendingUntil] = useState(() => {
    try {
      return Number(window.sessionStorage.getItem("feishu_oauth_pending_until") || 0);
    } catch {
      return 0;
    }
  });
  const authCheckInFlightRef = useRef(false);

  const clearAuthPendingFlag = useCallback(() => {
    setAuthPendingUntil(0);
    try {
      window.sessionStorage.removeItem("feishu_oauth_pending_until");
    } catch {
      // ignore sessionStorage access failures in embedded runtime
    }
  }, []);

  const markAuthPending = useCallback((durationMs = 90_000) => {
    const until = Date.now() + durationMs;
    setAuthPendingUntil(until);
    try {
      window.sessionStorage.setItem("feishu_oauth_pending_until", String(until));
    } catch {
      // ignore sessionStorage access failures in embedded runtime
    }
  }, []);

  const checkAuthSession = useCallback(async (options?: { silent?: boolean }) => {
    if (authCheckInFlightRef.current) {
      return;
    }

    authCheckInFlightRef.current = true;
    try {
      const response = await apiFetch("/api/auth/session", { cache: "no-store" });
      if (!response.ok) {
        if (!options?.silent) {
          try {
            const data = (await response.json()) as { error?: string };
            setAuthError(data.error || "登录检查失败，请稍后重试。");
          } catch {
            setAuthError("登录检查失败，请稍后重试。");
          }
        }
        setAuthUser(null);
        setIsAuthenticated(false);
        return;
      }

      const data = (await response.json()) as AuthSessionResponse;
      if (data.user) {
        setAuthError(null);
        setAuthUser(data.user);
        setIsAuthenticated(true);
        clearAuthPendingFlag();
      } else {
        setAuthUser(null);
        setIsAuthenticated(false);
      }
    } catch (error) {
      if (!options?.silent) {
        setAuthError(formatAuthFetchError(error));
      }
      setAuthUser(null);
      setIsAuthenticated(false);
    } finally {
      authCheckInFlightRef.current = false;
      setAuthLoading(false);
    }
  }, [clearAuthPendingFlag]);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("mock") === "1") {
        setAuthLoading(false);
        return;
      }
      const loginError = params.get("auth_error");
      if (loginError) {
        setAuthError(loginError);
        setAuthUser(null);
        setIsAuthenticated(false);
        setAuthLoading(false);
        clearAuthPendingFlag();
        params.delete("auth_error");
        params.delete("auth_org");
        const nextQuery = params.toString();
        const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
        window.history.replaceState(null, "", nextUrl);
        return;
      }
    } catch {
      // ignore — proceed to real auth check
    }
    void checkAuthSession();
  }, [checkAuthSession, clearAuthPendingFlag]);

  useEffect(() => {
    const recheckOnResume = () => {
      if (document.visibilityState !== "hidden") {
        void checkAuthSession({ silent: true });
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void checkAuthSession({ silent: true });
      }
    };

    window.addEventListener("focus", recheckOnResume);
    window.addEventListener("pageshow", recheckOnResume);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", recheckOnResume);
      window.removeEventListener("pageshow", recheckOnResume);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [checkAuthSession]);

  useEffect(() => {
    if (isAuthenticated) {
      clearAuthPendingFlag();
      return;
    }
    if (!authPendingUntil || Date.now() >= authPendingUntil) {
      if (authPendingUntil) {
        clearAuthPendingFlag();
      }
      return;
    }

    const timer = window.setInterval(() => {
      if (Date.now() >= authPendingUntil) {
        clearAuthPendingFlag();
        return;
      }
      void checkAuthSession({ silent: true });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [isAuthenticated, authPendingUntil, checkAuthSession, clearAuthPendingFlag]);

  const handleLogout = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore network failure; still drop client session
    }
    setAuthUser(null);
    setIsAuthenticated(false);
    setAuthError(null);
    clearAuthPendingFlag();
  }, [clearAuthPendingFlag]);

  const mockMode = useMockMode();
  const standalonePreview = useStandalonePreviewMode();

  if (mockMode) {
    const mockUser: AuthUser = { openId: "mock_user", name: "演示账号", avatarUrl: undefined };
    return (
      <V2MockRoute
        standalone={standalonePreview}
        userMenu={<AccountMenu user={mockUser} onLogout={() => window.alert("（mock 模式不会真的退出）")} />}
      />
    );
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-[14px] text-[#5f6670]">
        正在检查登录状态...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <FeishuLoginCard onBeforeLogin={markAuthPending} authError={authError} />;
  }

  return (
    <V2RealRoute
      userMenu={authUser ? <AccountMenu user={authUser} onLogout={handleLogout} /> : null}
    />
  );
}
