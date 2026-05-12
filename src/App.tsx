import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { FeishuLoginCard } from "./components/FeishuLoginCard";
import {
  DocumentGeneratorApp,
  useBitable,
  useTemplates,
  MOCK_FIELDS,
  MOCK_TEMPLATES,
} from "./components/document-generator";

const SidebarApp = lazy(() => import("./SidebarApp"));

function useNewUI(): boolean {
  return useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get("ui") === "v2";
    } catch {
      return false;
    }
  }, []);
}

function useMockMode(): boolean {
  return useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get("mock") === "1";
    } catch {
      return false;
    }
  }, []);
}

function V2MockRoute({ userMenu }: { userMenu: ReactNode }) {
  return (
    <DocumentGeneratorApp
      userMenu={userMenu}
      fields={MOCK_FIELDS}
      templates={MOCK_TEMPLATES}
      selectedCount={6}
      bitableAvailable
    />
  );
}

function V2RealRoute({ userMenu }: { userMenu: ReactNode }) {
  const base = useBitable();
  const templates = useTemplates();
  return (
    <DocumentGeneratorApp
      userMenu={userMenu}
      fields={base.fields}
      templates={templates.items}
      selectedCount={base.selectedCount || base.totalRecordCount || 1}
      bitableAvailable={base.available}
      bitableError={base.error}
      templatesLoading={templates.loading}
      templatesError={templates.error}
      refreshTemplates={templates.refresh}
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

async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    credentials: "include",
    headers: new Headers(init?.headers),
  });
}

class WorkbenchErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("workbench load failed:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center px-6 text-center text-[14px] text-[#5f6670]">
          <div className="space-y-3">
            <div className="text-[#1f2329] font-medium">工作台加载失败，请刷新页面后重试。</div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="h-9 px-4 rounded-[6px] bg-[#255f89] text-white text-[13px] font-medium"
            >
              重新加载
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
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
        setAuthError(toErrorMessage(error));
      }
      setAuthUser(null);
      setIsAuthenticated(false);
    } finally {
      authCheckInFlightRef.current = false;
      setAuthLoading(false);
    }
  }, [clearAuthPendingFlag]);

  useEffect(() => {
    void checkAuthSession();
  }, [checkAuthSession]);

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

  const useV2 = useNewUI();
  const mockMode = useMockMode();

  if (useV2 && mockMode) {
    const mockUser: AuthUser = { openId: "mock_user", name: "演示账号", avatarUrl: undefined };
    return (
      <V2MockRoute
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

  if (useV2) {
    return (
      <V2RealRoute
        userMenu={authUser ? <AccountMenu user={authUser} onLogout={handleLogout} /> : null}
      />
    );
  }

  return (
    <WorkbenchErrorBoundary>
      <Suspense
        fallback={
          <div className="min-h-screen flex items-center justify-center text-[14px] text-[#5f6670]">
            正在加载工作台...
          </div>
        }
      >
        <SidebarApp initialAuthUser={authUser} />
      </Suspense>
    </WorkbenchErrorBoundary>
  );
}
