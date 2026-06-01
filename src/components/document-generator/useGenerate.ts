import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bitable } from '@lark-base-open/js-sdk';
import type { IAttachmentField, IOpenAttachment } from '@lark-base-open/js-sdk';
import type {
  Counts,
  GenerateOptions,
  GenerateRunner,
  Phase,
  RecordItem,
  RecordSpec,
} from './types';
import { CUSTOM_MAPPING_VALUE } from './mapping';
import { runBatchSlices } from './useBatchRunner';

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

type ImageVariablePayload = Record<string, { urls: string[] }>;

interface BatchRecordResponse {
  recordId: string;
  ok?: boolean;
  status?: 'succeeded' | 'failed';
  error?: string;
  download?: {
    url?: string;
    fileName?: string;
    contentType?: string;
    fileBase64?: string;
  };
  downloadUrl?: string;
  url?: string;
  fileName?: string;
  contentType?: string;
  fileBase64?: string;
}

interface NormalizedBatchRecord {
  recordId: string;
  ok: boolean;
  error?: string;
  downloadUrl?: string;
  fileName?: string;
  contentType?: string;
  fileBase64?: string;
}

function normalizeBatchRecord(record: BatchRecordResponse): NormalizedBatchRecord {
  const downloadUrl = record.download?.url || record.downloadUrl || record.url;
  return {
    recordId: record.recordId,
    ok: record.ok === true || record.status === 'succeeded',
    error: record.error,
    downloadUrl,
    fileName: record.download?.fileName || record.fileName || 'document.docx',
    contentType: record.download?.contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileBase64: record.download?.fileBase64,
  };
}

function expiresInSeconds(label: string): number | undefined {
  if (label === '1 小时') return 60 * 60;
  if (label === '24 小时') return 24 * 60 * 60;
  if (label === '7 天') return 7 * 24 * 60 * 60;
  return undefined;
}

async function readAttachmentUrls(
  tableId: string,
  fieldId: string,
  recordId: string,
): Promise<string[]> {
  try {
    const table = await bitable.base.getTableById(tableId);
    const value = await table.getCellValue(fieldId, recordId);
    if (!Array.isArray(value)) return [];
    const urls: string[] = [];
    for (const item of value) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        const url = (obj.url ?? obj.tmp_url ?? obj.downloadUrl) as string | undefined;
        if (typeof url === 'string' && url) urls.push(url);
      }
    }
    return urls;
  } catch {
    return [];
  }
}

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

function parseImageUrls(value: string | undefined): string[] {
  return (value || '')
    .split(/[\n,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeImageVariableName(name: string): string {
  const value = name.trim();
  if (value.startsWith('image:')) return value.slice('image:'.length).trim();
  if (value.startsWith('图片:')) return value.slice('图片:'.length).trim();
  return value;
}

function base64ToFile(base64: string, fileName: string, contentType: string): File {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes.buffer], fileName, { type: contentType });
}

async function downloadAsFile(url: string, fileName: string, contentType: string, signal: AbortSignal): Promise<File> {
  const response = await fetch(url, { credentials: url.startsWith('/') ? 'include' : 'omit', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  return new File([blob], fileName, { type: blob.type || contentType });
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
  const activeRunIdRef = useRef(0);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const counts = useMemo(() => computeCounts(items), [items]);

  const writeBack = useCallback(
    async (
      tableId: string,
      recordId: string,
      file: { url: string; fileName: string; contentType: string; fileBase64?: string },
      writeBackField: string,
      signal: AbortSignal,
    ): Promise<string | null> => {
      if (!writeBackField) return null;
      if (signal.aborted) return null;
      try {
        const table = await bitable.base.getTableById(tableId);
        if (signal.aborted) return null;
        const field = await table.getField<IAttachmentField>(writeBackField);
        if (signal.aborted) return null;
        const uploadFile = file.fileBase64
          ? base64ToFile(file.fileBase64, file.fileName, file.contentType)
          : await downloadAsFile(file.url, file.fileName, file.contentType, signal);
        if (signal.aborted) return null;
        const current = await field.getValue(recordId).catch((): IOpenAttachment[] => []);
        if (signal.aborted) return null;
        const existing = Array.isArray(current) ? current : [];
        const uploaded = await field.transform(uploadFile);
        if (signal.aborted) return null;
        await table.setCellValue(writeBackField, recordId, [...existing, ...uploaded]);
        return null;
      } catch {
        return '生成成功，但写回附件字段失败，请手动下载。';
      }
    },
    [],
  );

  const runBatch = useCallback(
    async (tableId: string | null, slice: RecordSpec[], options: GenerateOptions, runId: number, signal: AbortSignal) => {
      if (!options.template) return;
      if (activeRunIdRef.current !== runId || signal.aborted) return;
      const sliceIds = new Set(slice.map((s) => s.id));
      setItems((prev) =>
        prev.map((it) => (sliceIds.has(it.id) ? { ...it, status: 'processing' } : it)),
      );

      const ttlSeconds = expiresInSeconds(options.expires);
      const prepared = await Promise.all(
        slice.map(async (r) => {
          const variables: Record<string, string> = {};
          const imageVariables: ImageVariablePayload = {};
          const missing: string[] = [];
          for (const v of options.template?.variables ?? []) {
            const fieldId = options.mapping[v.name];
            if (v.kind === 'image') {
              const imageName = normalizeImageVariableName(v.name);
              if (fieldId && fieldId !== CUSTOM_MAPPING_VALUE && tableId) {
                const urls = await readAttachmentUrls(tableId, fieldId, r.id);
                if (urls.length > 0) imageVariables[imageName] = { urls };
              } else if (fieldId === CUSTOM_MAPPING_VALUE || options.sourceMode === 'standalone') {
                const urls = parseImageUrls(options.customText[v.name]);
                if (urls.length > 0) imageVariables[imageName] = { urls };
              }
              if (!imageVariables[imageName]) missing.push(`图片变量「${v.name}」`);
              continue;
            }
            if (fieldId === CUSTOM_MAPPING_VALUE || options.sourceMode === 'standalone' || !tableId) {
              variables[v.name] = options.customText[v.name] ?? '';
            } else if (fieldId) {
              variables[v.name] = await readCellString(tableId, fieldId, r.id);
            } else {
              variables[v.name] = '';
            }
            if (options.onMissing === '停止该条' && !variables[v.name].trim()) {
              missing.push(`变量「${v.name}」`);
            }
          }
          if (missing.length > 0 && options.onMissing === '停止该条') {
            return { recordId: r.id, error: `${missing.join('、')}为空。` };
          }
          const fileName = interpolateFileName(options.fileNameTpl, variables);
          const payload: Record<string, unknown> = {
            recordId: r.id,
            variables,
            missingStrategy: options.onMissing === '留空继续' ? 'blank' : 'fail',
            output: {
              fileName,
              ...(ttlSeconds ? { expiresInSeconds: ttlSeconds } : {}),
              ...(options.writeBackField ? { includeFileBase64: true } : {}),
            },
          };
          if (Object.keys(imageVariables).length > 0) payload.imageVariables = imageVariables;
          return { recordId: r.id, payload };
        }),
      );

      const localFailures = prepared.filter((item): item is { recordId: string; error: string } => Boolean(item.error));
      if (activeRunIdRef.current !== runId || signal.aborted) return;
      if (localFailures.length > 0) {
        const errorsById = new Map(localFailures.map((item) => [item.recordId, item.error]));
        setItems((prev) =>
          prev.map((it) =>
            errorsById.has(it.id)
              ? { ...it, status: 'failed' as const, error: errorsById.get(it.id) || '变量为空' }
              : it,
          ),
        );
      }

      const batchPayload = prepared
        .filter((item): item is { recordId: string; payload: Record<string, unknown> } => Boolean(item.payload))
        .map((item) => item.payload);
      if (batchPayload.length === 0) return;

      try {
        if (activeRunIdRef.current !== runId || signal.aborted) return;
        const res = await fetch('/api/v1/document-renders/batch', {
          method: 'POST',
          credentials: 'include',
          signal,
          headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              template: { format: 'docx', templateId: options.template.id },
              missingStrategy: options.onMissing === '留空继续' ? 'blank' : 'fail',
              records: batchPayload,
            }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          ok?: boolean;
          records?: BatchRecordResponse[];
          error?: string;
        };
        if (!json.ok || !Array.isArray(json.records)) {
          throw new Error(json.error || '批量生成接口返回异常');
        }
        if (activeRunIdRef.current !== runId || signal.aborted) return;
        const normalized = json.records.map(normalizeBatchRecord);
        const byId = new Map(normalized.map((r) => [r.recordId, r]));
        const warnings = new Map<string, string>();
        for (const r of json.records) {
          if (activeRunIdRef.current !== runId || signal.aborted) return;
          const item = normalizeBatchRecord(r);
          if (item.ok && item.downloadUrl) {
            const warning = tableId
              ? await writeBack(
                  tableId,
                  item.recordId,
                  {
                    url: item.downloadUrl,
                    fileName: item.fileName || 'document.docx',
                    contentType: item.contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    fileBase64: item.fileBase64,
                  },
                  options.writeBackField,
                  signal,
                )
              : null;
            if (warning) warnings.set(item.recordId, warning);
          }
        }
        if (activeRunIdRef.current !== runId || signal.aborted) return;
        setItems((prev) =>
          prev.map((it) => {
            const r = byId.get(it.id);
            if (!r) return it;
            if (r.ok && r.downloadUrl) {
              return {
                ...it,
                status: 'succeeded' as const,
                downloadUrl: r.downloadUrl,
                fileName: r.fileName,
                warning: warnings.get(r.recordId) || null,
                error: null,
              };
            }
            return { ...it, status: 'failed' as const, error: r.error || '生成成功但没有返回下载链接' };
          }),
        );
      } catch (err) {
        if (activeRunIdRef.current !== runId || signal.aborted) return;
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
      if (runningRef.current) return;
      runningRef.current = true;
      const runId = activeRunIdRef.current + 1;
      activeRunIdRef.current = runId;
      const controller = new AbortController();
      abortRef.current = controller;
      lastOptionsRef.current = options;
      setStartedAt(Date.now());
      setItems(records.map((r) => ({ ...r, status: 'pending', error: null })));
      setPhase('running');
      const tableId = await getActiveTableId();
      if (activeRunIdRef.current !== runId || controller.signal.aborted) return;
      if (!tableId && options.sourceMode !== 'standalone') {
        setItems((prev) =>
          prev.map((it) => ({ ...it, status: 'failed' as const, error: '未获取到当前数据表' })),
        );
        setPhase('terminated');
        runningRef.current = false;
        abortRef.current = null;
        return;
      }
      try {
        const result = await runBatchSlices({
          records,
          batchSize: BATCH_SIZE,
          isInterrupted: () =>
            (phaseRef.current as Phase) === 'terminated'
            || activeRunIdRef.current !== runId
            || controller.signal.aborted,
          isPaused: () => (phaseRef.current as Phase) === 'paused',
          runSlice: (slice) => runBatch(tableId, slice, options, runId, controller.signal),
        });
        if (result === 'completed') setPhase('done');
      } finally {
        if (activeRunIdRef.current === runId) {
          runningRef.current = false;
          abortRef.current = null;
        }
      }
    },
    [runBatch],
  );

  const retry = useCallback(async () => {
    const options = lastOptionsRef.current;
    if (!options) return;
    if (runningRef.current) return;
    const failedSpecs: RecordSpec[] = itemsRef.current
      .filter((i) => i.status === 'failed')
      .map((i) => ({ id: i.id, displayName: i.displayName }));
    if (failedSpecs.length === 0) return;
    runningRef.current = true;
    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;
    const controller = new AbortController();
    abortRef.current = controller;
    setItems((prev) =>
      prev.map((i) => (i.status === 'failed' ? { ...i, status: 'pending', error: null } : i)),
    );
    setPhase('running');
    const tableId = await getActiveTableId();
    if (activeRunIdRef.current !== runId || controller.signal.aborted) return;
    if (!tableId && options.sourceMode !== 'standalone') {
      const retryIds = new Set(failedSpecs.map((item) => item.id));
      setItems((prev) =>
        prev.map((it) =>
          retryIds.has(it.id)
            ? { ...it, status: 'failed' as const, error: '未获取到当前数据表' }
            : it,
        ),
      );
      setPhase('terminated');
      runningRef.current = false;
      abortRef.current = null;
      return;
    }
    try {
      const result = await runBatchSlices({
        records: failedSpecs,
        batchSize: BATCH_SIZE,
        isInterrupted: () =>
          (phaseRef.current as Phase) === 'terminated'
          || activeRunIdRef.current !== runId
          || controller.signal.aborted,
        isPaused: () => (phaseRef.current as Phase) === 'paused',
        runSlice: (slice) => runBatch(tableId, slice, options, runId, controller.signal),
      });
      if (result === 'completed') setPhase('done');
    } finally {
      if (activeRunIdRef.current === runId) {
        runningRef.current = false;
        abortRef.current = null;
      }
    }
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
      activeRunIdRef.current += 1;
      runningRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
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
      activeRunIdRef.current += 1;
      runningRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      setItems([]);
      setPhase('idle');
    },
  };
}
