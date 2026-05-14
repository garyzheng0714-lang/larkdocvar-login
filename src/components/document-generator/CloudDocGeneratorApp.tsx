import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FieldType, bitable } from '@lark-base-open/js-sdk';
import type { ITable } from '@lark-base-open/js-sdk';
import { Dropdown } from './Dropdown';
import { FieldTypeIcon, Icon } from './icons';
import { GeneratorModeSwitch } from './GeneratorModeSwitch';
import type { Accent, GeneratorKind, TableField } from './types';

interface CloudDocGeneratorAppProps {
  userMenu?: ReactNode;
  fields: TableField[];
  activeTableId?: string | null;
  selectedRecordIds: string[];
  allRecordIds: string[];
  selectedCount: number;
  totalRecordCount: number;
  bitableAvailable: boolean;
  bitableError?: string | null;
  refreshBitable?: () => Promise<void>;
  accentKey?: 'blue' | 'teal' | 'graphite' | 'amber';
  density?: 'comfortable' | 'compact';
  mode?: 'bitable' | 'standalone';
  demo?: boolean;
  generatorKind: GeneratorKind;
  onGeneratorKindChange: (value: GeneratorKind) => void;
}

interface TemplateVariablesResponse {
  ok: true;
  documentId: string;
  templateTitle: string;
  variables: string[];
}

interface GenerateResult {
  recordId: string;
  status: 'success' | 'failed';
  docUrl?: string;
  documentTitle?: string;
  warnings?: string[];
  error?: string;
}

interface GenerateResponse {
  ok: true;
  results: GenerateResult[];
}

interface ProgressState {
  total: number;
  done: number;
  phase: string;
}

const ACCENTS: Record<NonNullable<CloudDocGeneratorAppProps['accentKey']>, Accent> = {
  blue: { primary: '#2b5fed', soft: '#ecf0fe' },
  teal: { primary: '#0d8a7c', soft: '#e3f4f1' },
  graphite: { primary: '#374254', soft: '#eceef2' },
  amber: { primary: '#b9621a', soft: '#fbeedf' },
};

const BATCH_SIZE = 10;
const AUTO_OUTPUT_FIELD = '__auto_output_field__';

function normalizeName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[【】[\]()（）{}<>《》_.\-]/g, '');
}

function findBestMatchedField(variable: string, fields: TableField[]): TableField | undefined {
  const normalizedVariable = normalizeName(variable);
  if (!normalizedVariable) return undefined;
  const exact = fields.find((field) => normalizeName(field.name) === normalizedVariable);
  if (exact) return exact;
  return fields.find((field) => {
    const normalizedField = normalizeName(field.name);
    return normalizedField.includes(normalizedVariable) || normalizedVariable.includes(normalizedField);
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`);
  }
  if (!payload?.ok) {
    throw new Error(payload?.error || '接口返回异常');
  }
  return payload as T;
}

async function resolveTable(activeTableId?: string | null): Promise<ITable> {
  if (activeTableId) {
    return bitable.base.getTableById(activeTableId);
  }
  const selection = await bitable.base.getSelection().catch(() => null);
  if (selection?.tableId) {
    return bitable.base.getTableById(selection.tableId);
  }
  return bitable.base.getActiveTable();
}

async function getAllRecordIds(table: ITable): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: number | undefined;
  while (true) {
    const page = await table.getRecordIdListByPage({ pageSize: 200, pageToken });
    ids.push(...page.recordIds);
    if (!page.hasMore) break;
    pageToken = page.pageToken;
  }
  return ids;
}

function stringifyCellValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifyCellValue).filter(Boolean).join('');
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    if (typeof objectValue.text === 'string') return objectValue.text;
    if (typeof objectValue.name === 'string') return objectValue.name;
    if (typeof objectValue.title === 'string') return objectValue.title;
  }
  return String(value);
}

async function readMappedVariables(
  table: ITable,
  recordIds: string[],
  variables: string[],
  mapping: Record<string, string>,
): Promise<Array<{ recordId: string; variables: Record<string, string> }>> {
  const pending = new Set(recordIds);
  const rows = new Map<string, Record<string, unknown>>();
  let pageToken: number | undefined;

  while (pending.size > 0) {
    const page = await table.getRecordsByPage({ pageSize: 200, pageToken, stringValue: true });
    for (const record of page.records) {
      if (!pending.has(record.recordId)) continue;
      rows.set(record.recordId, record.fields as Record<string, unknown>);
      pending.delete(record.recordId);
    }
    if (!page.hasMore) break;
    pageToken = page.pageToken;
  }

  return recordIds.map((recordId) => {
    const fields = rows.get(recordId) || {};
    const values: Record<string, string> = {};
    for (const variable of variables) {
      const fieldId = mapping[variable];
      values[variable] = fieldId ? stringifyCellValue(fields[fieldId]) : '';
    }
    return { recordId, variables: values };
  });
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function CloudDocGeneratorApp({
  userMenu,
  fields,
  activeTableId,
  selectedRecordIds,
  allRecordIds,
  selectedCount,
  totalRecordCount,
  bitableAvailable,
  bitableError,
  refreshBitable,
  accentKey = 'blue',
  density = 'comfortable',
  mode = 'bitable',
  demo = false,
  generatorKind,
  onGeneratorKindChange,
}: CloudDocGeneratorAppProps) {
  const accent = ACCENTS[accentKey] || ACCENTS.blue;
  const textFields = useMemo(() => fields.filter((field) => field.type !== 'attachment'), [fields]);
  const outputFields = useMemo(
    () => fields.filter((field) =>
      field.rawType == null
        ? field.type === 'text'
        : field.rawType === FieldType.Text || field.rawType === FieldType.Url,
    ),
    [fields],
  );
  const [templateUrl, setTemplateUrl] = useState('');
  const [templateTitle, setTemplateTitle] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [variables, setVariables] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [outputFieldId, setOutputFieldId] = useState(AUTO_OUTPUT_FIELD);
  const [range, setRange] = useState<'selected' | 'all'>(selectedCount > 0 ? 'selected' : 'all');
  const [notice, setNotice] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<ProgressState>({ total: 0, done: 0, phase: '' });
  const [results, setResults] = useState<GenerateResult[]>([]);
  const autoSaveTimer = useRef<number | null>(null);

  const targetCount = range === 'selected'
    ? selectedRecordIds.length
    : totalRecordCount || allRecordIds.length;
  const unmappedCount = variables.filter((variable) => !mapping[variable]).length;
  const canExtract = demo || templateUrl.trim().length > 0;
  const canGenerate = variables.length > 0 && unmappedCount === 0 && targetCount > 0 && (demo || bitableAvailable);

  const saveAutoConfig = useCallback((nextMapping: Record<string, string>, nextOutputFieldId: string) => {
    if (demo || !templateUrl.trim() || !templateTitle) return;
    if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = window.setTimeout(() => {
      void fetch('/api/configs/auto', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateUrl: templateUrl.trim(),
          tableId: activeTableId || '',
          payload: {
            templateUrl: templateUrl.trim(),
            templateTitle,
            templateId: documentId,
            tableId: activeTableId || '',
            bindings: nextMapping,
            outputFieldId: nextOutputFieldId === AUTO_OUTPUT_FIELD ? '' : nextOutputFieldId,
          },
        }),
      }).catch(() => undefined);
    }, 600);
  }, [activeTableId, demo, documentId, templateTitle, templateUrl]);

  const applyMapping = useCallback((next: Record<string, string>) => {
    setMapping(next);
    saveAutoConfig(next, outputFieldId);
  }, [outputFieldId, saveAutoConfig]);

  const extractVariables = useCallback(async () => {
    setExtracting(true);
    setNotice(null);
    setResults([]);
    try {
      const payload = demo
        ? {
            ok: true as const,
            documentId: 'mock_doc',
            templateTitle: '飞书云文档模板',
            variables: ['客户名称', '签订日期', '联系人'],
          }
        : await parseJsonResponse<TemplateVariablesResponse>(await fetch('/api/template/variables', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ templateUrl: templateUrl.trim() }),
          }));

      const nextMapping = payload.variables.reduce<Record<string, string>>((acc, variable) => {
        acc[variable] = findBestMatchedField(variable, textFields)?.id || '';
        return acc;
      }, {});
      setTemplateTitle(payload.templateTitle);
      setDocumentId(payload.documentId);
      setVariables(payload.variables);
      setMapping(nextMapping);
      saveAutoConfig(nextMapping, outputFieldId);
      setNotice({
        type: 'success',
        text: payload.variables.length > 0
          ? `已提取 ${payload.variables.length} 个变量。`
          : '未识别到变量，请确认模板中使用了 {{变量名}}。',
      });
    } catch (error) {
      setNotice({ type: 'error', text: `提取变量失败：${toErrorMessage(error)}` });
    } finally {
      setExtracting(false);
    }
  }, [demo, outputFieldId, saveAutoConfig, templateUrl, textFields]);

  const ensureOutputField = useCallback(async (table: ITable): Promise<string> => {
    if (outputFieldId !== AUTO_OUTPUT_FIELD) return outputFieldId;
    const used = new Set(fields.map((field) => field.name));
    let name = '生成文档链接';
    let suffix = 2;
    while (used.has(name)) {
      name = `生成文档链接${suffix}`;
      suffix += 1;
    }
    const created = await table.addField({ type: FieldType.Url, name });
    setOutputFieldId(created);
    await refreshBitable?.();
    return created;
  }, [fields, outputFieldId, refreshBitable]);

  const generate = useCallback(async () => {
    setGenerating(true);
    setNotice(null);
    setResults([]);
    try {
      if (demo) {
        const count = Math.max(1, targetCount || 3);
        setProgress({ total: count, done: 0, phase: '正在替换变量...' });
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        const demoResults = Array.from({ length: count }, (_, index): GenerateResult => ({
          recordId: `mock-${index + 1}`,
          status: 'success',
          docUrl: 'https://example.feishu.cn/docx/mock',
          documentTitle: `${templateTitle || '飞书云文档'}-${index + 1}`,
        }));
        setProgress({ total: count, done: count, phase: '已完成' });
        setResults(demoResults);
        setNotice({ type: 'success', text: `已完成：成功 ${count} 条，失败 0 条。` });
        return;
      }

      const table = await resolveTable(activeTableId);
      const targetIds = range === 'selected'
        ? selectedRecordIds
        : await getAllRecordIds(table);
      if (targetIds.length === 0) throw new Error(range === 'selected' ? '未检测到选中记录。' : '当前表没有可处理的记录。');

      const outputField = await ensureOutputField(table);
      const generated: GenerateResult[] = [];
      const batches = chunk(targetIds, BATCH_SIZE);
      setProgress({ total: targetIds.length, done: 0, phase: '正在读取表格变量...' });

      for (let i = 0; i < batches.length; i += 1) {
        const batchIds = batches[i];
        const records = await readMappedVariables(table, batchIds, variables, mapping);
        setProgress({
          total: targetIds.length,
          done: Math.min(targetIds.length, i * BATCH_SIZE),
          phase: `正在生成第 ${i + 1}/${batches.length} 批...`,
        });
        const payload = await parseJsonResponse<GenerateResponse>(await fetch('/api/documents/generate', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            templateUrl: templateUrl.trim(),
            records,
            options: {
              permissionMode: 'tenant_readable',
              ownerTransferEnabled: false,
            },
          }),
        }));

        for (const item of payload.results) {
          if (item.status === 'success' && item.docUrl) {
            try {
              await table.setCellValue(outputField, item.recordId, item.docUrl);
              generated.push(item);
            } catch (error) {
              generated.push({
                ...item,
                status: 'failed',
                error: `文档已生成，但写回链接失败：${toErrorMessage(error)}`,
              });
            }
          } else {
            generated.push(item);
          }
        }
        setProgress({
          total: targetIds.length,
          done: Math.min(targetIds.length, generated.length),
          phase: '正在写回生成链接...',
        });
      }

      const failed = generated.filter((item) => item.status === 'failed').length;
      const succeeded = generated.length - failed;
      setResults(generated);
      setNotice({
        type: failed > 0 ? 'error' : 'success',
        text: `已完成：成功 ${succeeded} 条，失败 ${failed} 条。`,
      });
      await refreshBitable?.();
    } catch (error) {
      setNotice({ type: 'error', text: `替换失败：${toErrorMessage(error)}` });
    } finally {
      setGenerating(false);
      setProgress((current) => current.total > 0 ? { ...current, done: current.total, phase: '已完成' } : current);
    }
  }, [
    activeTableId,
    allRecordIds,
    demo,
    ensureOutputField,
    mapping,
    range,
    refreshBitable,
    selectedRecordIds,
    targetCount,
    templateTitle,
    templateUrl,
    variables,
  ]);

  return (
    <div
      className={`app app-${mode} density-${density}`}
      style={{
        ['--accent' as string]: accent.primary,
        ['--accent-soft' as string]: accent.soft,
      } as React.CSSProperties}
    >
      <aside className="sidebar" data-screen-label="01 Sidebar — 飞书云文档生成">
        <div className="screen">
          <header className="hdr">
            <div className="hdr-title">{mode === 'standalone' ? '文档生成' : '根据表格记录批量生成文档'}</div>
            <GeneratorModeSwitch value={generatorKind} onChange={onGeneratorKindChange} />
            <div className="hdr-actions">
              <button className="hdr-icon" title="使用帮助" type="button"><Icon.Help /></button>
              {userMenu}
            </div>
          </header>

          <div className="scroll">
            <div className="block block-tpl">
              <div className="cloud-url-card">
                <label className="cloud-url-label" htmlFor="cloud-template-url">飞书云文档链接</label>
                <div className="cloud-url-row">
                  <input
                    id="cloud-template-url"
                    className="nt-input cloud-url-input"
                    value={templateUrl}
                    placeholder="粘贴飞书云文档链接"
                    onChange={(event) => setTemplateUrl(event.target.value)}
                  />
                  <button
                    className="btn-primary cloud-extract-btn"
                    type="button"
                    disabled={!canExtract || extracting}
                    onClick={() => void extractVariables()}
                    style={{ background: canExtract && !extracting ? accent.primary : '#c8ccd2' }}
                  >
                    {extracting ? '提取中' : '提取变量'}
                  </button>
                </div>
                {templateTitle ? (
                  <div className="cloud-template-meta">
                    <Icon.Doc />
                    <span className="cloud-template-name">{templateTitle}</span>
                  </div>
                ) : null}
              </div>
            </div>

            {notice ? (
              <div className={`cloud-notice cloud-notice-${notice.type}`}>{notice.text}</div>
            ) : null}
            {!demo && bitableError && !bitableAvailable ? (
              <div className="cloud-notice cloud-notice-error">{bitableError}</div>
            ) : null}

            {variables.length > 0 ? (
              <>
                <div className="block">
                  <div className="block-head">
                    <span className="block-title">字段映射</span>
                    <span className="block-count">{variables.length}</span>
                    <button
                      className="ghost-link"
                      type="button"
                      onClick={() => {
                        const next = variables.reduce<Record<string, string>>((acc, variable) => {
                          acc[variable] = mapping[variable] || findBestMatchedField(variable, textFields)?.id || '';
                          return acc;
                        }, {});
                        applyMapping(next);
                      }}
                    >
                      <Icon.Sparkle /> 智能匹配
                    </button>
                  </div>
                  <div className="map-table">
                    {variables.map((variable) => (
                      <CloudMapRow
                        key={variable}
                        variable={variable}
                        fields={textFields}
                        value={mapping[variable] || ''}
                        onChange={(fieldId) => applyMapping({ ...mapping, [variable]: fieldId })}
                      />
                    ))}
                  </div>
                </div>

                <div className="block">
                  <div className="block-head">
                    <span className="block-title">生成后写回链接字段</span>
                  </div>
                  <OutputFieldPicker
                    fields={outputFields}
                    value={outputFieldId}
                    onChange={(fieldId) => {
                      setOutputFieldId(fieldId);
                      saveAutoConfig(mapping, fieldId);
                    }}
                  />
                </div>

                <div className="block">
                  <div className="block-head">
                    <span className="block-title">生成范围</span>
                  </div>
                  <div className="cloud-range">
                    <button
                      className={'cloud-range-option' + (range === 'selected' ? ' is-active' : '')}
                      type="button"
                      disabled={selectedRecordIds.length === 0}
                      onClick={() => setRange('selected')}
                    >
                      选中记录
                      <span>{selectedRecordIds.length}</span>
                    </button>
                    <button
                      className={'cloud-range-option' + (range === 'all' ? ' is-active' : '')}
                      type="button"
                      onClick={() => setRange('all')}
                    >
                      当前表
                      <span>{totalRecordCount || allRecordIds.length}</span>
                    </button>
                  </div>
                </div>

                {generating || progress.total > 0 ? (
                  <div className="block">
                    <div className="cloud-progress-head">
                      <span>{progress.phase || '准备中'}</span>
                      <b>{progress.total ? `${Math.min(progress.done, progress.total)} / ${progress.total}` : ''}</b>
                    </div>
                    <div className="bar-track">
                      <div
                        className="bar-fill"
                        style={{
                          width: progress.total > 0
                            ? `${Math.round((Math.min(progress.done, progress.total) / progress.total) * 100)}%`
                            : '0%',
                        }}
                      />
                    </div>
                  </div>
                ) : null}

                {results.length > 0 ? (
                  <div className="block">
                    <div className="block-head">
                      <span className="block-title">生成结果</span>
                      <span className="block-count">{results.length}</span>
                    </div>
                    <div className="cloud-result-list">
                      {results.slice(0, 20).map((item, index) => (
                        <div key={`${item.recordId}-${index}`} className="cloud-result-row">
                          <span className={item.status === 'success' ? 'rs rs-ok' : 'rs rs-err'}>
                            {item.status === 'success' ? '成功' : '失败'}
                          </span>
                          <span className="cloud-result-name">{item.documentTitle || item.recordId}</span>
                          {item.docUrl ? (
                            <a className="rec-download" href={item.docUrl} target="_blank" rel="noreferrer">打开</a>
                          ) : (
                            <span className="cloud-result-error">{item.error}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
            <div style={{ height: 8 }} />
          </div>

          <footer className="ftr">
            <div className="ftr-info">
              <div className="ftr-info-1">
                将替换 <b>{targetCount}</b> 条记录
              </div>
              <div className="ftr-info-2">
                {variables.length === 0
                  ? '请先提取变量'
                  : unmappedCount > 0
                    ? <span className="ftr-warn">还有 {unmappedCount} 个变量未绑定字段</span>
                    : '生成后会写回链接字段'}
              </div>
            </div>
            <button
              className="btn-primary"
              type="button"
              disabled={!canGenerate || generating}
              onClick={() => void generate()}
              style={{ background: canGenerate && !generating ? accent.primary : '#c8ccd2' }}
            >
              {generating ? '替换中' : '开始替换'}
            </button>
          </footer>
        </div>
      </aside>
    </div>
  );
}

interface PickerProps {
  fields: TableField[];
  value: string;
  onChange: (fieldId: string) => void;
}

function CloudMapRow({ variable, fields, value, onChange }: PickerProps & { variable: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const selected = fields.find((field) => field.id === value);
  return (
    <div className="mrow">
      <span className="mrow-var">{variable}</span>
      <div className="mrow-field">
        <button
          ref={triggerRef}
          className={'fld-trigger' + (!selected ? ' fld-empty' : '')}
          type="button"
          onClick={() => setOpen((current) => !current)}
        >
          {selected ? (
            <>
              <FieldTypeIcon type={selected.type} />
              <span className="fld-name">{selected.name}</span>
            </>
          ) : (
            <span className="fld-placeholder">未选择</span>
          )}
          <Icon.Chevron style={{ marginLeft: 'auto', opacity: 0.5 }} />
        </button>
        <Dropdown open={open} onClose={() => setOpen(false)} width={236} triggerRef={triggerRef}>
          <div className="dd-sec-label">表中字段</div>
          {fields.map((field) => (
            <button
              key={field.id}
              className={'dd-item' + (field.id === value ? ' dd-item-on' : '')}
              type="button"
              onClick={() => {
                onChange(field.id);
                setOpen(false);
              }}
            >
              <FieldTypeIcon type={field.type} />
              <span style={{ flex: 1, textAlign: 'left' }}>{field.name}</span>
              {field.id === value ? <Icon.Check /> : null}
            </button>
          ))}
          {fields.length === 0 ? <div className="bind-empty">当前表暂无可用字段</div> : null}
        </Dropdown>
      </div>
    </div>
  );
}

function OutputFieldPicker({ fields, value, onChange }: PickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const selected = fields.find((field) => field.id === value);
  return (
    <div className="writeback-picker writeback-picker-flat">
      <button
        ref={triggerRef}
        className="fld-trigger"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        {selected ? (
          <>
            <FieldTypeIcon type={selected.type} />
            <span className="fld-name">{selected.name}</span>
          </>
        ) : (
          <span className="fld-name">自动新建链接字段</span>
        )}
        <Icon.Chevron style={{ marginLeft: 'auto', opacity: 0.5 }} />
      </button>
      <Dropdown open={open} onClose={() => setOpen(false)} align="right" width={220} triggerRef={triggerRef}>
        <button
          className={'dd-item' + (value === AUTO_OUTPUT_FIELD ? ' dd-item-on' : '')}
          type="button"
          onClick={() => {
            onChange(AUTO_OUTPUT_FIELD);
            setOpen(false);
          }}
        >
          <Icon.Plus />
          <span style={{ flex: 1, textAlign: 'left' }}>自动新建链接字段</span>
          {value === AUTO_OUTPUT_FIELD ? <Icon.Check /> : null}
        </button>
        <div className="dd-divider" />
        {fields.map((field) => (
          <button
            key={field.id}
            className={'dd-item' + (field.id === value ? ' dd-item-on' : '')}
            type="button"
            onClick={() => {
              onChange(field.id);
              setOpen(false);
            }}
          >
            <FieldTypeIcon type={field.type} />
            <span style={{ flex: 1, textAlign: 'left' }}>{field.name}</span>
            {field.id === value ? <Icon.Check /> : null}
          </button>
        ))}
      </Dropdown>
    </div>
  );
}
