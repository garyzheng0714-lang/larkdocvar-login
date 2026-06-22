import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Icon } from './icons';
import { copyTextToClipboard } from './clipboard';
import { GeneratorHeader } from './GeneratorHeader';
import { CUSTOM_MAPPING_VALUE, reconcileMapping } from './mapping';
import { DocThumb, FileNameEditor, MapRow, OptionRow, WriteBackPicker } from './PrimaryScreenParts';
import type { GeneratorKind, PreviewOutcome, PrimaryState, TableField, Template } from './types';

function base64ToBlob(base64: string, contentType: string): Blob {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: contentType });
}

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
  onPreview?: (template: Template) => Promise<PreviewOutcome>;
  onEditTemplate?: (template: Template) => void;
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
  onPreview,
  onEditTemplate,
}: PrimaryScreenProps) {
  const tpl = state.template;
  const mapping = state.mapping;
  const fileNameTpl = state.fileNameTpl;
  const [optsOpen, setOptsOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<'ok' | 'error' | null>(null);

  async function handlePreview() {
    if (!tpl || !onPreview || previewing) return;
    setPreviewError(null);
    setPreviewing(true);
    // 点击当下先同步开一个空白标签，避免 await 后再 open 被浏览器拦截弹窗
    const win = window.open('', '_blank');
    try {
      const outcome = await onPreview(tpl);
      if (outcome.ok) {
        const url = URL.createObjectURL(base64ToBlob(outcome.fileBase64, outcome.contentType));
        if (win) win.location.href = url;
        else window.open(url, '_blank');
      } else {
        win?.close();
        setPreviewError(outcome.error);
      }
    } catch (err) {
      win?.close();
      setPreviewError(err instanceof Error ? err.message : '预览失败');
    } finally {
      setPreviewing(false);
    }
  }

  async function copyTemplateId() {
    if (!tpl) return;
    try {
      await copyTextToClipboard(tpl.id);
      setCopyNotice('ok');
    } catch {
      setCopyNotice('error');
    }
    window.setTimeout(() => setCopyNotice(null), 1400);
  }

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
            <>
              <div className="tpl-row-shell">
                <button className="tpl-row" onClick={openPicker} title={tpl.name} type="button">
                  <span className="tpl-row-thumb"><DocThumb /></span>
                  <span className="tpl-row-info">
                    <span className="tpl-name-line">
                      <span className="tpl-row-name" title={tpl.name}>{tpl.name}</span>
                    </span>
                    <span className="tpl-row-meta">
                      <span>{tpl.updatedAt}更新</span>
                      <span className="dot-sep" />
                      <span className="tpl-row-id">ID {tpl.id}</span>
                    </span>
                  </span>
                  <span className="tpl-row-action">
                    <Icon.ChevronR />
                  </span>
                </button>
                <div className="tpl-row-actions">
                  {onEditTemplate && (
                    <button
                      className="template-action-btn"
                      type="button"
                      onClick={() => onEditTemplate(tpl)}
                      aria-label={`更新模板：${tpl.name}`}
                      title={`更新模板：${tpl.name}`}
                    >
                      <Icon.Doc />
                      <span>更新模板</span>
                    </button>
                  )}
                  <button
                    className="template-copy-btn"
                    type="button"
                    onClick={copyTemplateId}
                    aria-label={`复制模板 ID：${tpl.id}`}
                    title={`复制模板 ID：${tpl.id}`}
                  >
                    <Icon.Copy />
                    <span>
                      {copyNotice === 'ok' ? '已复制' : copyNotice === 'error' ? '复制失败' : '复制ID'}
                    </span>
                  </button>
                </div>
              </div>
              {onPreview && (
                <div className="tpl-row-extra">
                  <button
                    className="ghost-link"
                    type="button"
                    onClick={handlePreview}
                    disabled={previewing}
                    title="用变量名作示例值生成保真 PDF，先确认样式是否统一"
                  >
                    {previewing ? '生成预览中…' : '预览样式 PDF'}
                  </button>
                  {previewError && <span className="tpl-row-preview-err">{previewError}</span>}
                </div>
              )}
            </>
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
