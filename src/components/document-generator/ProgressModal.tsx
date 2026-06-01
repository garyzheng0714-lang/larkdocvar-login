import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { computeEtaSeconds } from './progressEta';
import type { Counts, Phase, RecordItem } from './types';

interface ProgressModalProps {
  items: RecordItem[];
  phase: Phase;
  counts: Counts;
  startedAt: number;
  accent: string;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRetry: () => void;
  onClose: () => void;
  onMinimize: () => void;
}

export function ProgressModal({
  items,
  phase,
  counts,
  startedAt,
  accent,
  onPause,
  onResume,
  onStop,
  onRetry,
  onClose,
  onMinimize,
}: ProgressModalProps) {
  const [confirmStop, setConfirmStop] = useState(false);
  const tickRef = useRef(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (phase !== 'running') return;
    const id = window.setInterval(() => {
      tickRef.current += 1;
      setTick(tickRef.current);
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  const processedCount = counts.succeeded + counts.failed;
  const downloadableItems = items.filter((item) => item.status === 'succeeded' && item.downloadUrl);
  const pct = counts.total === 0 ? 0 : Math.round((processedCount / counts.total) * 100);
  const elapsedSec = startedAt > 0 ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
  const eta = computeEtaSeconds(processedCount, counts.total, elapsedSec);

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
      : phase === 'idle'
      ? '准备生成'
      : '正在生成';

  const askStop = () => setConfirmStop(true);
  const doStop = () => {
    onStop();
    setConfirmStop(false);
  };
  const downloadAll = () => {
    downloadableItems.forEach((item, index) => {
      window.setTimeout(() => downloadItem(item), index * 120);
    });
  };

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
                  `${processedCount} / ${counts.total} · ${
                    eta !== null ? `预计还需 ${eta} 秒` : '正在估算…'
                  }`}
                {phase === 'paused' &&
                  `${processedCount} / ${counts.total} 已处理 · 任务暂停中`}
                {phase === 'terminated' &&
                  `已完成 ${counts.succeeded} 份 · ${counts.failed} 份中断`}
                {phase === 'done' &&
                  `${counts.succeeded} 成功 · ${counts.failed} 失败 · 用时 ${elapsedSec} 秒`}
                {phase === 'idle' && `${counts.total} 条记录待处理`}
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
                  counts.failed > 0 && counts.total > 0
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
              <RecordRow key={it.id || i} idx={i + 1} item={it} accent={accent} />
            ))}
          </div>
        </div>

        <div className="modal-ftr">
          {phase === 'running' && (
            <>
              <button className="btn-ghost btn-danger" type="button" onClick={askStop}>
                <Icon.Stop /> 终止
              </button>
              <button className="btn-ghost" type="button" onClick={onPause}>
                <Icon.Pause /> 暂停
              </button>
            </>
          )}
          {phase === 'paused' && (
            <>
              <button className="btn-ghost btn-danger" type="button" onClick={askStop}>
                <Icon.Stop /> 终止
              </button>
              <button
                className="btn-primary"
                type="button"
                style={{ background: accent }}
                onClick={onResume}
              >
                <Icon.Play /> 继续
              </button>
            </>
          )}
          {isDone && (
            <>
              {counts.failed > 0 && (
                <button className="btn-ghost" type="button" onClick={onRetry}>
                  <Icon.Retry /> 重试失败 ({counts.failed})
                </button>
              )}
              {downloadableItems.length > 0 ? (
                <button
                  className="btn-primary"
                  type="button"
                  style={{ background: accent }}
                  onClick={downloadAll}
                >
                  <Icon.Download /> 下载全部 ({downloadableItems.length})
                </button>
              ) : (
                <button
                  className="btn-primary"
                  type="button"
                  style={{ background: accent }}
                  onClick={onClose}
                >
                  关闭
                </button>
              )}
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

function downloadItem(item: RecordItem) {
  if (!item.downloadUrl) return;
  const link = document.createElement('a');
  link.href = item.downloadUrl;
  link.download = item.fileName || '';
  link.target = '_blank';
  link.rel = 'noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function StatusDot({ phase, failed, accent }: { phase: Phase; failed: number; accent: string }) {
  if (phase === 'paused') return <span className="sd sd-paused" />;
  if (phase === 'terminated') return <span className="sd sd-err" />;
  if (phase === 'done') return <span className={'sd ' + (failed === 0 ? 'sd-ok' : 'sd-warn')} />;
  if (phase === 'idle') return <span className="sd sd-paused" />;
  return <span className="sd sd-run" style={{ ['--sd' as string]: accent } as React.CSSProperties} />;
}

function RecordRow({ idx, item, accent }: { idx: number; item: RecordItem; accent: string }) {
  return (
    <div className={'rec-row rec-' + item.status}>
      <span className="rec-idx">{String(idx).padStart(2, '0')}</span>
      <span className="rec-main">
        <span className="rec-name">{item.displayName}</span>
        {item.status === 'failed' && item.error ? (
          <span className="rec-error">{item.error}</span>
        ) : null}
      </span>
      <span className="rec-status">
        {item.status === 'pending' && <span className="rs rs-pend">待处理</span>}
        {item.status === 'processing' && (
          <span className="rs rs-proc" style={{ color: accent }}>
            <span className="rs-spin" style={{ borderTopColor: accent }} /> 生成中
          </span>
        )}
        {item.status === 'succeeded' && (
          <>
            <span className={'rs ' + (item.warning ? 'rs-warn' : 'rs-ok')} title={item.warning ?? undefined}>
              {item.warning ? <Icon.Warn /> : <Icon.Check />} {item.warning ? '需下载' : '成功'}
            </span>
            {item.downloadUrl && (
              <button className="rec-download" type="button" onClick={() => downloadItem(item)}>
                下载
              </button>
            )}
          </>
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
