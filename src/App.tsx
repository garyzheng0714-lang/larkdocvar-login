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
  fetchTrustedLoginQrGoto,
  hasTrustedSession,
  mountTrustedLoginQr,
  tryFeishuClientTrustedLogin,
} from "./components/document-generator/cloudDoc/feishuTrustedLogin";
import {
  consumeEmbeddedAuthTokenFromHash,
  installEmbeddedAuthFetchFallback,
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

function AuthGate({ onReady }: { onReady: () => void }) {
  const [phase, setPhase] = useState<'checking' | 'choice' | 'qr' | 'error'>('checking');
  const [message, setMessage] = useState('正在接入飞书登录态...');
  const [qrGoto, setQrGoto] = useState('');
  const qrElementId = useMemo(() => `app-login-qr-${Math.random().toString(36).slice(2)}`, []);

  const startLogin = useCallback(async () => {
    setPhase('checking');
    setMessage('正在尝试飞书免登…');
    setQrGoto('');
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
      // 显式失败：把免登失败的具体原因显示出来 + 给扫码入口，不再卡在通用文案上。
      setPhase('choice');
      setMessage(attempt.reason || '飞书免登未完成。可重试，或改用扫码登录。');
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : '登录状态确认失败，请稍后重试。');
    }
  }, [onReady]);

  useEffect(() => {
    void startLogin();
  }, [startLogin]);

  useEffect(() => {
    if (!qrGoto || phase !== 'qr') return;
    let cancelled = false;
    mountTrustedLoginQr(qrElementId, qrGoto).catch((error) => {
      if (cancelled) return;
      setPhase('error');
      setMessage(error instanceof Error ? error.message : '登录二维码加载失败，请稍后重试。');
    });
    const timer = window.setInterval(() => {
      void hasTrustedSession().then((loggedIn) => {
        if (cancelled || !loggedIn) return;
        window.clearInterval(timer);
        onReady();
      }).catch(() => undefined);
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [onReady, phase, qrElementId, qrGoto]);

  const startQrLogin = useCallback(async () => {
    setPhase('checking');
    setMessage('正在准备扫码备用登录...');
    setQrGoto('');
    try {
      const goto = await fetchTrustedLoginQrGoto();
      setQrGoto(goto);
      setPhase('qr');
      setMessage('请用飞书扫码登录。登录完成后会自动进入插件。');
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : '登录二维码准备失败，请稍后重试。');
    }
  }, []);

  return (
    <div className="auth-gate">
      <div className="auth-gate-panel">
        <div className="auth-gate-title">使用飞书登录</div>
        <div className="auth-gate-message">{message}</div>
        {phase === 'choice' && (
          <div className="auth-gate-actions">
            <button className="auth-gate-primary" type="button" onClick={() => void startLogin()}>
              重新尝试飞书免登
            </button>
            <button className="auth-gate-secondary" type="button" onClick={() => void startQrLogin()}>
              扫码登录
            </button>
          </div>
        )}
        {phase === 'qr' && (
          <>
            <div className="auth-gate-qr-wrap">
              <div id={qrElementId} className="auth-gate-qr" />
            </div>
            <button className="auth-gate-secondary auth-gate-secondary-inline" type="button" onClick={() => void startLogin()}>
              重新尝试免登
            </button>
          </>
        )}
        {phase === 'error' && (
          <div className="auth-gate-actions">
            <button className="auth-gate-primary" type="button" onClick={() => void startLogin()}>
              重新尝试飞书免登
            </button>
            <button className="auth-gate-secondary" type="button" onClick={() => void startQrLogin()}>
              扫码登录
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
