import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Icon, FieldTypeIcon } from './icons';
import { Dropdown } from './Dropdown';
import { GeneratorHeader } from './GeneratorHeader';
import { CUSTOM_MAPPING_VALUE, reconcileMapping } from './mapping';
import type { GeneratorKind, PrimaryState, TableField, TemplateVariable } from './types';

interface PrimaryScreenProps {
  state: PrimaryState;
  setState: Dispatch<SetStateAction<PrimaryState>>;
  fields: TableField[];
  mode?: 'bitable' | 'standalone';
  createAttachmentField?: (name?: string) => Promise<TableField>;
  openPicker: () => void;
  startGenerate: () => void;
  generationBusy?: boolean;
  accent: string;
  userMenu?: React.ReactNode;
  generatorKind: GeneratorKind;
  onGeneratorKindChange: (value: GeneratorKind) => void;
}

export function PrimaryScreen({
  state,
  setState,
  fields,
  mode = 'bitable',
  createAttachmentField,
  openPicker,
  startGenerate,
  generationBusy = false,
  accent,
  userMenu,
  generatorKind,
  onGeneratorKindChange,
}: PrimaryScreenProps) {
  const tpl = state.template;
  const mapping = state.mapping;
  const fileNameTpl = state.fileNameTpl;
  const [optsOpen, setOptsOpen] = useState(false);

  function setMapping(varName: string, fieldId: string) {
    setState((s) => ({ ...s, mapping: { ...s.mapping, [varName]: fieldId } }));
  }
  const tplVars = tpl?.variables ?? [];
  const isStandalone = mode === 'standalone';
  const unmappedCount = tpl
    ? tplVars.filter((v) =>
        isStandalone || mapping[v.name] === CUSTOM_MAPPING_VALUE
          ? !state.customText[v.name]?.trim()
          : !mapping[v.name],
      ).length
    : 0;
  const hasRecords = isStandalone || state.selectedCount > 0;
  const canGenerate = !!tpl && unmappedCount === 0 && hasRecords;

  return (
    <div className="screen">
      <GeneratorHeader
        userMenu={userMenu}
        generatorKind={generatorKind}
        onGeneratorKindChange={onGeneratorKindChange}
      />

      <div className="scroll">
        <div className="block block-tpl">
          {tpl ? (
            <div className="tpl-row-shell">
              <button className="tpl-row" onClick={openPicker} title={tpl.name} type="button">
                <span className="tpl-row-thumb"><DocThumb /></span>
                <span className="tpl-row-info">
                  <span className="tpl-name-line">
                    <span className="tpl-row-name" title={tpl.name}>{tpl.name}</span>
                  </span>
                  <span className="tpl-row-meta">
                    <span>{tpl.updatedAt}更新</span>
                  </span>
                </span>
                <span className="tpl-row-action">
                  替换 <Icon.ChevronR />
                </span>
              </button>
            </div>
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
                <span className="block-title">{isStandalone ? '填写变量' : '字段映射'}</span>
                <span className="block-count">{tplVars.length}</span>
                {!isStandalone && (
                  <button
                    className="ghost-link"
                    type="button"
                    onClick={() => {
                      setState((s) => {
                        const next = reconcileMapping(s.template, fields, s.mapping, { allowCustom: true });
                        return { ...s, mapping: next };
                      });
                    }}
                  >
                    <Icon.Sparkle /> 智能匹配
                  </button>
                )}
              </div>
              <div className="map-table mapping-table">
                {tplVars.map((v) => (
                  <MapRow
                    key={v.name}
                    variable={v}
                    fields={fields}
                    mode={mode}
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
                variables={tplVars.filter((v) => v.kind === 'text').map((v) => v.name)}
              />
            </div>

            {!isStandalone && (
              <div className="block">
                <div className="block-head">
                  <span className="block-title">生成后写回附件字段</span>
                </div>
                <WriteBackPicker
                  fields={fields.filter((f) => f.type === 'attachment')}
                  value={state.writeBackField}
                  onCreate={createAttachmentField}
                  onChange={(fid) =>
                    setState((s) => ({ ...s, writeBackField: fid, writeBack: !!fid }))
                  }
                />
              </div>
            )}

            <div className="block">
              <div className="block-head">
                <span className="block-title">生成数量</span>
              </div>
              <div className="src-card">
                <div className="src-row">
                  <span className="src-label">{isStandalone ? '来源' : '记录'}</span>
                  <span className="src-value">
                    {isStandalone ? '手动填写 1 份文档' : `当前将生成 ${state.selectedCount} 份文档`}
                  </span>
                </div>
              </div>
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
            将生成 <b>{isStandalone ? 1 : state.selectedCount}</b> 份文档
          </div>
          <div className="ftr-info-2">
            {tpl
              ? unmappedCount > 0
                ? <span className="ftr-warn">还有 {unmappedCount} 个变量未填</span>
                : !hasRecords
                  ? <span className="ftr-warn">没有可生成记录</span>
                : <span>预计 ~{Math.ceil((isStandalone ? 1 : state.selectedCount) * 0.8)} 秒</span>
              : '请先选择模板'}
          </div>
        </div>
        <button
          className="btn-primary"
          type="button"
          disabled={!canGenerate && !generationBusy}
          onClick={startGenerate}
          style={{ background: canGenerate || generationBusy ? accent : '#c8ccd2' }}
        >
          {generationBusy ? '查看进度' : '开始生成'}
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
  mode?: 'bitable' | 'standalone';
  value: string | undefined;
  onChange: (fid: string) => void;
  customText: string | undefined;
  onCustomText: (t: string) => void;
}

function MapRow({ variable, fields, mode = 'bitable', value, onChange, customText, onCustomText }: MapRowProps) {
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
    const joined = parts
      .filter((_, i) => i !== idx)
      .map((p) => (p.kind === 'var' ? `{{${p.name}}}` : p.text))
      .join('');
    // strip an orphan leading separator (`-`, `_`, whitespace, common CJK dividers)
    // and collapse a trailing one likewise
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
  onCreate?: (name?: string) => Promise<TableField>;
}

function WriteBackPicker({ fields, value, onChange, onCreate }: WriteBackPickerProps) {
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
