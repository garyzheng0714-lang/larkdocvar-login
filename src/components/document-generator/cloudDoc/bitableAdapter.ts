import { FieldType, bitable } from '@lark-base-open/js-sdk';
import type { ITable } from '@lark-base-open/js-sdk';
import { stringifyCellValue } from '../cloudFieldMapping';
import type { TableField } from '../types';
import { AUTO_OUTPUT_FIELD } from './constants';

const CLOUD_DOC_OUTPUT_RAW_TYPES = new Set<number>([
  FieldType.Text,
  FieldType.Url,
  FieldType.Object,
]);
const SIDEBAR_REQUIRED_TIMEOUT_MS = 3000;
const SIDEBAR_OPTIONAL_REQUEST_TIMEOUT_MS = 2000;

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Bitable sidebar SDK timeout')), timeoutMs);
    task.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function optionalWithTimeout<T>(task: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  try {
    return await withTimeout(task, timeoutMs);
  } catch {
    return fallback;
  }
}

export async function resolveCloudTable(activeTableId?: string | null): Promise<ITable> {
  if (activeTableId) {
    return bitable.base.getTableById(activeTableId);
  }
  const selection = await bitable.base.getSelection().catch(() => null);
  if (selection?.tableId) {
    return bitable.base.getTableById(selection.tableId);
  }
  return bitable.base.getActiveTable();
}

export async function buildBitableSidebarHeaders(activeTableId?: string | null, timeoutMs = SIDEBAR_REQUIRED_TIMEOUT_MS): Promise<Record<string, string>> {
  const [selection, openId, baseUserId, tenantKey] = await Promise.all([
    withTimeout(bitable.base.getSelection().catch(() => null), timeoutMs),
    optionalWithTimeout(bitable.bridge.getUserId().catch(() => ''), '', timeoutMs),
    optionalWithTimeout(bitable.bridge.getBaseUserId().catch(() => ''), '', timeoutMs),
    optionalWithTimeout(bitable.bridge.getTenantKey().catch(() => ''), '', timeoutMs),
  ]);
  const baseId = selection?.baseId || '';
  const tableId = activeTableId || selection?.tableId || '';
  if (!baseId || !tableId) {
    throw new Error('请在飞书多维表格侧边栏中打开插件后再操作。');
  }
  return {
    'Content-Type': 'application/json',
    ...(openId ? { 'X-Bitable-Open-Id': openId } : {}),
    'X-Bitable-Base-Id': baseId,
    'X-Bitable-Table-Id': tableId,
    ...(baseUserId ? { 'X-Bitable-Base-User-Id': baseUserId } : {}),
    ...(tenantKey ? { 'X-Bitable-Tenant-Key': tenantKey } : {}),
  };
}

export async function buildOptionalBitableSidebarHeaders(activeTableId?: string | null, timeoutMs = SIDEBAR_OPTIONAL_REQUEST_TIMEOUT_MS): Promise<Record<string, string>> {
  try {
    return await buildBitableSidebarHeaders(activeTableId, timeoutMs);
  } catch {
    return {};
  }
}

export async function getAllRecordIds(table: ITable): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: number | undefined;
  while (true) {
    const page = await table.getRecordIdListByPage({ pageSize: 200, pageToken });
    ids.push(...page.recordIds);
    if (!page.hasMore) break;
    pageToken = page.pageToken;
  }
  return ids;
}

export async function readMappedVariables(
  table: ITable,
  recordIds: string[],
  variables: string[],
  mapping: Record<string, string>,
): Promise<Array<{ recordId: string; variables: Record<string, string> }>> {
  const pending = new Set(recordIds);
  const rows = new Map<string, Record<string, unknown>>();
  let pageToken: number | undefined;

  while (pending.size > 0) {
    const page = await table.getRecordsByPage({ pageSize: 200, pageToken, stringValue: true });
    for (const record of page.records) {
      if (!pending.has(record.recordId)) continue;
      rows.set(record.recordId, record.fields as Record<string, unknown>);
      pending.delete(record.recordId);
    }
    if (!page.hasMore) break;
    pageToken = page.pageToken;
  }

  return recordIds.map((recordId) => {
    const fields = rows.get(recordId) || {};
    const values: Record<string, string> = {};
    for (const variable of variables) {
      const fieldId = mapping[variable];
      values[variable] = fieldId ? stringifyCellValue(fields[fieldId]) : '';
    }
    return { recordId, variables: values };
  });
}

export function getCloudDocOutputFields(fields: TableField[]): TableField[] {
  return fields.filter((field) =>
    field.rawType == null
      ? field.type === 'text'
      : CLOUD_DOC_OUTPUT_RAW_TYPES.has(field.rawType),
  );
}

export async function ensureOutputField(input: {
  table: ITable;
  fields: TableField[];
  outputFieldId: string;
  refreshBitable?: () => Promise<void>;
}): Promise<string> {
  if (input.outputFieldId !== AUTO_OUTPUT_FIELD) return input.outputFieldId;
  const used = new Set(input.fields.map((field) => field.name));
  let name = '生成文档链接';
  let suffix = 2;
  while (used.has(name)) {
    name = `生成文档链接${suffix}`;
    suffix += 1;
  }
  const created = await input.table.addField({ type: FieldType.Url, name });
  await input.refreshBitable?.();
  return created;
}
