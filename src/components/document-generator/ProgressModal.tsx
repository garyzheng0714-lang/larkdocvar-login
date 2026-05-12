import { useEffect, useState } from 'react';
import { Icon } from './icons';
import type { Phase, RecordItem, TableRow } from './types';

interface ProgressModalProps {
  records: TableRow[];
  accent: string;
  onClose: () => void;
  onMinimize: () => void;
}

export function ProgressModal({ records, accent, onClose, onMinimize }: ProgressModalProps) {
  const [items, setItems] = useState<RecordItem[]>(() =>
    records.map((r) => ({ ...r, status: 'pending', error: null })),
  );
  const [phase, setPhase] = useState<Phase>('running');
  const [confirmStop, setConfirmStop] = useState(false);
  const [startedAt] = useState(() => Date.now());

  const counts = {
    total: items.length,
    succeeded: items.filter((i) => i.status === 'succeeded').length,
    failed: items.filter((i) => i.status === 'failed').length,
    pending: items.filter((i) => i.status === 'pending').length,
    processing: items.filter((i) => i.status === 'processing').length,
  };
  const processedCount = counts.succeeded + counts.failed;
  const pct = counts.total === 0 ? 0 : Math.round((processedCount / counts.total) * 100);

  useEffect(() => {
    if (phase !== 'running') return;
    const next = items.findIndex((i) => i.status === 'pending');
    const proc = items.findIndex((i) => i.status === 'processing');
    if (next === -1 && proc === -1) {
      setPhase('done');
      return;
    }
    if (proc === -1 && next !== -1) {
      setItems((s) =>
        s.map((it, idx) => (idx === next ? { ...it, status: 'processing' } : it)),
      );
      return;
    }
    const tid = window.setTimeout(() => {
      setItems((s) =>
        s.map((it, idx) => {
          if (idx !== proc) return it;
          const willFail = (idx + 3) % 9 === 0;
          return willFail
            ? { ...it, status: 'failed', error: '字段 "金额" 为空，未填写' }
            : { ...it, status: 'succeeded' };
        }),
      );
    }, 380 + Math.random() * 320);
    return () => window.clearTimeout(tid);
  }, [items, phase]);

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  const rate = processedCount > 0 && elapsedSec > 0 ? processedCount / elapsedSec : 0.8;
  const eta = rate > 0 ? Math.ceil((counts.total - processedCount) / rate) : null;

  const togglePause = () => setPhase((p) => (p === 'paused' ? 'running' : 'paused'));
  const askStop = () => setConfirmStop(true);
  const doStop = () => {
    setItems((s) =>
      s.map((i) =>
        i.status === 'processing' || i.status === 'pending'
          ? { ...i, status: 'failed', error: '已被用户终止' }
          : i,
      ),
    );
    setPhase('terminated');
    setConfirmStop(false);
  };

  const retryFailed = () => {
    setItems((s) =>
      s.map((i) => (i.status === 'failed' ? { ...i, status: 'pending', error: null } : i)),
    );
    setPhase('running');
  };

  const isDone = phase === 'done' || phase === 'terminated';
  const headerLabel =
    phase === 'paused'
      ? '已暂停'
      : phase === 'terminated'
      ? '已终止'
      : phase === 'done'
      ? counts.failed === 0
        ? '生成完成'
        : '生成完成（含失败）'
      : '正在生成';

  return (
    <div className="modal-scrim">
      <div className="modal">
        <div className="modal-head">
          <div className="modal-head-left">
            <StatusDot phase={phase} failed={counts.failed} accent={accent} />
            <div>
              <div className="modal-title">{headerLabel}</div>
              <div className="modal-sub">
                {phase === 'running' &&
                  `${processedCount} / ${counts.total} · 预计还需 ${eta ?? '–'} 秒`}
                {phase === 'paused' &&
                  `${processedCount} / ${counts.total} 已处理 · 任务暂停中`}
                {phase === 'terminated' &&
                  `已完成 ${counts.succeeded} 份 · ${counts.failed} 份中断`}
                {phase === 'done' &&
                  `${counts.succeeded} 成功 · ${counts.failed} 失败 · 用时 ${elapsedSec} 秒`}
              </div>
            </div>
          </div>
          {!isDone && (
            <button
              className="hdr-icon"
              type="button"
              onClick={onMinimize}
              title="收起到后台"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                <path d="M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
          {isDone && (
            <button className="hdr-icon" type="button" onClick={onClose} title="关闭">
              <Icon.Close />
            </button>
          )}
        </div>

        <div className="bar-wrap">
          <div className="bar-track">
            <div
              className={'bar-fill' + (phase === 'paused' ? ' bar-paused' : '')}
              style={{
                width: pct + '%',
                background:
                  counts.failed > 0
                    ? `linear-gradient(90deg, ${accent} 0%, ${accent} calc(100% - ${
                        (counts.failed / counts.total) * 100
                      }%), #d83931 calc(100% - ${
                        (counts.failed / counts.total) * 100
                      }%), #d83931 100%)`
                    : accent,
              }}
            />
          </div>
          <div className="bar-pct">{pct}%</div>
        </div>

        <div className="stat-strip">
          <div className={'sb sb-ok' + (counts.succeeded ? '' : ' sb-mute')}>
            <Icon.Check />
            <b>{counts.succeeded}</b> 成功
          </div>
          <div className={'sb sb-err' + (counts.failed ? '' : ' sb-mute')}>
            <Icon.Warn />
            <b>{counts.failed}</b> 失败
          </div>
          <div
            className={'sb sb-proc' + (counts.processing ? '' : ' sb-mute')}
            style={counts.processing ? { color: accent } : undefined}
          >
            <span
              className="sb-dot"
              style={counts.processing ? { background: accent } : undefined}
            />
            <b>{counts.processing}</b> 进行中
          </div>
          <div className="sb sb-mute">
            <b>{counts.pending}</b> 待处理
          </div>
        </div>

        <div className="rec-list">
          <div className="rec-head">
            <span>记录</span>
            <span className="rec-head-right">状态</span>
          </div>
          <div className="rec-scroll">
            {items.map((it, i) => (
              <RecordRow key={i} idx={i + 1} item={it} accent={accent} />
            ))}
          </div>
        </div>

        <div className="modal-ftr">
          {phase === 'running' && (
            <>
              <button
                className="btn-ghost btn-danger"
                type="button"
                onClick={askStop}
              >
                <Icon.Stop /> 终止
              </button>
              <button className="btn-ghost" type="button" onClick={togglePause}>
                <Icon.Pause /> 暂停
              </button>
            </>
          )}
          {phase === 'paused' && (
            <>
              <button
                className="btn-ghost btn-danger"
                type="button"
                onClick={askStop}
              >
                <Icon.Stop /> 终止
              </button>
              <button
                className="btn-primary"
                type="button"
                style={{ background: accent }}
                onClick={togglePause}
              >
                <Icon.Play /> 继续
              </button>
            </>
          )}
          {isDone && (
            <>
              {counts.failed > 0 && (
                <button className="btn-ghost" type="button" onClick={retryFailed}>
                  <Icon.Retry /> 重试失败 ({counts.failed})
                </button>
              )}
              <button
                className="btn-primary"
                type="button"
                style={{ background: accent }}
                onClick={onClose}
              >
                <Icon.Download /> 下载全部 ({counts.succeeded})
              </button>
            </>
          )}
        </div>
      </div>

      {confirmStop && (
        <ConfirmStop
          remaining={counts.pending + counts.processing}
          onCancel={() => setConfirmStop(false)}
          onConfirm={doStop}
        />
      )}
    </div>
  );
}

function ConfirmStop({
  remaining,
  onCancel,
  onConfirm,
}: {
  remaining: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="confirm-scrim">
      <div className="confirm">
        <div className="confirm-title">确定终止生成？</div>
        <div className="confirm-text">
          还有 <b>{remaining}</b> 份未完成，终止后将不再继续，
          已生成的 {remaining ? '部分' : ''}文件可以照常下载。
        </div>
        <div className="confirm-ftr">
          <button className="btn-ghost" type="button" onClick={onCancel}>
            再想想
          </button>
          <button className="btn-danger-solid" type="button" onClick={onConfirm}>
            终止任务
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusDot({
  phase,
  failed,
  accent,
}: {
  phase: Phase;
  failed: number;
  accent: string;
}) {
  if (phase === 'paused') return <span className="sd sd-paused" />;
  if (phase === 'terminated') return <span className="sd sd-err" />;
  if (phase === 'done') return <span className={'sd ' + (failed === 0 ? 'sd-ok' : 'sd-warn')} />;
  return <span className="sd sd-run" style={{ ['--sd' as string]: accent } as React.CSSProperties} />;
}

function RecordRow({ idx, item, accent }: { idx: number; item: RecordItem; accent: string }) {
  return (
    <div className={'rec-row rec-' + item.status}>
      <span className="rec-idx">{String(idx).padStart(2, '0')}</span>
      <span className="rec-name">{item.客户名称}</span>
      <span className="rec-status">
        {item.status === 'pending' && <span className="rs rs-pend">待处理</span>}
        {item.status === 'processing' && (
          <span className="rs rs-proc" style={{ color: accent }}>
            <span className="rs-spin" style={{ borderTopColor: accent }} /> 生成中
          </span>
        )}
        {item.status === 'succeeded' && (
          <span className="rs rs-ok">
            <Icon.Check /> 成功
          </span>
        )}
        {item.status === 'failed' && (
          <span className="rs rs-err" title={item.error ?? undefined}>
            <Icon.Warn /> 失败
          </span>
        )}
      </span>
    </div>
  );
}
