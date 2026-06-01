import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon, FieldTypeIcon } from './icons';
import { Dropdown } from './Dropdown';
import { CUSTOM_MAPPING_VALUE } from './mapping';
import type { TableField, TemplateVariable } from './types';

export function DocThumb() {
  return (
    <svg viewBox="0 0 40 48" width="100%" height="100%">
      <defs>
        <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#f6f7fa" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="36" height="44" rx="3" fill="url(#pg)" stroke="#dfe2e7" />
      <path d="M28 2v8h10" fill="none" stroke="#dfe2e7" />
      <rect x="6" y="6" width="14" height="2.5" rx="1" fill="#2b5fed" opacity=".75" />
      {[14, 19, 24, 29, 34, 39].map((y, i) => (
        <rect
          key={i}
          x="6"
          y={y}
          width={i % 3 === 2 ? 16 : 28}
          height="1.6"
          rx=".8"
          fill="#dde1e8"
        />
      ))}
    </svg>
  );
}

interface MapRowProps {
  variable: TemplateVariable;
  fields: TableField[];
  mode?: 'bitable' | 'standalone';
  value: string | undefined;
  onChange: (fid: string) => void;
  customText: string | undefined;
  onCustomText: (t: string) => void;
}

export function MapRow({ variable, fields, mode = 'bitable', value, onChange, customText, onCustomText }: MapRowProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const isImage = variable.kind === 'image';
  const candidates = fields.filter((f) =>
    isImage ? f.type === 'attachment' : f.type !== 'attachment',
  );
  const selected = fields.find((f) => f.id === value);
  const isCustom = value === CUSTOM_MAPPING_VALUE;
  const bindMode = isCustom ? 'fixed' : 'field';
  const filteredCandidates = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return candidates;
    return candidates.filter((field) => field.name.toLowerCase().includes(keyword));
  }, [candidates, query]);

  useEffect(() => {
    if (open) return;
    setQuery('');
  }, [open]);

  function switchBindMode(nextMode: 'field' | 'fixed') {
    setOpen(false);
    if (nextMode === 'fixed') {
      onChange(CUSTOM_MAPPING_VALUE);
      return;
    }
    if (isCustom) onChange('');
  }

  if (mode === 'standalone') {
    return (
      <div className="mapping-card mapping-card-manual">
        <div className="mapping-head">
          <span className="mapping-label">
            {variable.name}
            <span className="mapping-required">*</span>
          </span>
        </div>
        {isImage ? (
          <textarea
            className="custom-input mapping-fixed-input mapping-fixed-textarea"
            placeholder="输入图片 URL，多个 URL 可用换行分隔"
            value={customText || ''}
            rows={3}
            onChange={(e) => {
              if (value !== CUSTOM_MAPPING_VALUE) onChange(CUSTOM_MAPPING_VALUE);
              onCustomText(e.target.value);
            }}
          />
        ) : (
          <input
            className="custom-input mapping-fixed-input"
            placeholder="输入固定值"
            value={customText || ''}
            onChange={(e) => {
              if (value !== CUSTOM_MAPPING_VALUE) onChange(CUSTOM_MAPPING_VALUE);
              onCustomText(e.target.value);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="mapping-card">
      <div className="mapping-head">
        <span className="mapping-label">
          {variable.name}
          <span className="mapping-required">*</span>
        </span>
        <div className="mapping-mode-switch" role="tablist" aria-label={`${variable.name}绑定方式`}>
          <button
            className={'mapping-mode-option' + (bindMode === 'field' ? ' is-active' : '')}
            type="button"
            role="tab"
            aria-selected={bindMode === 'field'}
            onClick={() => switchBindMode('field')}
          >
            字段
          </button>
          <button
            className={'mapping-mode-option' + (bindMode === 'fixed' ? ' is-active' : '')}
            type="button"
            role="tab"
            aria-selected={bindMode === 'fixed'}
            onClick={() => switchBindMode('fixed')}
          >
            固定值
          </button>
        </div>
      </div>
      <div className="mapping-control">
        {bindMode === 'fixed' ? (
          isImage ? (
            <textarea
              className="custom-input mapping-fixed-input mapping-fixed-textarea"
              placeholder="输入图片 URL，多个 URL 可用换行分隔"
              value={customText || ''}
              rows={3}
              onChange={(e) => onCustomText(e.target.value)}
            />
          ) : (
            <input
              className="custom-input mapping-fixed-input"
              placeholder="输入固定值"
              value={customText || ''}
              onChange={(e) => onCustomText(e.target.value)}
            />
          )
        ) : (
          <>
            <button
              ref={triggerRef}
              type="button"
              className={
                'fld-trigger mapping-field-trigger'
                + (open ? ' is-open' : '')
                + (!selected ? ' fld-empty' : '')
              }
              onClick={() => {
                setOpen((o) => !o);
              }}
            >
              {selected ? (
                <span className="fld-name">{selected.name}</span>
              ) : (
                <span className="fld-placeholder">未选择</span>
              )}
              <Icon.Chevron style={{ marginLeft: 'auto', opacity: 0.5 }} />
            </button>
            <Dropdown
              open={open}
              onClose={() => setOpen(false)}
              triggerRef={triggerRef}
            >
              <div className="mapping-field-menu">
                <label className="mapping-field-search">
                  <Icon.Search />
                  <input
                    value={query}
                    placeholder="搜索字段"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <div className="mapping-field-options">
                  {filteredCandidates.length > 0 ? filteredCandidates.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={'dd-item mapping-field-option' + (f.id === value ? ' dd-item-on' : '')}
                      onClick={() => {
                        onChange(f.id);
                        setOpen(false);
                      }}
                    >
                      <span>{f.name}</span>
                    </button>
                  )) : (
                    <div className="bind-empty">
                      {candidates.length > 0 ? '没有匹配的字段' : '当前表暂无可匹配字段'}
                    </div>
                  )}
                </div>
              </div>
            </Dropdown>
          </>
        )}
      </div>
    </div>
  );
}

interface FileNameEditorProps {
  value: string;
  onChange: (v: string) => void;
  variables: string[];
}

type FnPart = { kind: 'text'; text: string } | { kind: 'var'; name: string };

export function FileNameEditor({ value, onChange, variables }: FileNameEditorProps) {
  const [open, setOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const parts = useMemo<FnPart[]>(() => {
    const out: FnPart[] = [];
    let last = 0;
    const re = /\{\{([^}]+)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value))) {
      if (m.index > last) out.push({ kind: 'text', text: value.slice(last, m.index) });
      out.push({ kind: 'var', name: m[1] });
      last = re.lastIndex;
    }
    if (last < value.length) out.push({ kind: 'text', text: value.slice(last) });
    return out;
  }, [value]);

  function updateTextAt(idx: number, newText: string) {
    onChange(
      parts
        .map((p, i) => (p.kind === 'var' ? `{{${p.name}}}` : i === idx ? newText : p.text))
        .join(''),
    );
  }

  function removeVarAt(idx: number) {
    const joined = parts
      .filter((_, i) => i !== idx)
      .map((p) => (p.kind === 'var' ? `{{${p.name}}}` : p.text))
      .join('');
    const cleaned = joined.replace(/^[\s\-_、,，]+/, '').replace(/[\s\-_、,，]+$/, '');
    onChange(cleaned);
  }

  return (
    <div className="fn-wrap">
      <div className="fn-tokens">
        {parts.map((p, i) =>
          p.kind === 'var' ? (
            <span key={i} className="fn-chip">
              {p.name}
              <button type="button" onClick={() => removeVarAt(i)} title="移除">
                <Icon.Close />
              </button>
            </span>
          ) : (
            <AutoInput
              key={i}
              className="fn-text"
              value={p.text}
              placeholder={i === 0 && parts.length === 1 ? '输入文件名…' : ''}
              onChange={(v) => updateTextAt(i, v)}
            />
          ),
        )}
        <button
          ref={addRef}
          className="fn-add"
          type="button"
          onClick={() => setOpen((o) => !o)}
          title="插入变量"
        >
          <Icon.Plus />
        </button>
        <span className="fn-ext">.docx</span>
        <Dropdown
          open={open}
          onClose={() => setOpen(false)}
          align="right"
          width={180}
          triggerRef={addRef}
        >
          <div className="dd-sec-label">插入变量</div>
          {variables.map((name) => (
            <button
              key={name}
              type="button"
              className="dd-item"
              onClick={() => {
                onChange(value + `{{${name}}}`);
                setOpen(false);
              }}
            >
              <span style={{ flex: 1, textAlign: 'left' }}>{name}</span>
            </button>
          ))}
        </Dropdown>
      </div>
    </div>
  );
}

interface OptionRowProps {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}

export function OptionRow({ label, value, options, onChange }: OptionRowProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="opt-row">
      <span className="opt-label">{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="opt-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        {value} <Icon.Chevron style={{ opacity: 0.5 }} />
      </button>
      <Dropdown
        open={open}
        onClose={() => setOpen(false)}
        align="right"
        width={140}
        triggerRef={triggerRef}
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

interface AutoInputProps {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
}

function AutoInput({ value, onChange, className, placeholder }: AutoInputProps) {
  const sizerRef = useRef<HTMLSpanElement | null>(null);
  const [w, setW] = useState(24);
  useLayoutEffect(() => {
    if (sizerRef.current) {
      setW(Math.max(8, sizerRef.current.getBoundingClientRect().width + 4));
    }
  }, [value, placeholder]);
  return (
    <span className="auto-input-wrap">
      <span ref={sizerRef} className={'auto-input-sizer ' + (className || '')} aria-hidden="true">
        {value || placeholder || ' '}
      </span>
      <input
        className={className}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: w + 'px' }}
      />
    </span>
  );
}

interface WriteBackPickerProps {
  fields: TableField[];
  value: string;
  onChange: (fid: string) => void;
  onCreate?: (name?: string) => Promise<TableField>;
}

export function WriteBackPicker({ fields, value, onChange, onCreate }: WriteBackPickerProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const selected = fields.find((f) => f.id === value);
  return (
    <div className="writeback-picker writeback-picker-flat">
      <button
        ref={triggerRef}
        type="button"
        className={'fld-trigger' + (!selected ? ' fld-empty' : '')}
        onClick={() => setOpen((o) => !o)}
      >
        {selected ? (
          <>
            <FieldTypeIcon type={selected.type} />
            <span className="fld-name">{selected.name}</span>
          </>
        ) : (
          <span className="fld-placeholder">选择附件字段</span>
        )}
        <Icon.Chevron style={{ marginLeft: 'auto', opacity: 0.5 }} />
      </button>
      <Dropdown
        open={open}
        onClose={() => setOpen(false)}
        align="right"
        width={200}
        triggerRef={triggerRef}
      >
        <div className="dd-sec-label">附件字段</div>
        {fields.length === 0 && <div className="dd-empty-msg">当前表无附件字段</div>}
        {fields.map((f) => (
          <button
            key={f.id}
            type="button"
            className={'dd-item' + (f.id === value ? ' dd-item-on' : '')}
            onClick={() => {
              setError('');
              onChange(f.id);
              setOpen(false);
            }}
          >
            <FieldTypeIcon type={f.type} />
            <span style={{ flex: 1, textAlign: 'left' }}>{f.name}</span>
            {f.id === value && <Icon.Check />}
          </button>
        ))}
        <div className="dd-divider" />
        <button
          type="button"
          className="dd-item dd-item-accent"
          disabled={!onCreate || creating}
          onClick={async () => {
            if (!onCreate || creating) return;
            setCreating(true);
            setError('');
            try {
              const field = await onCreate('生成文档');
              onChange(field.id);
              setOpen(false);
            } catch {
              setError('创建失败，请检查字段编辑权限。');
            } finally {
              setCreating(false);
            }
          }}
        >
          <Icon.Plus />
          <span style={{ flex: 1, textAlign: 'left' }}>
            {creating ? '正在创建…' : '新建附件字段…'}
          </span>
        </button>
        {error && <div className="dd-error-msg">{error}</div>}
      </Dropdown>
    </div>
  );
}
