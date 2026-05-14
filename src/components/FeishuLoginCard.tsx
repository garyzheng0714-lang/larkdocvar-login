// 飞书登录卡片（按钮 + 角标切扫码）— FBIF v3 视觉规范
// 视觉值参考 ~/.claude/skills/feishu-login-guide/assets/login-ui-spec.md
// 路由保持项目约定：/auth/feishu/{fbif,fude}/{login,qr-config,qr-callback}

import { useCallback, useEffect, useRef, useState } from "react";

type LoginOrg = "fbif" | "fude";

const LOGIN_ORGS: Record<LoginOrg, {
  label: string;
  loginUrl: string;
  qrConfigUrl: string;
}> = {
  fbif: {
    label: "FBIF",
    loginUrl: "/auth/feishu/fbif/login",
    qrConfigUrl: "/auth/feishu/fbif/qr-config",
  },
  fude: {
    label: "富的",
    loginUrl: "/auth/feishu/fude/login",
    qrConfigUrl: "/auth/feishu/fude/qr-config",
  },
};

const FEISHU_QR_SDK_URL =
  "https://lf-package-cn.feishucdn.com/obj/feishu-static/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.3.js";

const C = {
  brandBlue: "#255f89",
  brandBlueHover: "#1f5278",
  brandBlueActive: "#194562",
  surface: "#ffffff",
  pageStart: "#f4f7fa",
  pageEnd: "#fafbfc",
  border: "#e5e9f0",
  textPrimary: "#12243a",
  textMuted: "#728196",
} as const;

declare global {
  interface Window {
    QRLogin?: (opts: {
      id: string;
      goto: string;
      width?: string;
      height?: string;
      style?: string;
    }) => {
      matchOrigin: (origin: string) => boolean;
      matchData: (data: unknown) => boolean;
    };
  }
}

let qrSdkPromise: Promise<void> | null = null;

function loadFeishuQRSdk(): Promise<void> {
  if (qrSdkPromise) return qrSdkPromise;
  if (typeof window !== "undefined" && window.QRLogin) {
    qrSdkPromise = Promise.resolve();
    return qrSdkPromise;
  }
  qrSdkPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${FEISHU_QR_SDK_URL}"]`,
    );
    if (existing) {
      if (window.QRLogin) {
        resolve();
      } else {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener(
          "error",
          () => reject(new Error("QR SDK load failed")),
          { once: true },
        );
      }
      return;
    }
    const s = document.createElement("script");
    s.src = FEISHU_QR_SDK_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      qrSdkPromise = null;
      reject(new Error("QR SDK load failed"));
    };
    document.head.appendChild(s);
  });
  return qrSdkPromise;
}

function FeishuLogo({ size = 20 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M891.306667 340.821333c4.906667 0 9.728 0.298667 14.634666 0.853334a409.941333 409.941333 0 0 1 108.8 30.037333c10.112 4.522667 12.629333 8.192 3.968 17.322667a351.146667 351.146667 0 0 0-61.013333 89.984c-16.810667 35.328-35.072 69.845333-52.266667 105.002666A225.28 225.28 0 0 1 853.333333 653.44c-53.632 48.512-116.181333 68.992-187.562666 59.093333-81.92-11.306667-159.445333-38.954667-232.704-75.477333a141.738667 141.738667 0 0 1-10.496-5.461333 5.376 5.376 0 0 1-1.706667-7.338667 5.333333 5.333333 0 0 1 2.005333-1.877333l5.12-2.730667c59.264-31.658667 108.842667-75.861333 156.544-122.282667 20.181333-19.541333 39.466667-40.021333 59.904-59.306666a344.96 344.96 0 0 1 160.170667-85.802667c13.184-3.242667 26.538667-5.802667 39.808-8.661333h0.554667l28.245333-2.56"
        fill="#133C9A"
      />
      <path
        d="M317.653333 913.834667c-8.96-0.512-31.146667-3.584-33.877333-3.968a536.576 536.576 0 0 1-165.077333-48.256c-30.208-14.08-59.221333-30.72-88.32-46.933334-19.2-10.666667-27.818667-27.306667-27.690667-49.92 0.597333-83.370667 0.597333-166.741333 0-250.154666C2.432 461.013333 0.725333 407.381333 0 353.706667c0-4.736 0.725333-9.514667 2.176-13.909334 3.328-9.728 9.984-10.24 16.554667-3.925333 7.594667 7.296 13.653333 16.213333 21.205333 23.381333 67.285333 66.432 138.752 127.189333 218.752 177.237334a1207.765333 1207.765333 0 0 0 140.458667 77.397333c77.738667 35.328 157.525333 66.474667 241.066666 86.186667 73.898667 17.493333 145.621333 6.485333 205.482667-40.362667 18.261333-15.616 27.264-27.050667 48.896-55.893333-9.642667 25.642667-22.186667 50.090667-37.376 72.874666-13.866667 21.973333-45.312 51.2-69.162667 74.112-36.266667 35.114667-83.754667 63.573333-128.298666 87.552-48.554667 26.154667-99.029333 47.104-152.96 58.496-27.648 6.954667-67.584 14.848-81.322667 15.573334-2.432-0.128-10.666667 1.706667-14.848 1.408-35.541333 2.645333-57.472 3.669333-92.885333 0h-0.085334z"
        fill="#3370FF"
      />
      <path
        d="M165.12 110.506667a52.48 52.48 0 0 1 7.424 0c152.661333 0 304.128 2.474667 456.618667 2.474666 0.298667 0 0.597333 0 0.725333 0.213334 14.208 12.373333 27.306667 25.770667 39.296 40.192 34.432 34.218667 60.16 93.610667 77.653333 129.706666 8.789333 25.045333 21.973333 48.896 28.16 76.8v0.469334c-15.573333 5.034667-30.72 11.178667-45.312 18.517333-44.202667 22.357333-64.213333 38.741333-100.821333 74.752-19.968 19.498667-36.992 37.077333-63.488 62.08-9.6 9.344-19.498667 18.346667-29.738667 26.922667-7.04-12.416-125.738667-244.608-364.245333-427.306667"
        fill="#00D6B9"
      />
    </svg>
  );
}

function QrIcon({ size = 20, color = "#ffffff" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 3h7v7H3V3zm2 2v3h3V5H5zm9-2h7v7h-7V3zm2 2v3h3V5h-3zM3 14h7v7H3v-7zm2 2v3h3v-3H5zm11-2h2v2h-2v-2zm0 3h2v2h-2v-2zm3-3h2v5h-2v-5zm-3 6h2v2h-2v-2zm3 0h2v2h-2v-2z"
        fill={color}
      />
    </svg>
  );
}

function MonitorIcon({ size = 20, color = "#ffffff" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5v2h2a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h2v-2H5a2 2 0 0 1-2-2V5zm2 0v10h14V5H5z"
        fill={color}
      />
    </svg>
  );
}

function LoginButton({
  org,
  variant,
  onBeforeLogin,
}: {
  org: LoginOrg;
  variant: "primary" | "secondary";
  onBeforeLogin?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const config = LOGIN_ORGS[org];
  const isPrimary = variant === "primary";
  const bg = isPrimary
    ? active
      ? C.brandBlueActive
      : hover
        ? C.brandBlueHover
        : C.brandBlue
    : hover
      ? "#f3f7fb"
      : C.surface;

  const handleClick = () => {
    if (onBeforeLogin) onBeforeLogin();
    window.location.href = config.loginUrl;
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setActive(false);
      }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      className="w-full flex items-center justify-center"
      style={{
        height: 52,
        gap: 12,
        padding: "0 18px",
        border: isPrimary ? 0 : `1px solid ${C.border}`,
        borderRadius: 10,
        background: bg,
        color: isPrimary ? "#ffffff" : C.textPrimary,
        fontSize: 15,
        fontWeight: 600,
        lineHeight: 1,
        cursor: "pointer",
        boxShadow: isPrimary
          ? hover
            ? "0 2px 5px rgba(37, 95, 137, 0.18)"
            : "0 1px 2px rgba(37, 95, 137, 0.18)"
          : "none",
        transition:
          "transform 140ms ease, background-color 140ms ease, box-shadow 140ms ease",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          flex: "0 0 auto",
          display: "grid",
          placeItems: "center",
          borderRadius: "999px",
          background: "#ffffff",
          boxShadow:
            "0 1px 2px rgba(15, 31, 51, 0.1), inset 0 0 0 1px rgba(15, 31, 51, 0.04)",
        }}
      >
        <FeishuLogo size={20} />
      </span>
      <span>使用 {config.label} 飞书登录</span>
    </button>
  );
}

function CornerBadge({
  mode,
  onClick,
}: {
  mode: "qr" | "oauth";
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const showQr = mode === "oauth";
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={showQr ? "切换到扫码登录" : "切换到账号登录"}
      title={showQr ? "扫码登录" : "账号登录"}
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        width: 56,
        height: 56,
        padding: 0,
        border: 0,
        background: hover ? C.brandBlueHover : C.brandBlue,
        cursor: "pointer",
        clipPath: "polygon(100% 0, 0 0, 100% 100%)",
        borderTopRightRadius: 16,
        transition: "background-color 140ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          display: "block",
          lineHeight: 0,
        }}
      >
        {showQr ? <QrIcon /> : <MonitorIcon />}
      </span>
    </button>
  );
}

interface QRConfigResponse {
  goto: string;
  state: string;
  expires_in?: number;
}

function QRView({
  org,
  onOrgChange,
  onSwitchToOAuth,
}: {
  org: LoginOrg;
  onOrgChange: (org: LoginOrg) => void;
  onSwitchToOAuth: () => void;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "expired" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gotoRef = useRef("");
  const handlerRef = useRef<((e: MessageEvent) => void) | null>(null);
  const expireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadKey = useRef(0);

  const cleanup = useCallback(() => {
    if (handlerRef.current) {
      window.removeEventListener("message", handlerRef.current);
      handlerRef.current = null;
    }
    if (expireTimerRef.current) {
      clearTimeout(expireTimerRef.current);
      expireTimerRef.current = null;
    }
    if (containerRef.current) containerRef.current.innerHTML = "";
  }, []);

  const initQr = useCallback(async () => {
    setStatus("loading");
    setErrorMsg("");
    cleanup();
    try {
      const resp = await fetch(LOGIN_ORGS[org].qrConfigUrl, { credentials: "include" });
      if (!resp.ok) throw new Error(`qr-config ${resp.status}`);
      const cfg = (await resp.json()) as QRConfigResponse;
      if (!cfg.goto) throw new Error("qr-config missing goto");
      gotoRef.current = cfg.goto;

      await loadFeishuQRSdk();
      if (!window.QRLogin) throw new Error("QRLogin not on window");

      if (!containerRef.current) return;
      const containerId = `feishu_qr_container_${++reloadKey.current}`;
      containerRef.current.innerHTML = `<div id="${containerId}" style="width:240px;height:240px;display:flex;align-items:center;justify-content:center"></div>`;

      const obj = window.QRLogin({
        id: containerId,
        goto: cfg.goto,
        width: "240",
        height: "240",
        style: "width:240px;height:240px",
      });

      const handler = (event: MessageEvent) => {
        if (!obj.matchOrigin(event.origin)) return;
        if (!obj.matchData(event.data)) return;
        const data = event.data as { tmp_code?: string };
        if (!data.tmp_code) return;
        window.location.href = `${gotoRef.current}&tmp_code=${encodeURIComponent(data.tmp_code)}`;
      };
      handlerRef.current = handler;
      window.addEventListener("message", handler);

      const ttlMs = (cfg.expires_in ? cfg.expires_in : 300) * 1000 - 10000;
      if (ttlMs > 0) {
        expireTimerRef.current = setTimeout(() => setStatus("expired"), ttlMs);
      }
      setStatus("ready");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("feishu qr init failed:", err);
      setErrorMsg("二维码加载失败，请稍后重试。");
      setStatus("error");
    }
  }, [cleanup, org]);

  useEffect(() => {
    initQr();
    return cleanup;
  }, [initQr, cleanup]);

  return (
    <>
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: C.textPrimary,
          margin: "8px 0 8px",
          textAlign: "center",
        }}
      >
        扫码登录
      </div>
      <div
        style={{
          fontSize: 13,
          color: C.textMuted,
          margin: "0 0 16px",
          textAlign: "center",
        }}
      >
        请使用飞书移动端扫描二维码
      </div>

      <div
        role="tablist"
        aria-label="选择飞书组织"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 4,
          width: 180,
          padding: 4,
          marginBottom: 16,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          background: "#f7f9fb",
        }}
      >
        {(Object.keys(LOGIN_ORGS) as LoginOrg[]).map((key) => {
          const selected = key === org;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onOrgChange(key)}
              style={{
                height: 30,
                border: 0,
                borderRadius: 6,
                background: selected ? C.brandBlue : "transparent",
                color: selected ? "#ffffff" : C.textPrimary,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {LOGIN_ORGS[key].label}
            </button>
          );
        })}
      </div>

      <div
        style={{
          position: "relative",
          width: 260,
          height: 260,
          padding: 10,
          background: "#f7f9fb",
          borderRadius: 12,
          display: "grid",
          placeItems: "center",
        }}
      >
        <div
          ref={containerRef}
          style={{ width: 240, height: 240, display: "grid", placeItems: "center" }}
        />

        {(status === "loading" || status === "error") && (
          <div
            style={{
              position: "absolute",
              inset: 10,
              borderRadius: 8,
              background: "rgba(247, 249, 251, 0.85)",
              display: "grid",
              placeItems: "center",
              fontSize: 13,
              color: status === "error" ? "#c53030" : C.textMuted,
              padding: 16,
              textAlign: "center",
            }}
          >
            {status === "loading" ? "加载二维码中…" : errorMsg}
            {status === "error" && (
              <button
                type="button"
                onClick={initQr}
                style={{
                  marginTop: 12,
                  padding: "6px 14px",
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  background: C.surface,
                  color: C.textPrimary,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                重试
              </button>
            )}
          </div>
        )}

        {status === "expired" && (
          <button
            type="button"
            onClick={initQr}
            style={{
              position: "absolute",
              inset: 10,
              borderRadius: 8,
              background: "rgba(18, 36, 58, 0.55)",
              border: 0,
              cursor: "pointer",
              color: "#ffffff",
              fontSize: 14,
              fontWeight: 500,
            }}
            aria-label="刷新二维码"
          >
            刷新二维码
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onSwitchToOAuth}
        style={{
          marginTop: 24,
          background: "transparent",
          border: 0,
          padding: 0,
          color: C.brandBlue,
          fontSize: 13,
          fontWeight: 500,
          cursor: "pointer",
        }}
      >
        使用账号登录
      </button>
    </>
  );
}

export interface FeishuLoginCardProps {
  /** 登录前的预备工作（例如 markAuthPending） */
  onBeforeLogin?: () => void;
  /** 顶部错误信息（登录回调或 session 检查失败） */
  authError?: string | null;
}

export function FeishuLoginCard({ onBeforeLogin, authError }: FeishuLoginCardProps) {
  const [mode, setMode] = useState<"oauth" | "qr">("oauth");
  const [org, setOrg] = useState<LoginOrg>("fbif");

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6 py-8"
      style={{
        background: `linear-gradient(180deg, ${C.pageStart} 0%, ${C.pageEnd} 100%)`,
        color: C.textPrimary,
        fontFamily:
          'Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", Arial, sans-serif',
      }}
    >
      <main
        className="relative flex flex-col items-center w-full"
        style={{
          maxWidth: 420,
          padding: "40px 32px",
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 16,
          boxShadow:
            "0 1px 3px rgba(15, 31, 51, 0.04), 0 8px 24px rgba(15, 31, 51, 0.04)",
          overflow: "hidden",
        }}
      >
        <CornerBadge
          mode={mode}
          onClick={() => setMode(mode === "oauth" ? "qr" : "oauth")}
        />

        {authError ? (
          <div className="mb-4 w-full rounded-[10px] bg-[#fff1f0] text-[#f54a45] px-3 py-2 text-[13px] border border-[#ffd6d3]">
            登录失败：{authError}
          </div>
        ) : null}

        {mode === "oauth" ? (
          <>
            <img
              src="/fbif-logo.webp"
              alt="FBIF"
              width={120}
              height={120}
              style={{ display: "block", objectFit: "contain", marginBottom: 20 }}
            />
            <div className="w-full flex flex-col gap-3">
              <LoginButton org="fbif" variant="primary" onBeforeLogin={onBeforeLogin} />
              <LoginButton org="fude" variant="secondary" onBeforeLogin={onBeforeLogin} />
            </div>
          </>
        ) : (
          <QRView org={org} onOrgChange={setOrg} onSwitchToOAuth={() => setMode("oauth")} />
        )}
      </main>
    </div>
  );
}
