import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { FeishuLoginCard } from "./components/FeishuLoginCard";

const SidebarApp = lazy(() => import("./SidebarApp"));

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
