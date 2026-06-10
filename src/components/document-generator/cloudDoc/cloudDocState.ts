import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findBestMatchedField } from '../cloudFieldMapping';
import { AUTO_OUTPUT_FIELD, BATCH_SIZE } from './constants';
import {
  buildBitableSidebarHeaders,
  ensureOutputField,
  getAllRecordIds,
  getCloudDocOutputFields,
  readMappedVariables,
  resolveCloudTable,
} from './bitableAdapter';
import {
  fetchTemplateVariables,
  generateCloudDocuments,
  saveCloudDocAutoConfig,
  toErrorMessage,
} from './cloudDocApi';
import type { CloudDocActions, CloudDocRuntimeInput, CloudDocState, GenerateResult } from './types';

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function useCloudDocState(input: CloudDocRuntimeInput): CloudDocState & CloudDocActions {
  const {
    fields,
    activeTableId,
    selectedRecordIds,
    allRecordIds,
    selectedCount,
    totalRecordCount,
    bitableAvailable,
    refreshBitable,
    demo = false,
  } = input;
  const textFields = useMemo(() => fields.filter((field) => field.type !== 'attachment'), [fields]);
  const outputFields = useMemo(() => getCloudDocOutputFields(fields), [fields]);
  const [templateUrl, setTemplateUrl] = useState('');
  const [templateTitle, setTemplateTitle] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [variables, setVariables] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [outputFieldId, setOutputFieldIdState] = useState(AUTO_OUTPUT_FIELD);
  const [range, setRangeState] = useState<'selected' | 'all'>(selectedCount > 0 ? 'selected' : 'all');
  const [notice, setNotice] = useState<CloudDocState['notice']>(null);
  const [extracting, setExtracting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<CloudDocState['progress']>({ total: 0, done: 0, phase: '' });
  const [results, setResults] = useState<GenerateResult[]>([]);
  const autoSaveTimer = useRef<number | null>(null);
  const extractRunIdRef = useRef(0);
  const generateRunIdRef = useRef(0);
  const generatingRef = useRef(false);
  const extractAbortRef = useRef<AbortController | null>(null);
  const generateAbortRef = useRef<AbortController | null>(null);
  const lastActiveTableIdRef = useRef(activeTableId || '');

  const targetCount = range === 'selected'
    ? selectedRecordIds.length
    : totalRecordCount || allRecordIds.length;
  const unmappedCount = variables.filter((variable) => !mapping[variable]).length;
  const canExtract = demo || templateUrl.trim().length > 0;
  const canGenerate = variables.length > 0 && unmappedCount === 0 && targetCount > 0 && (demo || bitableAvailable);

  const cancelActiveGeneration = useCallback((message: string): boolean => {
    if (!generatingRef.current) return false;
    generateRunIdRef.current += 1;
    generateAbortRef.current?.abort();
    generateAbortRef.current = null;
    generatingRef.current = false;
    setGenerating(false);
    setNotice({ type: 'error', text: message });
    setProgress((current) => current.total > 0 ? { ...current, phase: '已中止' } : current);
    return true;
  }, []);

  useEffect(() => {
    const nextTableId = activeTableId || '';
    if (lastActiveTableIdRef.current !== nextTableId) {
      lastActiveTableIdRef.current = nextTableId;
      cancelActiveGeneration('当前数据表已变化，本次生成已中止，请确认字段绑定后重新生成。');
    }
  }, [activeTableId, cancelActiveGeneration]);

  const saveAutoConfig = useCallback((nextMapping: Record<string, string>, nextOutputFieldId: string) => {
    if (demo || !templateUrl.trim() || !templateTitle) return;
    if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = window.setTimeout(() => {
      void saveCloudDocAutoConfig({
        templateUrl: templateUrl.trim(),
        activeTableId,
        templateTitle,
        documentId,
        mapping: nextMapping,
        outputFieldId: nextOutputFieldId === AUTO_OUTPUT_FIELD ? '' : nextOutputFieldId,
      }).catch((error) => {
        setNotice({ type: 'error', text: `自动保存配置失败：${toErrorMessage(error)}` });
      });
    }, 600);
  }, [activeTableId, demo, documentId, templateTitle, templateUrl]);

  const applyMapping = useCallback((next: Record<string, string>) => {
    setMapping(next);
    cancelActiveGeneration('变量绑定已变化，本次生成已中止，请确认后重新生成。');
    saveAutoConfig(next, outputFieldId);
  }, [cancelActiveGeneration, outputFieldId, saveAutoConfig]);

  const updateOutputFieldId = useCallback((next: string) => {
    setOutputFieldIdState(next);
    cancelActiveGeneration('写回字段已变化，本次生成已中止，请确认后重新生成。');
  }, [cancelActiveGeneration]);

  const updateRange = useCallback((next: 'selected' | 'all') => {
    setRangeState(next);
    cancelActiveGeneration('生成范围已变化，本次生成已中止，请确认后重新生成。');
  }, [cancelActiveGeneration]);

  const extractVariables = useCallback(async () => {
    extractAbortRef.current?.abort();
    const runId = extractRunIdRef.current + 1;
    extractRunIdRef.current = runId;
    const controller = new AbortController();
    extractAbortRef.current = controller;
    setExtracting(true);
    setNotice(null);
    setResults([]);
    try {
      const payload = demo
        ? {
            ok: true as const,
            documentId: 'mock_doc',
            templateTitle: '飞书云文档模板',
            variables: ['客户名称', '签订日期', '联系人'],
          }
        : await fetchTemplateVariables(
            templateUrl.trim(),
            await buildBitableSidebarHeaders(activeTableId),
            controller.signal,
          );

      if (extractRunIdRef.current !== runId || controller.signal.aborted) return;
      const nextMapping = payload.variables.reduce<Record<string, string>>((acc, variable) => {
        acc[variable] = findBestMatchedField(variable, textFields)?.id || '';
        return acc;
      }, {});
      setTemplateTitle(payload.templateTitle);
      setDocumentId(payload.documentId);
      setVariables(payload.variables);
      setMapping(nextMapping);
      saveAutoConfig(nextMapping, outputFieldId);
      setNotice({
        type: 'success',
        text: payload.variables.length > 0
          ? `已提取 ${payload.variables.length} 个变量。`
          : '未识别到变量，请确认模板中使用了 {{变量名}}。',
      });
    } catch (error) {
      if (extractRunIdRef.current !== runId || controller.signal.aborted) return;
      setNotice({ type: 'error', text: `提取变量失败：${toErrorMessage(error)}` });
    } finally {
      if (extractRunIdRef.current === runId) {
        setExtracting(false);
        extractAbortRef.current = null;
      }
    }
  }, [activeTableId, demo, outputFieldId, saveAutoConfig, templateUrl, textFields]);

  const generate = useCallback(async () => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    const runId = generateRunIdRef.current + 1;
    generateRunIdRef.current = runId;
    const controller = new AbortController();
    generateAbortRef.current = controller;
    setGenerating(true);
    setNotice(null);
    setResults([]);
    try {
      if (demo) {
        const count = Math.max(1, targetCount || 3);
        setProgress({ total: count, done: 0, phase: '正在替换变量...' });
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        if (generateRunIdRef.current !== runId || controller.signal.aborted) return;
        const demoResults = Array.from({ length: count }, (_, index): GenerateResult => ({
          recordId: `mock-${index + 1}`,
          status: 'success',
          docUrl: 'https://example.feishu.cn/docx/mock',
          documentTitle: `${templateTitle || '飞书云文档'}-${index + 1}`,
        }));
        setProgress({ total: count, done: count, phase: '已完成' });
        setResults(demoResults);
        setNotice({ type: 'success', text: `已完成：成功 ${count} 条，失败 0 条。` });
        return;
      }

      const table = await resolveCloudTable(activeTableId);
      if (generateRunIdRef.current !== runId || controller.signal.aborted) return;
      const targetIds = range === 'selected'
        ? selectedRecordIds
        : await getAllRecordIds(table);
      if (targetIds.length === 0) throw new Error(range === 'selected' ? '未检测到选中记录。' : '当前表没有可处理的记录。');

      const outputField = await ensureOutputField({ table, fields, outputFieldId, refreshBitable });
      if (generateRunIdRef.current !== runId || controller.signal.aborted) return;
      setOutputFieldIdState(outputField);
      const sidebarHeaders = await buildBitableSidebarHeaders(activeTableId);
      const generated: GenerateResult[] = [];
      const batches = chunk(targetIds, BATCH_SIZE);
      setProgress({ total: targetIds.length, done: 0, phase: '正在读取表格变量...' });

      for (let i = 0; i < batches.length; i += 1) {
        if (generateRunIdRef.current !== runId || controller.signal.aborted) return;
        const records = await readMappedVariables(table, batches[i], variables, mapping);
        if (generateRunIdRef.current !== runId || controller.signal.aborted) return;
        setProgress({
          total: targetIds.length,
          done: Math.min(targetIds.length, i * BATCH_SIZE),
          phase: `正在生成第 ${i + 1}/${batches.length} 批...`,
        });
        const payload = await generateCloudDocuments(templateUrl.trim(), records, sidebarHeaders, controller.signal);
        if (generateRunIdRef.current !== runId || controller.signal.aborted) return;

        for (const item of payload.results) {
          if (generateRunIdRef.current !== runId || controller.signal.aborted) return;
          if (item.status === 'success' && item.docUrl) {
            try {
              await table.setCellValue(outputField, item.recordId, item.docUrl);
              generated.push(item);
            } catch (error) {
              generated.push({
                ...item,
                status: 'failed',
                error: `文档已生成，但写回链接失败：${toErrorMessage(error)}`,
              });
            }
          } else {
            generated.push(item);
          }
        }
        setProgress({
          total: targetIds.length,
          done: Math.min(targetIds.length, generated.length),
          phase: '正在写回生成链接...',
        });
      }

      const failed = generated.filter((item) => item.status === 'failed').length;
      const succeeded = generated.length - failed;
      if (generateRunIdRef.current !== runId || controller.signal.aborted) return;
      setResults(generated);
      setNotice({
        type: failed > 0 ? 'error' : 'success',
        text: `已完成：成功 ${succeeded} 条，失败 ${failed} 条。`,
      });
      await refreshBitable?.();
    } catch (error) {
      if (generateRunIdRef.current !== runId || controller.signal.aborted) return;
      setNotice({ type: 'error', text: `替换失败：${toErrorMessage(error)}` });
    } finally {
      if (generateRunIdRef.current === runId) {
        generatingRef.current = false;
        generateAbortRef.current = null;
        setGenerating(false);
        setProgress((current) => current.total > 0 ? { ...current, done: current.total, phase: '已完成' } : current);
      }
    }
  }, [
    activeTableId,
    demo,
    fields,
    mapping,
    outputFieldId,
    range,
    refreshBitable,
    selectedRecordIds,
    targetCount,
    templateTitle,
    templateUrl,
    variables,
  ]);

  return {
    textFields,
    outputFields,
    templateUrl,
    templateTitle,
    variables,
    mapping,
    outputFieldId,
    range,
    notice,
    extracting,
    generating,
    progress,
    results,
    targetCount,
    unmappedCount,
    canExtract,
    canGenerate,
    setTemplateUrl,
    setRange: updateRange,
    setOutputFieldId: updateOutputFieldId,
    applyMapping,
    saveAutoConfig,
    extractVariables,
    generate,
  };
}
