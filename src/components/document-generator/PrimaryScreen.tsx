import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Icon } from './icons';
import { GeneratorHeader } from './GeneratorHeader';
import { CUSTOM_MAPPING_VALUE, reconcileMapping } from './mapping';
import { DocThumb, FileNameEditor, MapRow, OptionRow, WriteBackPicker } from './PrimaryScreenParts';
import type { GeneratorKind, PrimaryState, TableField } from './types';

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
  const canGenerate = !!tpl && unmappedCount === 0;

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
                : <span>已就绪，可开始生成</span>
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
