import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { Dropdown } from './Dropdown';
import { copyTextToClipboard } from './clipboard';
import { buildOptionalBitableSidebarHeaders } from './cloudDoc/bitableAdapter';
import {
  fetchTrustedLoginQrGoto,
  hasTrustedSession,
  mountTrustedLoginQr,
  tryFeishuClientTrustedLogin,
} from './cloudDoc/feishuTrustedLogin';
import type { Template } from './types';

interface SelectedFile {
  name: string;
  size: number;
  file: File;
}

interface NewTemplateScreenProps {
  accent: string;
  template?: Template | null;
  onCancel: () => void;
  onSave: () => void | Promise<void>;
}

export function NewTemplateScreen({ accent, template, onCancel, onSave }: NewTemplateScreenProps) {
  const isEditing = Boolean(template);
  const [file, setFile] = useState<SelectedFile | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(template?.name || '');
  const [category, setCategory] = useState(template?.category && template.category !== '全部' ? template.category : '合同类');
  const [visibility, setVisibility] = useState<'公用' | '个人'>(template?.visibility === 'shared' ? '公用' : '个人');
  const [desc, setDesc] = useState(template?.description || '');
  const [tipOpen, setTipOpen] = useState(false);
  const [copyNotice, setCopyNotice] = useState<'ok' | 'error' | null>(null);
  const [loginPrompt, setLoginPrompt] = useState<{
    phase: 'loading' | 'ready' | 'error' | 'done';
    message: string;
    goto?: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const qrElementIdRef = useRef(`nt-login-qr-${Math.random().toString(36).slice(2)}`);
  const retrySaveAfterLoginRef = useRef(false);

  function handleFiles(fileList: FileList | null) {
    const f = fileList?.[0];
    if (!f) return;
    setError(null);
    if (!/\.docx$/i.test(f.name)) {
      setError('请选择 .docx 文件（暂不支持 .doc 旧格式）');
      return;
    }
    if (f.size > 20 * 1024 * 1024) {
      setError('模板文件不能超过 20MB');
      return;
    }
    if (!name) setName(f.name.replace(/\.docx?$/i, ''));
    setFile({ name: f.name, size: f.size, file: f });
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.classList.remove('is-drag');
    handleFiles(e.dataTransfer.files);
  }
  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.classList.add('is-drag');
  }
  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.currentTarget.classList.remove('is-drag');
  }

  const canSave = !!file && name.trim().length > 0;

  useEffect(() => {
    if (!loginPrompt?.goto) return;
    let cancelled = false;
    mountTrustedLoginQr(qrElementIdRef.current, loginPrompt.goto).catch((err) => {
      if (cancelled) return;
      setLoginPrompt({
        phase: 'error',
        message: err instanceof Error ? err.message : '登录二维码加载失败，请稍后重试。',
      });
    });

    const deadline = Date.now() + 90_000;
    const timer = window.setInterval(() => {
      if (Date.now() > deadline) {
        window.clearInterval(timer);
        if (!cancelled) {
          retrySaveAfterLoginRef.current = false;
          setLoginPrompt({
            phase: 'error',
            message: '扫码登录超时，当前文件和填写内容已保留，请重新点击保存。',
          });
        }
        return;
      }
      void hasTrustedSession().then((loggedIn) => {
        if (!loggedIn || cancelled) return;
        window.clearInterval(timer);
        setLoginPrompt({ phase: 'done', message: '登录已完成，正在继续保存...' });
        if (retrySaveAfterLoginRef.current) {
          retrySaveAfterLoginRef.current = false;
          void saveTemplate();
        }
      }).catch(() => undefined);
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loginPrompt?.goto]);

  async function ensureTrustedSessionForTemplateSave(): Promise<boolean> {
    if (await hasTrustedSession()) {
      setLoginPrompt(null);
      return true;
    }
    if (await tryFeishuClientTrustedLogin()) {
      setLoginPrompt(null);
      return true;
    }

    retrySaveAfterLoginRef.current = true;
    setLoginPrompt({ phase: 'loading', message: '正在准备可信登录...' });
    try {
      const goto = await fetchTrustedLoginQrGoto();
      setLoginPrompt({
        phase: 'ready',
        message: '请用飞书扫码完成登录。当前文件和填写内容会保留，登录后会继续保存。',
        goto,
      });
    } catch (err) {
      retrySaveAfterLoginRef.current = false;
      setLoginPrompt({
        phase: 'error',
        message: err instanceof Error ? err.message : '请先完成可信登录后再管理模板。当前文件和填写内容已保留。',
      });
    }
    return false;
  }

  async function saveTemplate() {
    if (!file || !canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (!await ensureTrustedSessionForTemplateSave()) {
        setError('请先完成可信登录后再管理模板。当前文件和填写内容已保留。');
        return;
      }
      const fileBase64 = await readFileAsBase64(file.file);
      const endpoint = template
        ? `/api/v1/document-templates/${encodeURIComponent(template.id)}/versions`
        : '/api/v1/document-templates';
      const sidebarHeaders = await buildOptionalBitableSidebarHeaders();
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...sidebarHeaders },
        body: JSON.stringify({
          name: name.trim(),
          fileName: file.name,
          fileBase64,
          category,
          visibility: visibility === '个人' ? 'private' : 'shared',
          description: isEditing ? desc.trim() : desc.trim() || undefined,
        }),
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error || '模板保存失败，请稍后重试。');
      }
      await onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : '模板保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  async function copyTemplateId() {
    if (!template) return;
    try {
      await copyTextToClipboard(template.id);
      setCopyNotice('ok');
    } catch {
      setCopyNotice('error');
    }
    window.setTimeout(() => setCopyNotice(null), 1400);
  }

  return (
    <div className="screen nt-screen">
      <header className="hdr hdr-with-back">
        <button className="hdr-icon" type="button" onClick={onCancel}><Icon.Back /></button>
        <div className="hdr-title">{isEditing ? '更新模板' : '新建模板'}</div>
        <span style={{ width: 28 }} />
      </header>

      <div className="scroll nt-scroll">
        {template && (
          <div className="nt-id-card">
            <div className="nt-id-main">
              <span className="nt-id-label">模板 ID</span>
              <code>{template.id}</code>
            </div>
            <button
              className="nt-id-copy"
              type="button"
              onClick={copyTemplateId}
              title={`复制模板 ID：${template.id}`}
            >
              <Icon.Copy />
              <span>{copyNotice === 'ok' ? '已复制' : copyNotice === 'error' ? '复制失败' : '复制'}</span>
            </button>
          </div>
        )}

        {!file ? (
          <div className="block nt-block-top">
            <div
              className="nt-drop"
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onClick={() => inputRef.current?.click()}
            >
              <div className="nt-drop-glyph"><DocxGlyph /></div>
              <div className="nt-drop-title">
                {isEditing ? '拖入或点击选择新的 .docx 文件' : '拖入或点击选择 .docx 文件'}
              </div>
              <div className="nt-drop-hint">单文件 ≤ 20MB</div>
              <input
                ref={inputRef}
                type="file"
                accept=".docx"
                style={{ display: 'none' }}
                onChange={(e) => handleFiles(e.target.files)}
              />
            </div>

            <button
              type="button"
              className={'nt-tip' + (tipOpen ? ' is-open' : '')}
              onClick={() => setTipOpen((o) => !o)}
            >
              <Icon.Help />
              <span>如何在 Word 中编写变量？</span>
              <Icon.Chevron className="nt-tip-chev" />
            </button>
            {tipOpen && (
              <div className="nt-tip-body">
                在 Word 文档中，把需要被替换的位置用双花括号包起来，如：
                <div className="nt-tip-code">
                  甲方：<b className="mono">{'{{客户名称}}'}</b><br />
                  合同金额：<b className="mono">{'{{合同金额}}'}</b> 元<br />
                  图片：<b className="mono">{'{{image:客户Logo}}'}</b>
                </div>
                上传后系统会自动识别所有变量。
              </div>
            )}
          </div>
        ) : (
          <div className="block nt-block-top">
            <div className="nt-file">
              <div className="nt-file-icon"><DocxGlyph /></div>
              <div className="nt-file-info">
                <div className="nt-file-name">{file.name}</div>
                <div className="nt-file-meta">
                  <span>{prettyBytes(file.size)}</span>
                  <span className="dot-sep" />
                  <span>保存后自动识别变量</span>
                </div>
              </div>
              <button
                type="button"
                className="nt-file-replace"
                onClick={() => {
                  setFile(null);
                  if (inputRef.current) inputRef.current.value = '';
                }}
                title="重新上传"
              >
                <Icon.Close />
              </button>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".docx"
              style={{ display: 'none' }}
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>
        )}

        <div className="block">
          <div className="nt-field">
            <label className="nt-label">
              模板名称<span className="nt-req">*</span>
            </label>
            <input
              className="nt-input"
              placeholder="例如：标准商业合同模板"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="nt-field">
            <label className="nt-label">分类</label>
            <CategorySelect value={category} onChange={setCategory} />
          </div>

          <div className="nt-field">
            <label className="nt-label">可见范围</label>
            <div className="nt-segment">
              <button
                type="button"
                className={'nt-seg' + (visibility === '个人' ? ' nt-seg-on' : '')}
                onClick={() => setVisibility('个人')}
              >
                <Icon.User /> 仅自己
              </button>
              <button
                type="button"
                className={'nt-seg' + (visibility === '公用' ? ' nt-seg-on' : '')}
                onClick={() => setVisibility('公用')}
              >
                <Icon.Team /> 团队共享
              </button>
            </div>
          </div>

          <div className="nt-field">
            <label className="nt-label">
              说明 <span className="nt-opt">（选填）</span>
            </label>
            <textarea
              className="nt-input nt-textarea"
              placeholder="简单描述这个模板的用途"
              rows={2}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
          </div>
        </div>

        {file && (
          <div className="block">
            <div className="block-head">
              <span className="block-title">识别到的变量</span>
              <span className="block-count">保存后更新</span>
            </div>
            <div className="nt-vars-hint">
              {isEditing
                ? '系统会保存为这个模板的新版本，模板 ID 保持不变。'
                : '系统会在保存模板时读取 Word 占位符，保存完成后可绑定字段。'}
            </div>
          </div>
        )}

        {error && <div className="nt-error">{error}</div>}

        {loginPrompt && (
          <div className={`nt-login-card nt-login-${loginPrompt.phase}`}>
            <div className="nt-login-title">可信登录</div>
            <div className="nt-login-message">{loginPrompt.message}</div>
            {loginPrompt.goto && loginPrompt.phase === 'ready' && (
              <div className="nt-login-qr-wrap">
                <div id={qrElementIdRef.current} className="nt-login-qr" />
              </div>
            )}
            {loginPrompt.phase === 'error' && (
              <button
                type="button"
                className="nt-login-retry"
                onClick={() => {
                  setLoginPrompt(null);
                  void saveTemplate();
                }}
              >
                重新登录
              </button>
            )}
          </div>
        )}

        <div style={{ height: 8 }} />
      </div>

      <footer className="picker-ftr">
        <button className="btn-ghost" type="button" onClick={onCancel}>取消</button>
        <button
          className="btn-primary"
          type="button"
          style={{ background: canSave && !saving ? accent : '#c8ccd2' }}
          disabled={!canSave || saving}
          onClick={saveTemplate}
        >
          {saving ? '保存中...' : isEditing ? '保存新版本' : '保存模板'}
        </button>
      </footer>
    </div>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('模板文件读取失败，请重新选择。'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

function CategorySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const options = ['合同类', '通知类', '证书类', '报表类', '发票类', '其他'];
  return (
    <div className="nt-select">
      <button
        ref={ref}
        type="button"
        className="nt-input nt-select-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        <span>{value}</span>
        <Icon.Chevron style={{ opacity: 0.5, marginLeft: 'auto' }} />
      </button>
      <Dropdown
        open={open}
        onClose={() => setOpen(false)}
        align="left"
        width={200}
        triggerRef={ref}
      >
        {options.map((o) => (
          <button
            key={o}
            type="button"
            className={'dd-item' + (o === value ? ' dd-item-on' : '')}
            onClick={() => {
              onChange(o);
              setOpen(false);
            }}
          >
            <span style={{ flex: 1, textAlign: 'left' }}>{o}</span>
            {o === value && <Icon.Check />}
          </button>
        ))}
      </Dropdown>
    </div>
  );
}

function DocxGlyph() {
  return (
    <svg viewBox="0 0 40 48" width="40" height="48">
      <defs>
        <linearGradient id="ntg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#eef2fb" />
        </linearGradient>
      </defs>
      <rect x="3" y="2" width="34" height="44" rx="3" fill="url(#ntg)" stroke="#c9d2e3" />
      <path d="M27 2v8h10" fill="none" stroke="#c9d2e3" />
      <rect x="8" y="20" width="20" height="2" rx="1" fill="#cbd3e1" />
      <rect x="8" y="25" width="24" height="2" rx="1" fill="#dde2ec" />
      <rect x="8" y="30" width="16" height="2" rx="1" fill="#dde2ec" />
      <rect x="8" y="36" width="8" height="3.5" rx="1" fill="#2b5fed" />
      <text x="17" y="39.4" fontSize="3.5" fill="#2b5fed" fontWeight="700" fontFamily="sans-serif">
        DOCX
      </text>
    </svg>
  );
}

function prettyBytes(n: number) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
