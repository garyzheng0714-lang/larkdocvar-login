import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import './_design.css';
import { PrimaryScreen } from './PrimaryScreen';
import { PickerScreen } from './PickerScreen';
import { NewTemplateScreen } from './NewTemplateScreen';
import { ProgressModal } from './ProgressModal';
import { TABLE_ROWS } from './mockData';
import type {
  AccentKey,
  Accent,
  PrimaryState,
  TableField,
  Template,
} from './types';

const ACCENTS: Record<AccentKey, Accent> = {
  blue: { primary: '#2b5fed', soft: '#ecf0fe' },
  teal: { primary: '#0d8a7c', soft: '#e3f4f1' },
  graphite: { primary: '#374254', soft: '#eceef2' },
  amber: { primary: '#b9621a', soft: '#fbeedf' },
};

function buildDefaultMapping(template: Template | null, fields: TableField[]): Record<string, string> {
  if (!template?.variables) return {};
  const mapping: Record<string, string> = {};
  const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  for (const v of template.variables) {
    const direct = byName.get(v.name.toLowerCase());
    if (direct) mapping[v.name] = direct.id;
    else if (v.suggested && fields.some((f) => f.id === v.suggested)) mapping[v.name] = v.suggested;
  }
  return mapping;
}

const CATEGORIES = ['全部', '合同类', '通知类', '报表类', '证明类'];

export interface DocumentGeneratorAppProps {
  userMenu?: ReactNode;
  fields: TableField[];
  templates: Template[];
  selectedCount: number;
  bitableAvailable: boolean;
  bitableError?: string | null;
  templatesLoading?: boolean;
  templatesError?: string | null;
  refreshTemplates?: () => Promise<void>;
  accentKey?: AccentKey;
  density?: 'comfortable' | 'compact';
}

export function DocumentGeneratorApp({
  userMenu,
  fields,
  templates,
  selectedCount,
  bitableAvailable,
  bitableError,
  templatesError,
  refreshTemplates,
  accentKey = 'blue',
  density = 'comfortable',
}: DocumentGeneratorAppProps) {
  const accent = ACCENTS[accentKey] || ACCENTS.blue;
  const initialTemplate = templates[0] ?? null;

  const [state, setState] = useState<PrimaryState>(() => ({
    template: initialTemplate,
    mapping: buildDefaultMapping(initialTemplate, fields),
    customText: {},
    fileNameTpl: initialTemplate ? `{{${initialTemplate.variables?.[0]?.name ?? '客户名称'}}}-${initialTemplate.name}` : '文档',
    selectedCount,
    expires: '24 小时',
    onMissing: '停止该条',
    writeBack: false,
    writeBackField: '',
  }));
  const [picker, setPicker] = useState(false);
  const [newTpl, setNewTpl] = useState(false);
  const [progress, setProgress] = useState(false);

  useEffect(() => {
    setState((s) => ({ ...s, selectedCount }));
  }, [selectedCount]);

  useEffect(() => {
    if (!state.template && templates.length > 0) {
      const first = templates[0];
      setState((s) => ({
        ...s,
        template: first,
        mapping: buildDefaultMapping(first, fields),
        fileNameTpl: first.variables?.[0]
          ? `{{${first.variables[0].name}}}-${first.name}`
          : first.name || '文档',
      }));
    }
  }, [templates, fields, state.template]);

  const recordsForRun = useMemo(
    () => TABLE_ROWS.slice(0, Math.min(state.selectedCount, TABLE_ROWS.length)),
    [state.selectedCount],
  );

  return (
    <div
      className={'app density-' + density}
      style={{
        ['--accent' as string]: accent.primary,
        ['--accent-soft' as string]: accent.soft,
      } as React.CSSProperties}
    >
      <aside className="sidebar" data-screen-label="01 Sidebar — 文档生成">
        <PrimaryScreen
          state={state}
          setState={setState}
          fields={fields}
          openPicker={() => setPicker(true)}
          startGenerate={() => setProgress(true)}
          accent={accent.primary}
          userMenu={userMenu}
        />
        {(bitableError || templatesError) && (
          <div
            style={{
              position: 'absolute',
              left: 12,
              right: 12,
              bottom: 76,
              padding: '8px 10px',
              background: '#fbeae8',
              color: '#c44a3d',
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.5,
              boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
              zIndex: 4,
              pointerEvents: 'none',
            }}
          >
            {bitableAvailable === false && bitableError ? bitableError : null}
            {bitableAvailable === false && bitableError && templatesError ? <br /> : null}
            {templatesError ? `模板列表加载失败：${templatesError}` : null}
          </div>
        )}
        {picker && (
          <div className="overlay overlay-slide" data-screen-label="02 Sidebar — 选择模板">
            <PickerScreen
              templates={templates}
              categories={CATEGORIES}
              initialSelectedId={state.template?.id}
              accent={accent.primary}
              onCancel={() => setPicker(false)}
              onConfirm={(tpl: Template) => {
                setState((s) => ({
                  ...s,
                  template: tpl,
                  mapping: buildDefaultMapping(tpl, fields),
                  fileNameTpl: tpl.variables?.[0]
                    ? `{{${tpl.variables[0].name}}}-${tpl.name}`
                    : tpl.name || '文档',
                }));
                setPicker(false);
              }}
              onNew={() => setNewTpl(true)}
            />
          </div>
        )}
        {newTpl && (
          <div className="overlay overlay-slide" data-screen-label="03 Sidebar — 新建模板">
            <NewTemplateScreen
              accent={accent.primary}
              onCancel={() => setNewTpl(false)}
              onSave={() => {
                setNewTpl(false);
                void refreshTemplates?.();
              }}
            />
          </div>
        )}
        {progress && (
          <ProgressModal
            records={recordsForRun}
            accent={accent.primary}
            onClose={() => setProgress(false)}
            onMinimize={() => setProgress(false)}
          />
        )}
      </aside>
    </div>
  );
}
