import { useEffect, useMemo, useState } from 'react';
import { Icon } from './icons';
import { copyTextToClipboard } from './clipboard';
import type { Template, TemplateThumbnail } from './types';

interface PickerScreenProps {
  templates: Template[];
  categories: string[];
  initialSelectedId?: string;
  accent: string;
  onCancel: () => void;
  onConfirm: (tpl: Template) => void;
  onNew: () => void;
  onEdit: (tpl: Template) => void;
}

export function PickerScreen({
  templates,
  categories,
  initialSelectedId,
  accent,
  onCancel,
  onConfirm,
  onNew,
  onEdit,
}: PickerScreenProps) {
  const [tab, setTab] = useState<'公用' | '个人'>('公用');
  const [category, setCategory] = useState('全部');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>(initialSelectedId);
  const [copyNotice, setCopyNotice] = useState<{ id: string; ok: boolean } | null>(null);

  const list = useMemo(() => {
    return templates.filter(
      (t) =>
        (tab === '个人' ? t.visibility === 'private' : t.visibility !== 'private') &&
        (category === '全部' || t.category === category) &&
        (!query || t.name.includes(query)),
    );
  }, [tab, templates, category, query]);

  useEffect(() => {
    if (selectedId && !list.some((t) => t.id === selectedId)) {
      setSelectedId(undefined);
    }
  }, [list, selectedId]);

  async function copyTemplateId(templateId: string) {
    try {
      await copyTextToClipboard(templateId);
      setCopyNotice({ id: templateId, ok: true });
    } catch {
      setCopyNotice({ id: templateId, ok: false });
    }
    window.setTimeout(() => {
      setCopyNotice((current) => (current?.id === templateId ? null : current));
    }, 1400);
  }

  return (
    <div className="screen picker-screen">
      <header className="hdr hdr-with-back">
        <button className="hdr-icon" type="button" onClick={onCancel}><Icon.Back /></button>
        <div className="hdr-title">选择模板</div>
        <button className="hdr-link" type="button" onClick={onNew}>新建</button>
      </header>

      <div className="picker-tabs">
        <button
          type="button"
          className={'p-tab' + (tab === '公用' ? ' p-tab-on' : '')}
          onClick={() => setTab('公用')}
        >
          公用模板
        </button>
        <button
          type="button"
          className={'p-tab' + (tab === '个人' ? ' p-tab-on' : '')}
          onClick={() => setTab('个人')}
        >
          个人模板
        </button>
      </div>

      <div className="picker-controls">
        <div className="search">
          <Icon.Search style={{ opacity: 0.5, flexShrink: 0 }} />
          <input
            placeholder="搜索模板名称"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="cat-chips">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              className={'chip' + (c === category ? ' chip-on' : '')}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="picker-grid-wrap">
        {list.length === 0 ? (
          <div className="empty-state">
            <div className="empty-glyph"><Icon.Folder /></div>
            <div className="empty-title">没有找到匹配的模板</div>
            <div className="empty-hint">换个关键词或类别试试</div>
          </div>
        ) : (
          <div className="picker-grid">
            {list.map((t) => (
              <div className="tcard-shell" key={t.id}>
                <TemplateCard
                  t={t}
                  selected={t.id === selectedId}
                  accent={accent}
                  onClick={() => setSelectedId(t.id)}
                />
                <div
                  className="template-card-actions"
                  aria-label={`${t.name} 模板操作`}
                >
                  <button
                    className="template-action-btn"
                    type="button"
                    onClick={() => onEdit(t)}
                    aria-label={`更新模板：${t.name}`}
                    title={`更新模板：${t.name}`}
                  >
                    <Icon.Doc />
                    <span>更新</span>
                  </button>
                  <button
                    className="template-copy-btn"
                    type="button"
                    onClick={() => copyTemplateId(t.id)}
                    aria-label={`复制模板 ID：${t.id}`}
                    title={`复制模板 ID：${t.id}`}
                  >
                    <Icon.Copy />
                    <span>
                      {copyNotice?.id === t.id
                        ? (copyNotice.ok ? '已复制' : '复制失败')
                        : '复制ID'}
                    </span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="picker-ftr">
        <button className="btn-ghost" type="button" onClick={onCancel}>取消</button>
        <button
          className="btn-primary"
          type="button"
          style={{ background: accent }}
          disabled={!selectedId}
          onClick={() => {
            const picked = templates.find((t) => t.id === selectedId);
            if (picked) onConfirm(picked);
          }}
        >
          确认使用
        </button>
      </footer>
    </div>
  );
}

interface TemplateCardProps {
  t: Template;
  selected: boolean;
  accent: string;
  onClick: () => void;
}

function TemplateCard({ t, selected, accent, onClick }: TemplateCardProps) {
  return (
    <button
      type="button"
      className={'tcard' + (selected ? ' tcard-on' : '')}
      title={t.name}
      onClick={onClick}
      style={
        selected
          ? { borderColor: accent, boxShadow: `0 0 0 1px ${accent}, 0 2px 8px ${accent}1f` }
          : undefined
      }
    >
      <div className="tcard-thumb">
        <TemplateThumb t={t} />
        {selected && (
          <span className="tcard-tick" style={{ background: accent }}>
            <Icon.Check style={{ color: '#fff' }} />
          </span>
        )}
      </div>
      <div className="tcard-name" title={t.name}>{t.name}</div>
      <div className="tcard-meta">
        <span>{t.varCount} 变量</span>
        <span className="dot-sep" />
        <span>{t.updatedAt}</span>
      </div>
      <div className="tcard-id">
        <span>ID</span>
        <code>{t.id}</code>
      </div>
    </button>
  );
}

function TemplateThumb({ t }: { t: Template }) {
  const thumbnail = t.thumbnail || buildFallbackThumbnail(t);
  const lines = thumbnail.lines.length > 0 ? thumbnail.lines : buildFallbackThumbnail(t).lines;
  const titleIndex = Math.max(0, lines.findIndex((line) => line.role === 'title'));
  const title = lines[titleIndex] || lines[0];
  const bodyLines = lines.filter((_line, index) => index !== titleIndex).slice(0, 5);
  const variableNames = thumbnail.variableNames.slice(0, 3);

  return (
    <svg viewBox="0 0 120 88" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      <rect x="14" y="6" width="92" height="76" rx="3" fill="#fff" />
      <rect x="14" y="6" width="92" height="76" rx="3" fill="none" stroke="#ebeef3" strokeWidth="1" />
      {thumbnail.hasImagePlaceholders && (
        <>
          <rect x="24" y="13" width="18" height="14" rx="2" fill="#edf2ff" stroke="#d7e0ff" strokeWidth="0.8" />
          <circle cx="31" cy="19" r="2.2" fill="#c3cdea" />
          <path d="M25.5 25 L31.5 20 L36 24 L40.5 18.8 L40.5 25 Z" fill="#d7def4" />
        </>
      )}
      <text
        x="60"
        y={thumbnail.hasImagePlaceholders ? 23 : 19}
        textAnchor="middle"
        fontSize="5.2"
        fontWeight="600"
        fill="#9aa3af"
      >
        {truncateSvgText(title?.text || t.name, 14)}
      </text>
      {(bodyLines.length > 0 ? bodyLines : lines.slice(0, 5)).map((line, index) => {
        const y = 34 + index * 7;
        const width = lineWidth(line.text, index);
        return (
          <rect
            key={`${line.text}-${index}`}
            x={(120 - width) / 2}
            y={y}
            width={width}
            height="2.4"
            rx="1.2"
            fill={index === 0 ? '#d6dbe3' : '#e5e8ed'}
          />
        );
      })}
      {variableNames.map((name, index) => {
        const width = Math.min(26, Math.max(13, name.length * 3.3 + 8));
        const x = 22 + index * 25;
        return (
          <rect
            key={name}
            x={x}
            y="69"
            width={width}
            height="6"
            rx="1.5"
            fill={index === 0 ? '#dfe6f8' : '#e2e6ec'}
          />
        );
      })}
    </svg>
  );
}

function buildFallbackThumbnail(t: Template): TemplateThumbnail {
  const variableNames = (t.variables || []).map((variable) => variable.name).filter(Boolean).slice(0, 6);
  return {
    kind: 'docx-outline',
    pageRatio: 1.414,
    lines: [
      { text: t.name, role: 'title' },
      ...variableNames.slice(0, 4).map((text) => ({ text, role: 'body' as const })),
    ],
    variableNames,
    hasImagePlaceholders: Boolean(t.variables?.some((variable) => variable.kind === 'image')),
  };
}

function truncateSvgText(input: string, maxLength: number): string {
  return input.length > maxLength ? `${input.slice(0, maxLength - 3)}...` : input;
}

function lineWidth(input: string, index: number): number {
  const base = Math.min(76, Math.max(30, input.length * 4.2));
  const taper = index % 3 === 2 ? 12 : index % 3 === 1 ? 6 : 0;
  return Math.max(26, base - taper);
}
