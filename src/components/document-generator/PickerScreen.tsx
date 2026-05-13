import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon } from './icons';
import type { Template } from './types';

interface PickerScreenProps {
  templates: Template[];
  categories: string[];
  initialSelectedId?: string;
  accent: string;
  onCancel: () => void;
  onConfirm: (tpl: Template) => void;
  onNew: () => void;
}

export function PickerScreen({
  templates,
  categories,
  initialSelectedId,
  accent,
  onCancel,
  onConfirm,
  onNew,
}: PickerScreenProps) {
  const [tab, setTab] = useState<'公用' | '个人'>('公用');
  const [category, setCategory] = useState('全部');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>(initialSelectedId);

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
              <TemplateCard
                key={t.id}
                t={t}
                selected={t.id === selectedId}
                accent={accent}
                onClick={() => setSelectedId(t.id)}
              />
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
      <div className="tcard-name">{t.name}</div>
      <div className="tcard-meta">
        <span>{t.varCount} 变量</span>
        <span className="dot-sep" />
        <span>{t.updatedAt}</span>
      </div>
    </button>
  );
}

function TemplateThumb({ t }: { t: Template }) {
  const variant = t.id.charCodeAt(t.id.length - 1) % 4;
  return (
    <svg viewBox="0 0 120 88" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      <rect x="14" y="6" width="92" height="76" rx="3" fill="#fff" />
      {variant === 0 && (
        <>
          <rect x="22" y="14" width="44" height="5" rx="1.5" fill="#cfd3da" />
          <rect x="22" y="24" width="76" height="2.5" rx="1" fill="#e3e6ec" />
          <rect x="22" y="30" width="68" height="2.5" rx="1" fill="#e3e6ec" />
          <rect x="22" y="36" width="74" height="2.5" rx="1" fill="#e3e6ec" />
          <rect x="22" y="42" width="40" height="2.5" rx="1" fill="#e3e6ec" />
          <rect x="22" y="52" width="76" height="2.5" rx="1" fill="#e3e6ec" />
          <rect x="22" y="58" width="62" height="2.5" rx="1" fill="#e3e6ec" />
          <rect x="22" y="68" width="30" height="6" rx="1" fill="#dbdfe6" />
          <rect x="56" y="68" width="20" height="6" rx="1" fill="#dbdfe6" />
        </>
      )}
      {variant === 1 && (
        <>
          <circle cx="60" cy="22" r="10" fill="#dadde3" />
          <rect x="36" y="38" width="48" height="3" rx="1.2" fill="#cfd3da" />
          <rect x="32" y="46" width="56" height="2" rx="1" fill="#e3e6ec" />
          <rect x="28" y="54" width="64" height="2" rx="1" fill="#e3e6ec" />
          <rect x="32" y="60" width="56" height="2" rx="1" fill="#e3e6ec" />
          <rect x="40" y="68" width="40" height="2" rx="1" fill="#e3e6ec" />
        </>
      )}
      {variant === 2 && (
        <>
          <rect x="22" y="14" width="38" height="4" rx="1.2" fill="#cfd3da" />
          {[24, 32, 40, 48, 56, 64].map((y, i) => (
            <Fragment key={i}>
              <rect x="22" y={y} width="76" height="0.8" fill="#dfe2e8" />
              <rect x="22" y={y + 2.5} width="20" height="2" rx="0.8" fill="#e7eaef" />
              <rect x="48" y={y + 2.5} width="20" height="2" rx="0.8" fill="#e7eaef" />
              <rect x="74" y={y + 2.5} width="20" height="2" rx="0.8" fill="#e7eaef" />
            </Fragment>
          ))}
        </>
      )}
      {variant === 3 && (
        <>
          <rect x="38" y="14" width="44" height="4" rx="1.2" fill="#cfd3da" />
          <rect x="46" y="24" width="28" height="2" rx="1" fill="#e3e6ec" />
          <rect x="28" y="36" width="64" height="2.2" rx="1" fill="#e3e6ec" />
          <rect x="24" y="44" width="72" height="2.2" rx="1" fill="#e3e6ec" />
          <rect x="32" y="52" width="56" height="2.2" rx="1" fill="#e3e6ec" />
          <rect x="60" y="66" width="22" height="8" rx="1" fill="#e0e3e9" />
          <circle cx="36" cy="70" r="6" fill="none" stroke="#dadde3" strokeWidth="1.2" />
        </>
      )}
    </svg>
  );
}
