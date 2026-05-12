import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bitable } from '@lark-base-open/js-sdk';
import type {
  Counts,
  GenerateOptions,
  GenerateRunner,
  Phase,
  RecordItem,
  RecordSpec,
} from './types';

function computeCounts(items: RecordItem[]): Counts {
  return {
    total: items.length,
    succeeded: items.filter((i) => i.status === 'succeeded').length,
    failed: items.filter((i) => i.status === 'failed').length,
    pending: items.filter((i) => i.status === 'pending').length,
    processing: items.filter((i) => i.status === 'processing').length,
  };
}

export function useGenerateMock(): GenerateRunner {
  const [items, setItems] = useState<RecordItem[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [startedAt, setStartedAt] = useState(0);

  useEffect(() => {
    if (phase !== 'running') return;
    const next = items.findIndex((i) => i.status === 'pending');
    const proc = items.findIndex((i) => i.status === 'processing');
    if (next === -1 && proc === -1) {
      setPhase('done');
      return;
    }
    if (proc === -1 && next !== -1) {
      setItems((s) => s.map((it, idx) => (idx === next ? { ...it, status: 'processing' } : it)));
      return;
    }
    const tid = window.setTimeout(() => {
      setItems((s) =>
        s.map((it, idx) => {
          if (idx !== proc) return it;
          const willFail = (idx + 3) % 9 === 0;
          return willFail
            ? { ...it, status: 'failed' as const, error: '字段 "金额" 为空，未填写' }
            : { ...it, status: 'succeeded' as const };
        }),
      );
    }, 380 + Math.random() * 320);
    return () => window.clearTimeout(tid);
  }, [items, phase]);

  const counts = useMemo(() => computeCounts(items), [items]);

  return {
    items,
    phase,
    counts,
    startedAt,
    start: (records) => {
      setStartedAt(Date.now());
      setItems(records.map((r) => ({ ...r, status: 'pending', error: null })));
      setPhase('running');
    },
    pause: () => setPhase((p) => (p === 'running' ? 'paused' : p)),
    resume: () => setPhase((p) => (p === 'paused' ? 'running' : p)),
    stop: () => {
      setItems((s) =>
        s.map((i) =>
          i.status === 'pending' || i.status === 'processing'
            ? { ...i, status: 'failed', error: '已被用户终止' }
            : i,
        ),
      );
      setPhase('terminated');
    },
    retry: () => {
      setItems((s) =>
        s.map((i) => (i.status === 'failed' ? { ...i, status: 'pending', error: null } : i)),
      );
      setPhase('running');
    },
    reset: () => {
      setItems([]);
      setPhase('idle');
    },
  };
}

const BATCH_SIZE = 10;

async function readCellString(
  tableId: string,
  fieldId: string,
  recordId: string,
): Promise<string> {
  try {
    const table = await bitable.base.getTableById(tableId);
    const ext = table as unknown as {
      getCellString?: (f: string, r: string) => Promise<string>;
    };
    if (typeof ext.getCellString === 'function') {
      return String((await ext.getCellString(fieldId, recordId)) ?? '');
    }
    const value = await table.getCellValue(fieldId, recordId);
    if (Array.isArray(value)) {
      return value
        .map((v) => {
          if (v && typeof v === 'object' && 'text' in v) {
            return String((v as { text: unknown }).text ?? '');
          }
          return String(v ?? '');
        })
        .join('');
    }
    return String(value ?? '');
  } catch {
    return '';
  }
}

function interpolateFileName(tpl: string, variables: Record<string, string>): string {
  const out = tpl.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => {
    const v = variables[name];
    return v != null && v !== '' ? v : '';
  });
  return (
    out
      .replace(/^[\s\-_、,，]+/, '')
      .replace(/[\s\-_、,，]+$/, '')
      .trim() || '未命名'
  );
}

async function getActiveTableId(): Promise<string | null> {
  try {
    const sel = await bitable.base.getSelection();
    if (sel?.tableId) return sel.tableId;
  } catch {
    // ignore
  }
  try {
    const t = await bitable.base.getActiveTable();
    return (t as unknown as { id: string }).id ?? null;
  } catch {
    return null;
  }
}

export function useGenerateReal(): GenerateRunner {
  const [items, setItems] = useState<RecordItem[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [startedAt, setStartedAt] = useState(0);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;
  const itemsRef = useRef<RecordItem[]>(items);
  itemsRef.current = items;
  const lastOptionsRef = useRef<GenerateOptions | null>(null);

  const counts = useMemo(() => computeCounts(items), [items]);

  const writeBack = useCallback(
    async (tableId: string, recordId: string, url: string, fileName: string, writeBackField: string) => {
      if (!writeBackField) return;
      try {
        const table = await bitable.base.getTableById(tableId);
        const ext = table as unknown as {
          setCellValue: (fieldId: string, recordId: string, value: unknown) => Promise<unknown>;
        };
        await ext.setCellValue(writeBackField, recordId, [{ name: fileName, url }]);
      } catch {
        // writeback errors are non-fatal — surface via item.error if you need
      }
    },
    [],
  );

  const runBatch = useCallback(
    async (tableId: string, slice: RecordSpec[], options: GenerateOptions) => {
      if (!options.template) return;
      const sliceIds = new Set(slice.map((s) => s.id));
      setItems((prev) =>
        prev.map((it) => (sliceIds.has(it.id) ? { ...it, status: 'processing' } : it)),
      );

      const batchPayload = await Promise.all(
        slice.map(async (r) => {
          const variables: Record<string, string> = {};
          for (const v of options.template?.variables ?? []) {
            if (v.kind === 'image') continue;
            const fieldId = options.mapping[v.name];
            if (fieldId === '__custom__') {
              variables[v.name] = options.customText[v.name] ?? '';
            } else if (fieldId) {
              variables[v.name] = await readCellString(tableId, fieldId, r.id);
            } else {
              variables[v.name] = '';
            }
          }
          const fileName = interpolateFileName(options.fileNameTpl, variables);
          return { recordId: r.id, variables, output: { fileName } };
        }),
      );

      try {
        const res = await fetch('/api/v1/document-renders/batch', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            template: { format: 'docx', templateId: options.template.id },
            records: batchPayload,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          ok?: boolean;
          records?: Array<{
            recordId: string;
            status?: 'succeeded' | 'failed';
            error?: string;
            downloadUrl?: string;
            url?: string;
            fileName?: string;
          }>;
          error?: string;
        };
        if (!json.ok || !Array.isArray(json.records)) {
          throw new Error(json.error || '批量生成接口返回异常');
        }
        const byId = new Map(json.records.map((r) => [r.recordId, r]));
        for (const r of json.records) {
          if (r.status === 'succeeded' && (r.downloadUrl || r.url)) {
            const fileName = r.fileName || 'document.docx';
            await writeBack(
              tableId,
              r.recordId,
              (r.downloadUrl || r.url) as string,
              fileName,
              options.writeBackField,
            );
          }
        }
        setItems((prev) =>
          prev.map((it) => {
            const r = byId.get(it.id);
            if (!r) return it;
            if (r.status === 'succeeded') {
              return {
                ...it,
                status: 'succeeded' as const,
                downloadUrl: r.downloadUrl || r.url,
                error: null,
              };
            }
            return { ...it, status: 'failed' as const, error: r.error || '生成失败' };
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setItems((prev) =>
          prev.map((it) =>
            sliceIds.has(it.id) ? { ...it, status: 'failed' as const, error: message } : it,
          ),
        );
      }
    },
    [writeBack],
  );

  const start = useCallback(
    async (records: RecordSpec[], options?: GenerateOptions) => {
      if (!options || !options.template) return;
      lastOptionsRef.current = options;
      setStartedAt(Date.now());
      setItems(records.map((r) => ({ ...r, status: 'pending', error: null })));
      setPhase('running');
      const tableId = await getActiveTableId();
      if (!tableId) {
        setItems((prev) =>
          prev.map((it) => ({ ...it, status: 'failed' as const, error: '未获取到当前数据表' })),
        );
        setPhase('terminated');
        return;
      }
      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        if ((phaseRef.current as Phase) === 'terminated') return;
        while ((phaseRef.current as Phase) === 'paused') {
          await new Promise((r) => window.setTimeout(r, 200));
          if ((phaseRef.current as Phase) === 'terminated') return;
        }
        await runBatch(tableId, records.slice(i, i + BATCH_SIZE), options);
      }
      if ((phaseRef.current as Phase) !== 'terminated') setPhase('done');
    },
    [runBatch],
  );

  const retry = useCallback(async () => {
    const options = lastOptionsRef.current;
    if (!options) return;
    const failedSpecs: RecordSpec[] = itemsRef.current
      .filter((i) => i.status === 'failed')
      .map((i) => ({ id: i.id, displayName: i.displayName }));
    if (failedSpecs.length === 0) return;
    setItems((prev) =>
      prev.map((i) => (i.status === 'failed' ? { ...i, status: 'pending', error: null } : i)),
    );
    setPhase('running');
    const tableId = await getActiveTableId();
    if (!tableId) return;
    for (let i = 0; i < failedSpecs.length; i += BATCH_SIZE) {
      if ((phaseRef.current as Phase) === 'terminated') return;
      while ((phaseRef.current as Phase) === 'paused') {
        await new Promise((r) => window.setTimeout(r, 200));
        if ((phaseRef.current as Phase) === 'terminated') return;
      }
      await runBatch(tableId, failedSpecs.slice(i, i + BATCH_SIZE), options);
    }
    if ((phaseRef.current as Phase) !== 'terminated') setPhase('done');
  }, [runBatch]);

  return {
    items,
    phase,
    counts,
    startedAt,
    start,
    pause: () => setPhase((p) => (p === 'running' ? 'paused' : p)),
    resume: () => setPhase((p) => (p === 'paused' ? 'running' : p)),
    stop: () => {
      setItems((prev) =>
        prev.map((i) =>
          i.status === 'processing' || i.status === 'pending'
            ? { ...i, status: 'failed' as const, error: '已被用户终止' }
            : i,
        ),
      );
      setPhase('terminated');
    },
    retry,
    reset: () => {
      setItems([]);
      setPhase('idle');
    },
  };
}
