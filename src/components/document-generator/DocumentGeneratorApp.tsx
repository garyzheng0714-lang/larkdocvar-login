import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import './_design.css';
import { PrimaryScreen } from './PrimaryScreen';
import { PickerScreen } from './PickerScreen';
import { NewTemplateScreen } from './NewTemplateScreen';
import { ProgressModal } from './ProgressModal';
import {
  buildDefaultMapping,
  buildStandaloneMapping,
  isSameMapping,
  reconcileMapping,
} from './mapping';
import type {
  AccentKey,
  Accent,
  GeneratorKind,
  GenerateRunner,
  PrimaryState,
  RecordSpec,
  TableField,
  Template,
} from './types';

const ACCENTS: Record<AccentKey, Accent> = {
  blue: { primary: '#2b5fed', soft: '#ecf0fe' },
  teal: { primary: '#0d8a7c', soft: '#e3f4f1' },
  graphite: { primary: '#374254', soft: '#eceef2' },
  amber: { primary: '#b9621a', soft: '#fbeedf' },
};

const CATEGORIES = ['全部', '合同类', '通知类', '报表类', '证明类'];

export interface DocumentGeneratorAppProps {
  userMenu?: ReactNode;
  fields: TableField[];
  activeTableId?: string | null;
  templates: Template[];
  selectedCount: number;
  bitableAvailable: boolean;
  bitableError?: string | null;
  templatesLoading?: boolean;
  templatesError?: string | null;
  refreshTemplates?: () => Promise<void>;
  accentKey?: AccentKey;
  density?: 'comfortable' | 'compact';
  mode?: 'bitable' | 'standalone';
  createAttachmentField?: (name?: string) => Promise<TableField>;
  runner: GenerateRunner;
  recordsFor: (state: PrimaryState) => RecordSpec[];
  generatorKind: GeneratorKind;
  onGeneratorKindChange: (value: GeneratorKind) => void;
}

export function DocumentGeneratorApp({
  userMenu,
  fields,
  activeTableId,
  templates,
  selectedCount,
  bitableAvailable,
  bitableError,
  templatesError,
  refreshTemplates,
  accentKey = 'blue',
  density = 'comfortable',
  mode = 'bitable',
  createAttachmentField,
  runner,
  recordsFor,
  generatorKind,
  onGeneratorKindChange,
}: DocumentGeneratorAppProps) {
  const accent = ACCENTS[accentKey] || ACCENTS.blue;
  const initialTemplate = templates[0] ?? null;

  const [state, setState] = useState<PrimaryState>(() => ({
    template: initialTemplate,
    sourceMode: mode,
    mapping: mode === 'standalone'
      ? buildStandaloneMapping(initialTemplate)
      : buildDefaultMapping(initialTemplate, fields),
    customText: {},
    fileNameTpl: initialTemplate ? `{{${initialTemplate.variables?.[0]?.name ?? '客户名称'}}}-${initialTemplate.name}` : '文档',
    selectedCount,
    expires: '24 小时',
    onMissing: '留空继续',
    writeBack: false,
    writeBackField: '',
  }));
  const [picker, setPicker] = useState(false);
  const [newTpl, setNewTpl] = useState(false);
  const [progress, setProgress] = useState(false);
  const fieldSignature = useMemo(
    () => fields.map((f) => `${f.id}:${f.name}:${f.type}`).join('|'),
    [fields],
  );

  useEffect(() => {
    setState((s) => ({ ...s, selectedCount, sourceMode: mode }));
  }, [selectedCount, mode]);

  useEffect(() => {
    if (!state.template && templates.length > 0) {
      const first = templates[0];
      setState((s) => ({
        ...s,
        template: first,
        mapping: mode === 'standalone'
          ? buildStandaloneMapping(first)
          : buildDefaultMapping(first, fields),
        fileNameTpl: first.variables?.[0]
          ? `{{${first.variables[0].name}}}-${first.name}`
          : first.name || '文档',
      }));
    }
  }, [templates, fields, state.template, mode]);

  useEffect(() => {
    if (mode === 'standalone') return;
    setState((s) => {
      if (!s.template) return s;
      const nextMapping = reconcileMapping(s.template, fields, s.mapping, { allowCustom: true });
      const writeBackFieldExists = fields.some((f) => f.id === s.writeBackField && f.type === 'attachment');
      const nextWriteBackField = writeBackFieldExists ? s.writeBackField : '';
      const mappingChanged = !isSameMapping(s.mapping, nextMapping);
      const writeBackChanged = s.writeBackField !== nextWriteBackField;
      if (!mappingChanged && !writeBackChanged) return s;
      return {
        ...s,
        mapping: nextMapping,
        writeBackField: nextWriteBackField,
        writeBack: nextWriteBackField ? s.writeBack : false,
      };
    });
  }, [activeTableId, fieldSignature, fields, mode]);

  const generationBusy = runner.phase === 'running' || runner.phase === 'paused';

  return (
    <div
      className={`app app-${mode} density-${density}`}
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
          mode={mode}
          createAttachmentField={createAttachmentField}
          openPicker={() => setPicker(true)}
          generationBusy={generationBusy}
          startGenerate={() => {
            if (generationBusy) {
              setProgress(true);
              return;
            }
            const records = recordsFor(state);
            if (records.length === 0) return;
            runner.start(records, {
              template: state.template,
              sourceMode: mode,
              mapping: state.mapping,
              customText: state.customText,
              fileNameTpl: state.fileNameTpl,
              writeBackField: state.writeBackField,
              expires: state.expires,
              onMissing: state.onMissing,
            });
            setProgress(true);
          }}
          accent={accent.primary}
          userMenu={userMenu}
          generatorKind={generatorKind}
          onGeneratorKindChange={onGeneratorKindChange}
        />
        {(bitableError || templatesError) && (
          <div
            style={{
              position: 'absolute',
              left: 12,
              right: 12,
              top: 56,
              padding: '8px 10px',
              background: '#fbeae8',
              color: '#c44a3d',
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.5,
              boxShadow: '0 4px 12px rgba(0,0,0,0.10)',
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
                  mapping: mode === 'standalone'
                    ? buildStandaloneMapping(tpl)
                    : buildDefaultMapping(tpl, fields),
                  customText: {},
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
              onSave={async () => {
                await refreshTemplates?.();
                setNewTpl(false);
              }}
            />
          </div>
        )}
        {progress && (
          <ProgressModal
            items={runner.items}
            phase={runner.phase}
            counts={runner.counts}
            startedAt={runner.startedAt}
            accent={accent.primary}
            onPause={runner.pause}
            onResume={runner.resume}
            onStop={runner.stop}
            onRetry={runner.retry}
            onClose={() => {
              setProgress(false);
              runner.reset();
            }}
            onMinimize={() => setProgress(false)}
          />
        )}
      </aside>
    </div>
  );
}
