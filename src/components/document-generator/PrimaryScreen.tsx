import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Icon, FieldTypeIcon } from './icons';
import { Dropdown } from './Dropdown';
import type { PrimaryState, TableField, TemplateVariable } from './types';

interface PrimaryScreenProps {
  state: PrimaryState;
  setState: Dispatch<SetStateAction<PrimaryState>>;
  fields: TableField[];
  openPicker: () => void;
  startGenerate: () => void;
  accent: string;
  userMenu?: React.ReactNode;
}

export function PrimaryScreen({
  state,
  setState,
  fields,
  openPicker,
  startGenerate,
  accent,
  userMenu,
}: PrimaryScreenProps) {
  const tpl = state.template;
  const mapping = state.mapping;
  const fileNameTpl = state.fileNameTpl;
  const [optsOpen, setOptsOpen] = useState(false);

  function setMapping(varName: string, fieldId: string) {
    setState((s) => ({ ...s, mapping: { ...s.mapping, [varName]: fieldId } }));
  }
  const unmappedCount = tpl ? tpl.variables!.filter((v) => !mapping[v.name]).length : 0;
  const canGenerate = !!tpl && unmappedCount === 0;

  return (
    <div className="screen">
      <header className="hdr">
        <div className="hdr-title">文档生成</div>
        <div className="hdr-actions">
          <button className="hdr-icon" title="使用帮助" type="button"><Icon.Help /></button>
          {userMenu}
        </div>
      </header>

      <div className="scroll">
        <div className="block block-tpl">
          {tpl ? (
            <button className="tpl-row" onClick={openPicker} type="button">
              <span className="tpl-row-thumb"><DocThumb /></span>
              <span className="tpl-row-info">
                <span className="tpl-row-name">{tpl.name}</span>
                <span className="tpl-row-meta">
                  <span>{tpl.updatedAt}更新</span>
                </span>
              </span>
              <span className="tpl-row-action">
                替换 <Icon.ChevronR />
              </span>
            </button>
          ) : (
            <button className="tpl-empty" onClick={openPicker} type="button">
              <span className="tpl-empty-glyph"><Icon.Doc /></span>
              <span className="tpl-empty-text">
                <span className="tpl-empty-title">选择文档模板</span>
                <span className="tpl-empty-hint">从模板库挑选 · docx 格式</span>
              </span>
              <Icon.ChevronR style={{ opacity: 0.4 }} />
            </button>
          )}
        </div>

        {tpl && (
          <>
            <div className="block">
              <div className="block-head">
                <span className="block-title">字段映射</span>
                <span className="block-count">{tpl.variables!.length}</span>
                <button
                  className="ghost-link"
                  type="button"
                  onClick={() => {
                    const m: Record<string, string> = {};
                    tpl.variables!.forEach((v) => {
                      if (v.suggested) m[v.name] = v.suggested;
                    });
                    setState((s) => ({ ...s, mapping: m }));
                  }}
                >
                  <Icon.Sparkle /> 智能匹配
                </button>
              </div>
              <div className="map-table">
                {tpl.variables!.map((v) => (
                  <MapRow
                    key={v.name}
                    variable={v}
                    fields={fields}
                    value={mapping[v.name]}
                    onChange={(fid) => setMapping(v.name, fid)}
                    customText={state.customText[v.name]}
                    onCustomText={(t) =>
                      setState((s) => ({ ...s, customText: { ...s.customText, [v.name]: t } }))
                    }
                  />
                ))}
              </div>
            </div>

            <div className="block">
              <div className="block-head">
                <span className="block-title">文件命名</span>
              </div>
              <FileNameEditor
                value={fileNameTpl}
                onChange={(v) => setState((s) => ({ ...s, fileNameTpl: v }))}
                variables={tpl.variables!.filter((v) => v.kind === 'text').map((v) => v.name)}
              />
            </div>

            <div className="block">
              <div className="block-head">
                <span className="block-title">生成后写回附件字段</span>
              </div>
              <WriteBackPicker
                fields={fields.filter((f) => f.type === 'attachment')}
                value={state.writeBackField}
                onChange={(fid) =>
                  setState((s) => ({ ...s, writeBackField: fid, writeBack: !!fid }))
                }
              />
            </div>

            <div className={'block block-collapsible' + (optsOpen ? ' is-open' : '')}>
              <button
                className="block-head block-head-toggle"
                type="button"
                onClick={() => setOptsOpen((o) => !o)}
              >
                <span className="block-title">高级设置</span>
                <span className="block-subtle">仅本次生成生效</span>
                <span className="block-collapse-chev"><Icon.Chevron /></span>
              </button>
              {optsOpen && (
                <div className="block-collapse-body">
                  <OptionRow
                    label="下载链接有效期"
                    value={state.expires}
                    options={['1 小时', '24 小时', '7 天']}
                    onChange={(v) => setState((s) => ({ ...s, expires: v }))}
                  />
                  <OptionRow
                    label="缺失变量时"
                    value={state.onMissing}
                    options={['停止该条', '留空继续']}
                    onChange={(v) => setState((s) => ({ ...s, onMissing: v }))}
                  />
                </div>
              )}
            </div>
          </>
        )}
        <div style={{ height: 8 }} />
      </div>

      <footer className="ftr">
        <div className="ftr-info">
          <div className="ftr-info-1">
            将生成 <b>{state.selectedCount}</b> 份文档
          </div>
          <div className="ftr-info-2">
            {tpl
              ? unmappedCount > 0
                ? <span className="ftr-warn">还有 {unmappedCount} 个变量未填</span>
                : <span>预计 ~{Math.ceil(state.selectedCount * 0.8)} 秒</span>
              : '请先选择模板'}
          </div>
        </div>
        <button
          className="btn-primary"
          type="button"
          disabled={!canGenerate}
          onClick={startGenerate}
          style={{ background: canGenerate ? accent : '#c8ccd2' }}
        >
          开始生成
        </button>
      </footer>
    </div>
  );
}

function DocThumb() {
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
  value: string | undefined;
  onChange: (fid: string) => void;
  customText: string | undefined;
  onCustomText: (t: string) => void;
}

function MapRow({ variable, fields, value, onChange, customText, onCustomText }: MapRowProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const isImage = variable.kind === 'image';
  const candidates = fields.filter((f) =>
    isImage ? f.type === 'attachment' : f.type !== 'attachment',
  );
  const selected = fields.find((f) => f.id === value);
  const isCustom = value === '__custom__';

  return (
    <div className="mrow">
      <span className="mrow-var">{variable.name}</span>
      <div className="mrow-field">
        <button
          ref={triggerRef}
          type="button"
          className={'fld-trigger' + (!selected && !isCustom ? ' fld-empty' : '')}
          onClick={() => setOpen((o) => !o)}
        >
          {selected ? (
            <>
              <FieldTypeIcon type={selected.type} />
              <span className="fld-name">{selected.name}</span>
            </>
          ) : isCustom ? (
            <>
              <FieldTypeIcon type="text" />
              <span className="fld-name">{customText || '自定义文本…'}</span>
            </>
          ) : (
            <span className="fld-placeholder">未选择</span>
          )}
          <Icon.Chevron style={{ marginLeft: 'auto', opacity: 0.5 }} />
        </button>
        <Dropdown
          open={open}
          onClose={() => setOpen(false)}
          width={236}
          triggerRef={triggerRef}
        >
          <div className="dd-sec-label">表中字段</div>
          {candidates.map((f) => (
            <button
              key={f.id}
              type="button"
              className={'dd-item' + (f.id === value ? ' dd-item-on' : '')}
              onClick={() => {
                onChange(f.id);
                setOpen(false);
              }}
            >
              <FieldTypeIcon type={f.type} />
              <span style={{ flex: 1, textAlign: 'left' }}>{f.name}</span>
              {f.id === value && <Icon.Check />}
            </button>
          ))}
          {!isImage && (
            <>
              <div className="dd-divider" />
              <button
                type="button"
                className={'dd-item' + (isCustom ? ' dd-item-on' : '')}
                onClick={() => {
                  onChange('__custom__');
                  setOpen(false);
                }}
              >
                <FieldTypeIcon type="text" />
                <span style={{ flex: 1, textAlign: 'left' }}>自定义文本…</span>
              </button>
            </>
          )}
        </Dropdown>
        {isCustom && (
          <input
            className="custom-input"
            placeholder="输入固定值"
            value={customText || ''}
            onChange={(e) => onCustomText(e.target.value)}
          />
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

function FileNameEditor({ value, onChange, variables }: FileNameEditorProps) {
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
    onChange(
      parts
        .filter((_, i) => i !== idx)
        .map((p) => (p.kind === 'var' ? `{{${p.name}}}` : p.text))
        .join(''),
    );
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

function OptionRow({ label, value, options, onChange }: OptionRowProps) {
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
}

function WriteBackPicker({ fields, value, onChange }: WriteBackPickerProps) {
  const [open, setOpen] = useState(false);
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
          onClick={() => setOpen(false)}
        >
          <Icon.Plus />
          <span style={{ flex: 1, textAlign: 'left' }}>新建附件字段…</span>
        </button>
      </Dropdown>
    </div>
  );
}
