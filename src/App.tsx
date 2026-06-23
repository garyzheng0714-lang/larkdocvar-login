import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  DocumentGeneratorApp,
  CloudDocGeneratorApp,
  useBitable,
  useTemplates,
  useGenerateMock,
  useGenerateReal,
  MOCK_FIELDS,
  MOCK_TEMPLATES,
  MOCK_ROWS,
} from "./components/document-generator";
import {
  hasTrustedSession,
  pollOAuthHandoff,
  startOAuthHandoff,
  tryFeishuClientTrustedLogin,
} from "./components/document-generator/cloudDoc/feishuTrustedLogin";
import {
  consumeEmbeddedAuthTokenFromHash,
  installEmbeddedAuthFetchFallback,
  setStoredEmbeddedAuthToken,
} from "./authSessionToken";
import type { GeneratorKind, PrimaryState, RecordSpec } from "./components/document-generator";

installEmbeddedAuthFetchFallback();

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

function getInitialGeneratorKind(): GeneratorKind {
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("doc") || params.get("template");
    return value === "feishu" || value === "cloud" ? "feishu" : "word";
  } catch {
    return "word";
  }
}

function V2MockRoute({ userMenu, standalone = false }: { userMenu: ReactNode; standalone?: boolean }) {
  const runner = useGenerateMock();
  const [mockFields, setMockFields] = useState(MOCK_FIELDS);
  const [generatorKind, setGeneratorKind] = useState<GeneratorKind>(getInitialGeneratorKind);
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
  if (generatorKind === 'feishu') {
    const mockRecordIds = standalone ? ['manual-1'] : MOCK_ROWS.map((_, i) => `mock-${i + 1}`);
    return (
      <CloudDocGeneratorApp
        userMenu={userMenu}
        mode={standalone ? 'standalone' : 'bitable'}
        fields={standalone ? [] : mockFields}
        selectedRecordIds={standalone ? ['manual-1'] : mockRecordIds.slice(0, 6)}
        allRecordIds={mockRecordIds}
        selectedCount={standalone ? 1 : 6}
        totalRecordCount={standalone ? 1 : mockRecordIds.length}
        bitableAvailable={!standalone}
        demo
        generatorKind={generatorKind}
        onGeneratorKindChange={setGeneratorKind}
      />
    );
  }
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
      generatorKind={generatorKind}
      onGeneratorKindChange={setGeneratorKind}
    />
  );
}

function V2RealRoute({ userMenu }: { userMenu: ReactNode }) {
  const base = useBitable();
  const templates = useTemplates();
  const runner = useGenerateReal();
  const [generatorKind, setGeneratorKind] = useState<GeneratorKind>(getInitialGeneratorKind);
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
  if (generatorKind === 'feishu') {
    return (
      <CloudDocGeneratorApp
        userMenu={userMenu}
        mode={standalone ? 'standalone' : 'bitable'}
        fields={standalone ? [] : base.fields}
        activeTableId={standalone ? null : base.activeTableId}
        selectedRecordIds={standalone ? [] : base.selectedRecordIds}
        allRecordIds={standalone ? [] : base.allRecordIds}
        selectedCount={standalone ? 0 : base.selectedCount}
        totalRecordCount={standalone ? 0 : base.totalRecordCount}
        bitableAvailable={base.available}
        bitableError={standalone ? null : base.error}
        refreshBitable={base.refresh}
        generatorKind={generatorKind}
        onGeneratorKindChange={setGeneratorKind}
      />
    );
  }
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
      generatorKind={generatorKind}
      onGeneratorKindChange={setGeneratorKind}
    />
  );
}

// handoff 轮询参数：每 2s 轮询，5min 总超时（与后端 handoff TTL 对齐）。
const HANDOFF_POLL_INTERVAL_MS = 2000;
const HANDOFF_POLL_TIMEOUT_MS = 5 * 60 * 1000;

// open_id 截断展示：完整 id 太长，detail 里只留头尾便于真机肉眼区分两个 open_id。
function shortOpenId(value: string | undefined): string {
  if (!value) return '(空)';
  return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function AuthGate({ onReady }: { onReady: () => void }) {
  const [phase, setPhase] = useState<'checking' | 'choice' | 'waiting' | 'error'>('checking');
  const [message, setMessage] = useState('正在尝试飞书免登…');
  const [detail, setDetail] = useState('');
  const [handoffCode, setHandoffCode] = useState('');

  // 先试客户端内免登（真 H5 环境可能成功）；失败后给「飞书登录」(handoff) 主入口。
  const startLogin = useCallback(async () => {
    setPhase('checking');
    setMessage('正在尝试飞书免登…');
    setDetail('');
    setHandoffCode('');
    try {
      consumeEmbeddedAuthTokenFromHash();
      if (await hasTrustedSession()) {
        onReady();
        return;
      }
      const attempt = await tryFeishuClientTrustedLogin();
      if (attempt.ok) {
        onReady();
        return;
      }
      // 显式失败：把免登失败的具体原因 + 容器环境诊断显示出来 + 给飞书登录入口。
      setPhase('choice');
      setMessage(attempt.reason || '飞书免登未完成。可点击下方「飞书登录」继续。');
      setDetail(attempt.detail || '');
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : '登录状态确认失败，请稍后重试。');
    }
  }, [onReady]);

  // 开系统浏览器跑 OAuth + 进入轮询等待。
  const startHandoffLogin = useCallback(async () => {
    setPhase('checking');
    setMessage('正在打开飞书授权页…');
    setDetail('');
    try {
      const code = await startOAuthHandoff();
      setHandoffCode(code);
      setPhase('waiting');
      setMessage('已打开飞书授权页，完成后自动登录…');
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : '飞书登录准备失败，请稍后重试。');
    }
  }, []);

  useEffect(() => {
    void startLogin();
  }, [startLogin]);

  // waiting 阶段：每 2s 轮询 handoff，done 拿回 sessionToken；done/超时收尾。
  useEffect(() => {
    if (phase !== 'waiting' || !handoffCode) return;
    let cancelled = false;
    const deadline = Date.now() + HANDOFF_POLL_TIMEOUT_MS;
    const timer = window.setInterval(() => {
      if (Date.now() > deadline) {
        window.clearInterval(timer);
        if (!cancelled) {
          setPhase('error');
          setMessage('飞书登录超时，请重新点击「飞书登录」。');
        }
        return;
      }
      void pollOAuthHandoff(handoffCode).then((result) => {
        if (cancelled) return;
        if (result.status === 'done' && result.sessionToken) {
          window.clearInterval(timer);
          setStoredEmbeddedAuthToken(result.sessionToken);
          onReady();
          return;
        }
        if (result.status === 'rejected') {
          // open_id 不匹配：停止轮询、显示原因，detail 暴露两个 open_id 供真机诊断
          // （区分"防住接管"vs"Base 与 OAuth open_id 应用隔离误伤"），允许重新尝试。
          window.clearInterval(timer);
          setPhase('error');
          setMessage(result.reason || '飞书登录身份不一致，请重新点击「飞书登录」。');
          setDetail(`mismatch: base=${shortOpenId(result.expectedOpenId)} vs oauth=${shortOpenId(result.actualOpenId)}`);
          return;
        }
        if (result.status === 'expired' || result.status === 'unknown') {
          window.clearInterval(timer);
          setPhase('error');
          setMessage('飞书登录已失效，请重新点击「飞书登录」。');
        }
      }).catch(() => undefined);
    }, HANDOFF_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [handoffCode, onReady, phase]);

  return (
    <div className="auth-gate">
      <div className="auth-gate-panel">
        <div className="auth-gate-title">使用飞书登录</div>
        <div className="auth-gate-message">{message}</div>
        {detail && (
          <div style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5, color: '#8a9099', wordBreak: 'break-all' }}>
            {detail}
          </div>
        )}
        {phase === 'choice' && (
          <div className="auth-gate-actions">
            <button className="auth-gate-primary" type="button" onClick={() => void startHandoffLogin()}>
              飞书登录
            </button>
            <button className="auth-gate-secondary" type="button" onClick={() => void startLogin()}>
              重新尝试免登
            </button>
          </div>
        )}
        {phase === 'waiting' && (
          <div className="auth-gate-actions">
            <button className="auth-gate-primary" type="button" onClick={() => void startHandoffLogin()}>
              重新打开授权
            </button>
            <button className="auth-gate-secondary" type="button" onClick={() => void startLogin()}>
              重新尝试免登
            </button>
          </div>
        )}
        {phase === 'error' && (
          <div className="auth-gate-actions">
            <button className="auth-gate-primary" type="button" onClick={() => void startHandoffLogin()}>
              飞书登录
            </button>
            <button className="auth-gate-secondary" type="button" onClick={() => void startLogin()}>
              重新尝试免登
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const mockMode = useMockMode();
  const standalonePreview = useStandalonePreviewMode();
  const [authReady, setAuthReady] = useState(false);

  if (mockMode) {
    return (
      <V2MockRoute
        standalone={standalonePreview}
        userMenu={null}
      />
    );
  }

  if (!authReady) {
    return <AuthGate onReady={() => setAuthReady(true)} />;
  }

  return (
    <V2RealRoute
      userMenu={null}
    />
  );
}
