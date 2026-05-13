import { useCallback, useEffect, useState } from 'react';
import { FieldType, bitable } from '@lark-base-open/js-sdk';
import type { ITable } from '@lark-base-open/js-sdk';
import type { TableField, FieldKind } from './types';

function mapBitableType(t: number): FieldKind {
  switch (t) {
    case FieldType.Text:
      return 'text';
    case FieldType.Number:
    case FieldType.Currency:
    case FieldType.Progress:
    case FieldType.Rating:
      return 'number';
    case FieldType.DateTime:
    case FieldType.CreatedTime:
    case FieldType.ModifiedTime:
      return 'date';
    case FieldType.Phone:
      return 'phone';
    case FieldType.User:
    case FieldType.CreatedUser:
    case FieldType.ModifiedUser:
    case FieldType.GroupChat:
      return 'person';
    case FieldType.SingleSelect:
    case FieldType.MultiSelect:
      return 'select';
    case FieldType.Attachment:
      return 'attachment';
    default:
      return 'text';
  }
}

interface RawFieldMeta {
  id?: string;
  fieldId?: string;
  name?: string;
  fieldName?: string;
  type?: number | string;
  fieldType?: number | string;
}

function normalizeField(raw: unknown): TableField | null {
  const v = raw as RawFieldMeta;
  const id = (v.id ?? v.fieldId) as string | undefined;
  const name = (v.name ?? v.fieldName) as string | undefined;
  if (!id || !name) return null;
  const typeNum = Number(v.type ?? v.fieldType ?? FieldType.Text);
  return {
    id,
    name,
    type: mapBitableType(Number.isFinite(typeNum) ? typeNum : FieldType.Text),
    icon: '',
  };
}

async function getSelectedRecordIds(table: ITable): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const selection = await bitable.base.getSelection();
    if (selection.recordId) ids.add(selection.recordId);
  } catch {
    // ignore
  }
  try {
    const activeView = await table.getActiveView();
    const ext = activeView as unknown as { getSelectedRecordIdList?: () => Promise<string[]> };
    if (typeof ext.getSelectedRecordIdList === 'function') {
      const fromView = await ext.getSelectedRecordIdList();
      for (const id of fromView || []) if (id) ids.add(id);
    }
  } catch {
    // ignore
  }
  return Array.from(ids);
}

async function resolveActiveTable(): Promise<ITable | null> {
  let selection: { tableId?: string | null } | null = null;
  try {
    selection = await bitable.base.getSelection();
  } catch {
    selection = null;
  }
  if (selection?.tableId) {
    try {
      return await bitable.base.getTableById(selection.tableId);
    } catch {
      // fall through
    }
  }
  try {
    const active = await bitable.base.getActiveTable();
    if (active) return active;
  } catch {
    // fall through
  }
  try {
    const list = await bitable.base.getTableList();
    return list[0] ?? null;
  } catch {
    return null;
  }
}

export interface BitableContext {
  available: boolean;
  fields: TableField[];
  selectedRecordIds: string[];
  selectedCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createAttachmentField: (name?: string) => Promise<TableField>;
  totalRecordCount: number;
  allRecordIds: string[];
}

export function useBitable(): BitableContext {
  const [fields, setFields] = useState<TableField[]>([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [allRecordIds, setAllRecordIds] = useState<string[]>([]);
  const [totalRecordCount, setTotalRecordCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const table = await resolveActiveTable();
      if (!table) {
        setAvailable(false);
        setFields([]);
        setSelectedRecordIds([]);
        setAllRecordIds([]);
        setTotalRecordCount(0);
        setError('未获取到当前数据表，请在飞书多维表格边栏中运行。');
        return;
      }
      setAvailable(true);
      const rawList = (await table.getFieldMetaList()) as unknown[];
      const normalized: TableField[] = [];
      const seen = new Set<string>();
      for (const item of rawList) {
        const meta = normalizeField(item);
        if (meta && !seen.has(meta.id)) {
          seen.add(meta.id);
          normalized.push(meta);
        }
      }
      setFields(normalized);
      setSelectedRecordIds(await getSelectedRecordIds(table));
      try {
        const collected: string[] = [];
        let pageToken: number | undefined;
        for (let i = 0; i < 5; i += 1) {
          const page = await table.getRecordIdListByPage({ pageSize: 200, pageToken });
          collected.push(...page.recordIds);
          if (!page.hasMore) break;
          pageToken = page.pageToken;
        }
        setAllRecordIds(collected);
        setTotalRecordCount(collected.length);
      } catch {
        setAllRecordIds([]);
        setTotalRecordCount(0);
      }
    } catch (err) {
      setAvailable(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const createAttachmentField = useCallback(async (name = '生成文档'): Promise<TableField> => {
    const table = await resolveActiveTable();
    if (!table) {
      throw new Error('未获取到当前数据表，请在飞书多维表格边栏中运行。');
    }
    const usedNames = new Set(fields.map((f) => f.name.trim()).filter(Boolean));
    let fieldName = name.trim() || '生成文档';
    if (usedNames.has(fieldName)) {
      let i = 2;
      while (usedNames.has(`${fieldName} ${i}`)) i += 1;
      fieldName = `${fieldName} ${i}`;
    }
    const id = await table.addField({
      name: fieldName,
      type: FieldType.Attachment,
      property: { onlyMobile: false },
    });
    const created: TableField = { id, name: fieldName, type: 'attachment', icon: '' };
    setFields((prev) => {
      if (prev.some((f) => f.id === id)) return prev;
      return [...prev, created];
    });
    void refresh();
    return created;
  }, [fields, refresh]);

  useEffect(() => {
    let disposed = false;
    let unbind: (() => void) | undefined;
    void (async () => {
      try {
        await refresh();
      } catch {
        // refresh handles its own errors
      }
      if (disposed) return;
      try {
        unbind = bitable.base.onSelectionChange(() => {
          void refresh();
        });
      } catch {
        // ignore — running outside Bitable host
      }
    })();
    return () => {
      disposed = true;
      unbind?.();
    };
  }, [refresh]);

  return {
    available,
    fields,
    selectedRecordIds,
    selectedCount: selectedRecordIds.length,
    loading,
    error,
    refresh,
    createAttachmentField,
    totalRecordCount,
    allRecordIds,
  };
}
