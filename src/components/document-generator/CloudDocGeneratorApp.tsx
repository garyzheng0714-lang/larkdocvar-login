import type { CSSProperties, ReactNode } from 'react';
import { findBestMatchedField } from './cloudFieldMapping';
import { CloudMapRow } from './cloudDoc/CloudMapRow';
import { OutputFieldPicker } from './cloudDoc/OutputFieldPicker';
import { CLOUD_DOC_ACCENTS } from './cloudDoc/constants';
import { useCloudDocState } from './cloudDoc/cloudDocState';
import { Icon } from './icons';
import { GeneratorHeader } from './GeneratorHeader';
import type { GeneratorKind, TableField } from './types';

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
  const accent = CLOUD_DOC_ACCENTS[accentKey] || CLOUD_DOC_ACCENTS.blue;
  const cloud = useCloudDocState({
    fields,
    activeTableId,
    selectedRecordIds,
    allRecordIds,
    selectedCount,
    totalRecordCount,
    bitableAvailable,
    refreshBitable,
    demo,
  });

  return (
    <div
      className={`app app-${mode} density-${density}`}
      style={{
        '--accent': accent.primary,
        '--accent-soft': accent.soft,
      } as CSSProperties}
    >
      <aside className="sidebar" data-screen-label="01 Sidebar — 飞书云文档生成">
        <div className="screen">
          <GeneratorHeader
            userMenu={userMenu}
            generatorKind={generatorKind}
            onGeneratorKindChange={onGeneratorKindChange}
          />

          <div className="scroll">
            <div className="block block-tpl">
              <div className="cloud-url-card">
                <label className="cloud-url-label" htmlFor="cloud-template-url">飞书云文档链接</label>
                <div className="cloud-url-row">
                  <input
                    id="cloud-template-url"
                    className="nt-input cloud-url-input"
                    value={cloud.templateUrl}
                    placeholder="粘贴飞书云文档链接"
                    onChange={(event) => cloud.setTemplateUrl(event.target.value)}
                  />
                  <button
                    className="btn-primary cloud-extract-btn"
                    type="button"
                    disabled={!cloud.canExtract || cloud.extracting}
                    onClick={() => void cloud.extractVariables()}
                    style={{ background: cloud.canExtract && !cloud.extracting ? accent.primary : '#c8ccd2' }}
                  >
                    {cloud.extracting ? '提取中' : '提取变量'}
                  </button>
                </div>
                {cloud.templateTitle ? (
                  <div className="cloud-template-meta">
                    <Icon.Doc />
                    <span className="cloud-template-name">{cloud.templateTitle}</span>
                  </div>
                ) : null}
              </div>
            </div>

            {cloud.notice ? (
              <div className={`cloud-notice cloud-notice-${cloud.notice.type}`}>{cloud.notice.text}</div>
            ) : null}
            {!demo && bitableError && !bitableAvailable ? (
              <div className="cloud-notice cloud-notice-error">{bitableError}</div>
            ) : null}

            {cloud.variables.length > 0 ? (
              <>
                <div className="block">
                  <div className="block-head">
                    <span className="block-title">字段映射</span>
                    <span className="block-count">{cloud.variables.length}</span>
                    <button
                      className="ghost-link"
                      type="button"
                      onClick={() => {
                        const next = cloud.variables.reduce<Record<string, string>>((acc, variable) => {
                          acc[variable] = cloud.mapping[variable] || findBestMatchedField(variable, cloud.textFields)?.id || '';
                          return acc;
                        }, {});
                        cloud.applyMapping(next);
                      }}
                    >
                      <Icon.Sparkle /> 智能匹配
                    </button>
                  </div>
                  <div className="map-table">
                    {cloud.variables.map((variable) => (
                      <CloudMapRow
                        key={variable}
                        variable={variable}
                        fields={cloud.textFields}
                        value={cloud.mapping[variable] || ''}
                        onChange={(fieldId) => cloud.applyMapping({ ...cloud.mapping, [variable]: fieldId })}
                      />
                    ))}
                  </div>
                </div>

                <div className="block">
                  <div className="block-head">
                    <span className="block-title">生成后写回链接字段</span>
                  </div>
                  <OutputFieldPicker
                    fields={cloud.outputFields}
                    value={cloud.outputFieldId}
                    onChange={(fieldId) => {
                      cloud.setOutputFieldId(fieldId);
                      cloud.saveAutoConfig(cloud.mapping, fieldId);
                    }}
                  />
                </div>

                <div className="block">
                  <div className="block-head">
                    <span className="block-title">生成范围</span>
                  </div>
                  <div className="cloud-range">
                    <button
                      className={'cloud-range-option' + (cloud.range === 'selected' ? ' is-active' : '')}
                      type="button"
                      disabled={selectedRecordIds.length === 0}
                      onClick={() => cloud.setRange('selected')}
                    >
                      选中记录
                      <span>{selectedRecordIds.length}</span>
                    </button>
                    <button
                      className={'cloud-range-option' + (cloud.range === 'all' ? ' is-active' : '')}
                      type="button"
                      onClick={() => cloud.setRange('all')}
                    >
                      当前表
                      <span>{totalRecordCount || allRecordIds.length}</span>
                    </button>
                  </div>
                </div>

                {cloud.generating || cloud.progress.total > 0 ? (
                  <div className="block">
                    <div className="cloud-progress-head">
                      <span>{cloud.progress.phase || '准备中'}</span>
                      <b>{cloud.progress.total ? `${Math.min(cloud.progress.done, cloud.progress.total)} / ${cloud.progress.total}` : ''}</b>
                    </div>
                    <div className="bar-track">
                      <div
                        className="bar-fill"
                        style={{
                          width: cloud.progress.total > 0
                            ? `${Math.round((Math.min(cloud.progress.done, cloud.progress.total) / cloud.progress.total) * 100)}%`
                            : '0%',
                        }}
                      />
                    </div>
                  </div>
                ) : null}

                {cloud.results.length > 0 ? (
                  <div className="block">
                    <div className="block-head">
                      <span className="block-title">生成结果</span>
                      <span className="block-count">{cloud.results.length}</span>
                    </div>
                    <div className="cloud-result-list">
                      {cloud.results.slice(0, 20).map((item, index) => (
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
                将替换 <b>{cloud.targetCount}</b> 条记录
              </div>
              <div className="ftr-info-2">
                {cloud.variables.length === 0
                  ? '请先提取变量'
                  : cloud.unmappedCount > 0
                    ? <span className="ftr-warn">还有 {cloud.unmappedCount} 个变量未绑定字段</span>
                    : '生成后会写回链接字段'}
              </div>
            </div>
            <button
              className="btn-primary"
              type="button"
              disabled={!cloud.canGenerate || cloud.generating}
              onClick={() => void cloud.generate()}
              style={{ background: cloud.canGenerate && !cloud.generating ? accent.primary : '#c8ccd2' }}
            >
              {cloud.generating ? '替换中' : '开始替换'}
            </button>
          </footer>
        </div>
      </aside>
    </div>
  );
}
