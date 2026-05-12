// Shared UI primitives + the bitable backdrop layer behind the sidebar.

const { useState, useEffect, useRef, useMemo, useLayoutEffect } = React;

// ─── Icons ─────────────────────────────────────────────────────────
const Icon = {
  Close:    (p) => <svg viewBox="0 0 16 16" width="16" height="16" fill="none" {...p}><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  Back:     (p) => <svg viewBox="0 0 16 16" width="16" height="16" fill="none" {...p}><path d="M10 3l-5 5 5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Chevron:  (p) => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  ChevronR: (p) => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}><path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Search:   (p) => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}><circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.3"/><path d="M10.2 10.2l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
  Check:    (p) => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}><path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Plus:     (p) => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  Image:    (p) => <svg viewBox="0 0 16 16" width="12" height="12" fill="none" {...p}><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.3" stroke="currentColor" strokeWidth="1.2"/><circle cx="5.6" cy="6.2" r="1.1" stroke="currentColor" strokeWidth="1.2"/><path d="M2.4 11.4l3.2-2.7 2.6 2.2 2.4-1.8 3 2.4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>,
  Text:     (p) => <svg viewBox="0 0 16 16" width="12" height="12" fill="none" {...p}><path d="M3 4h10M8 4v9M6 13h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
  Filter:   (p) => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" {...p}><path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
  Help:     (p) => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2"/><path d="M6.4 6.4c.2-1 1-1.6 1.9-1.6 1 0 1.7.7 1.7 1.6 0 1.4-1.7 1.4-1.7 2.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="8" cy="11.3" r=".7" fill="currentColor"/></svg>,
  Doc:      (p) => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}><path d="M3.5 2h6L13 5.5V14H3.5V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M9.3 2v3.5H13" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M5.5 8h5M5.5 10.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
  Sheet:    (p) => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}><rect x="2.5" y="2.5" width="11" height="11" rx="1.2" stroke="currentColor" strokeWidth="1.2"/><path d="M2.5 6.5h11M2.5 10h11M6.2 2.5v11" stroke="currentColor" strokeWidth="1.2"/></svg>,
  Warn:     (p) => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" {...p}><path d="M8 2.4l6 10.6H2L8 2.4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M8 6.5v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><circle cx="8" cy="11" r=".7" fill="currentColor"/></svg>,
  Pause:    (p) => <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" {...p}><rect x="4" y="3" width="2.6" height="10" rx=".6"/><rect x="9.4" y="3" width="2.6" height="10" rx=".6"/></svg>,
  Play:     (p) => <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" {...p}><path d="M4.5 3.2v9.6L13 8 4.5 3.2z"/></svg>,
  Stop:     (p) => <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" {...p}><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>,
  Download: (p) => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}><path d="M8 2.5v8M4.5 7l3.5 3.5L11.5 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M3 13.2h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  Retry:    (p) => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" {...p}><path d="M13 8a5 5 0 1 1-1.5-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><path d="M13.5 2.5V5h-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Folder:   (p) => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" {...p}><path d="M2 4.5C2 3.8 2.5 3.3 3.2 3.3h3l1.2 1.4h5.4c.7 0 1.2.5 1.2 1.2v5.9c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2V4.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>,
  User:     (p) => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" {...p}><circle cx="8" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.3"/><path d="M3.5 13c.6-2 2.4-3.2 4.5-3.2s3.9 1.2 4.5 3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
  Team:     (p) => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" {...p}><circle cx="5.5" cy="6.5" r="2" stroke="currentColor" strokeWidth="1.3"/><circle cx="11" cy="6.5" r="2" stroke="currentColor" strokeWidth="1.3"/><path d="M1.8 12.5c.4-1.5 1.9-2.5 3.7-2.5s3.3 1 3.7 2.5M8.8 12.5c.4-1.5 1.9-2.5 3.7-2.5 1 0 1.9.3 2.5.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
  Sparkle:  (p) => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" {...p}><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
};

// ─── Field type pill (used in dropdowns) ───────────────────────────
function FieldTypeIcon({ type }) {
  const tone = {
    text: '#5b647a', number: '#3d8a6f', date: '#a8662b', phone: '#5b647a',
    person: '#5151b6', select: '#8e4cad', attachment: '#2766b8',
  }[type] || '#5b647a';

  const svg = (() => {
    const s = { stroke: tone, strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' };
    switch (type) {
      case 'text':
        return <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 4h8M8 4v8M6 12h4" {...s}/></svg>;
      case 'number':
        return <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 6h10M3 10h10M6.5 3l-1 10M10.5 3l-1 10" {...s}/></svg>;
      case 'date':
        return <svg viewBox="0 0 16 16" width="12" height="12"><rect x="2.5" y="3.5" width="11" height="10" rx="1.4" {...s}/><path d="M2.5 6.5h11M5.5 2.5v2M10.5 2.5v2" {...s}/></svg>;
      case 'phone':
        return <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 4.5C3.5 3.7 4.2 3 5 3h1.2c.4 0 .7.2.9.6l.7 1.7c.2.5 0 1-.4 1.3l-.7.5c.7 1.4 1.8 2.5 3.2 3.2l.5-.7c.3-.4.8-.6 1.3-.4l1.7.7c.4.2.6.5.6.9V11c0 .8-.7 1.5-1.5 1.5C7.4 12.5 3.5 8.6 3.5 4.5z" {...s}/></svg>;
      case 'person':
        return <svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="6" r="2.5" {...s}/><path d="M3.5 13c.6-2 2.4-3.2 4.5-3.2s3.9 1.2 4.5 3.2" {...s}/></svg>;
      case 'select':
        return <svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="5" {...s}/><circle cx="8" cy="8" r="2" fill={tone} stroke="none"/></svg>;
      case 'attachment':
        return <svg viewBox="0 0 16 16" width="12" height="12"><path d="M11.5 6.5l-4.7 4.7c-1 1-2.6 1-3.5 0-1-1-1-2.6 0-3.5l5.7-5.7c.7-.7 1.7-.7 2.4 0 .7.7.7 1.7 0 2.4L5.6 10.2c-.3.3-.9.3-1.2 0-.3-.3-.3-.9 0-1.2l4.5-4.5" {...s}/></svg>;
      default:
        return <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 4h8M8 4v8M6 12h4" {...s}/></svg>;
    }
  })();

  return (
    <span className="ft" style={{ color: tone }}>
      {svg}
    </span>
  );
}

// ─── Bitable backdrop (faint mock of the surrounding table app) ────
function BitableBackdrop() {
  const { TABLE_FIELDS, TABLE_ROWS } = window.MockData;
  const cols = ['#', '客户名称', '合同金额', '签订日期', '联系人', '状态'];
  return (
    <div className="backdrop">
      <div className="backdrop-topbar">
        <div className="bd-crumb">
          <span className="bd-dot" />
          <span>客户合同台账</span>
          <Icon.ChevronR style={{ opacity:.4 }} />
          <span style={{ color:'#8a90a0' }}>合同登记表</span>
        </div>
        <div className="bd-tabs">
          <span className="bd-tab bd-tab-on">数据表</span>
          <span className="bd-tab">仪表盘</span>
          <span className="bd-tab">表单</span>
          <span className="bd-tab" style={{ opacity:.55 }}>+</span>
        </div>
      </div>
      <div className="backdrop-toolbar">
        <span className="bd-pill bd-pill-on">全部记录 ▾</span>
        <span className="bd-pill">＋ 新增</span>
        <span className="bd-pill">⇅ 排序</span>
        <span className="bd-pill">⏚ 筛选</span>
        <span className="bd-pill">▦ 视图</span>
        <span style={{ flex:1 }} />
        <span className="bd-pill bd-pill-accent">⎙ 生成文档</span>
      </div>
      <div className="backdrop-grid">
        <div className="bd-row bd-head">
          {cols.map((c,i) => <div key={i} className="bd-cell">{c}</div>)}
        </div>
        {TABLE_ROWS.map((r, i) => (
          <div key={i} className={'bd-row' + (i < 6 ? ' bd-row-sel' : '')}>
            <div className="bd-cell bd-cell-idx">{i+1}</div>
            <div className="bd-cell">{r.客户名称}</div>
            <div className="bd-cell" style={{ fontVariantNumeric:'tabular-nums' }}>{r.合同金额}</div>
            <div className="bd-cell">{r.签订日期}</div>
            <div className="bd-cell">{r.联系人}</div>
            <div className="bd-cell">
              <span className={'bd-tag bd-tag-' + (
                r.状态==='已生成'?'ok':r.状态==='失败'?'err':'pend')}>{r.状态}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Generic dropdown menu (portaled, opens below the trigger element) ───
// Pass `triggerRef` (the button) so we can position via fixed coords —
// this avoids being clipped by any ancestor with overflow:hidden/auto.
function Dropdown({ open, onClose, children, align='left', width, triggerRef }) {
  const ref = useRef(null);
  const [pos, setPos] = React.useState(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef?.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const menuW = width || r.width;
    const left = align === 'right' ? (r.right - menuW) : r.left;
    setPos({ top: r.bottom + 4, left, width: menuW });
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target) &&
          triggerRef?.current && !triggerRef.current.contains(e.target)) onClose();
    };
    const onScroll = () => onClose();
    setTimeout(() => document.addEventListener('mousedown', h), 0);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', h);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  if (!open || !pos) return null;
  return ReactDOM.createPortal(
    <div ref={ref} className="dd-menu dd-menu-fixed" style={{ top: pos.top, left: pos.left, width: pos.width }}>
      {children}
    </div>,
    document.body
  );
}

// ─── Tooltip-ish hint pill above a field row ───────────────────────
function Pill({ children, tone='neutral' }) {
  return <span className={'pill pill-' + tone}>{children}</span>;
}

Object.assign(window, {
  Icon, FieldTypeIcon, BitableBackdrop, Dropdown, Pill,
});
