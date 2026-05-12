// Secondary screen: template picker. Slides over the primary.

const { useState: useStateP, useMemo: useMemoP } = React;

function PickerScreen({ initialSelectedId, onCancel, onConfirm, onNew, accent }) {
  const { TEMPLATES, CATEGORIES } = window.MockData;
  const [tab, setTab] = useStateP('公用');
  const [category, setCategory] = useStateP('全部');
  const [query, setQuery] = useStateP('');
  const [selectedId, setSelectedId] = useStateP(initialSelectedId);

  const list = useMemoP(() => {
    return TEMPLATES.filter(t =>
      (category === '全部' || t.category === category) &&
      (!query || t.name.includes(query))
    );
  }, [category, query]);

  return (
    <div className="screen picker-screen">
      <header className="hdr hdr-with-back">
        <button className="hdr-icon" onClick={onCancel}><Icon.Back /></button>
        <div className="hdr-title">选择模板</div>
        <button className="hdr-link" onClick={onNew}>新建</button>
      </header>

      <div className="picker-tabs">
        <button
          className={'p-tab' + (tab === '公用' ? ' p-tab-on' : '')}
          onClick={() => setTab('公用')}
        >公用模板</button>
        <button
          className={'p-tab' + (tab === '个人' ? ' p-tab-on' : '')}
          onClick={() => setTab('个人')}
        >个人模板</button>
      </div>

      <div className="picker-controls">
        <div className="search">
          <Icon.Search style={{ opacity:.5, flexShrink:0 }} />
          <input
            placeholder="搜索模板名称"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="cat-chips">
          {CATEGORIES.map(c => (
            <button
              key={c}
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
            {list.map(t => (
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
        <button className="btn-ghost" onClick={onCancel}>取消</button>
        <button
          className="btn-primary"
          style={{ background: accent }}
          disabled={!selectedId}
          onClick={() => onConfirm(TEMPLATES.find(t => t.id === selectedId))}
        >
          确认使用
        </button>
      </footer>
    </div>
  );
}

function TemplateCard({ t, selected, accent, onClick }) {
  return (
    <button
      className={'tcard' + (selected ? ' tcard-on' : '')}
      onClick={onClick}
      style={selected ? { borderColor: accent, boxShadow: `0 0 0 1px ${accent}, 0 2px 8px ${accent}1f` } : null}
    >
      <div className="tcard-thumb">
        <TemplateThumb t={t} />
        {selected && (
          <span className="tcard-tick" style={{ background: accent }}>
            <Icon.Check style={{ color:'#fff' }} />
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

function TemplateThumb({ t }) {
  // Subtle representational thumbnail — light gray document lines.
  // Pick a layout variant by template id hash so each card looks different.
  const variant = (t.id.charCodeAt(t.id.length - 1)) % 4;
  return (
    <svg viewBox="0 0 120 88" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      {/* page */}
      <rect x="14" y="6" width="92" height="76" rx="3" fill="#fff" />
      {variant === 0 && <>
        {/* heading */}
        <rect x="22" y="14" width="44" height="5" rx="1.5" fill="#cfd3da" />
        <rect x="22" y="24" width="76" height="2.5" rx="1" fill="#e3e6ec" />
        <rect x="22" y="30" width="68" height="2.5" rx="1" fill="#e3e6ec" />
        <rect x="22" y="36" width="74" height="2.5" rx="1" fill="#e3e6ec" />
        <rect x="22" y="42" width="40" height="2.5" rx="1" fill="#e3e6ec" />
        <rect x="22" y="52" width="76" height="2.5" rx="1" fill="#e3e6ec" />
        <rect x="22" y="58" width="62" height="2.5" rx="1" fill="#e3e6ec" />
        <rect x="22" y="68" width="30" height="6" rx="1" fill="#dbdfe6" />
        <rect x="56" y="68" width="20" height="6" rx="1" fill="#dbdfe6" />
      </>}
      {variant === 1 && <>
        {/* logo block on top */}
        <circle cx="60" cy="22" r="10" fill="#dadde3" />
        <rect x="36" y="38" width="48" height="3" rx="1.2" fill="#cfd3da" />
        <rect x="32" y="46" width="56" height="2" rx="1" fill="#e3e6ec" />
        <rect x="28" y="54" width="64" height="2" rx="1" fill="#e3e6ec" />
        <rect x="32" y="60" width="56" height="2" rx="1" fill="#e3e6ec" />
        <rect x="40" y="68" width="40" height="2" rx="1" fill="#e3e6ec" />
      </>}
      {variant === 2 && <>
        {/* table-like */}
        <rect x="22" y="14" width="38" height="4" rx="1.2" fill="#cfd3da" />
        {[24,32,40,48,56,64].map((y,i) => (
          <React.Fragment key={i}>
            <rect x="22" y={y} width="76" height="0.8" fill="#dfe2e8" />
            <rect x="22" y={y+2.5} width="20" height="2" rx="0.8" fill="#e7eaef" />
            <rect x="48" y={y+2.5} width="20" height="2" rx="0.8" fill="#e7eaef" />
            <rect x="74" y={y+2.5} width="20" height="2" rx="0.8" fill="#e7eaef" />
          </React.Fragment>
        ))}
      </>}
      {variant === 3 && <>
        {/* certificate look — centered */}
        <rect x="38" y="14" width="44" height="4" rx="1.2" fill="#cfd3da" />
        <rect x="46" y="24" width="28" height="2" rx="1" fill="#e3e6ec" />
        <rect x="28" y="36" width="64" height="2.2" rx="1" fill="#e3e6ec" />
        <rect x="24" y="44" width="72" height="2.2" rx="1" fill="#e3e6ec" />
        <rect x="32" y="52" width="56" height="2.2" rx="1" fill="#e3e6ec" />
        <rect x="60" y="66" width="22" height="8" rx="1" fill="#e0e3e9" />
        <circle cx="36" cy="70" r="6" fill="none" stroke="#dadde3" strokeWidth="1.2"/>
      </>}
    </svg>
  );
}

Object.assign(window, { PickerScreen });
