import type { GenerateResponse, TemplateVariablesResponse } from './types';

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`);
  }
  if (!payload?.ok) {
    throw new Error(payload?.error || '接口返回异常');
  }
  return payload as T;
}

export async function fetchTemplateVariables(
  templateUrl: string,
  headers: Record<string, string>,
): Promise<TemplateVariablesResponse> {
  return parseJsonResponse<TemplateVariablesResponse>(await fetch('/api/template/variables', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ templateUrl }),
  }));
}

export async function generateCloudDocuments(
  templateUrl: string,
  records: Array<{ recordId: string; variables: Record<string, string> }>,
  headers: Record<string, string>,
): Promise<GenerateResponse> {
  return parseJsonResponse<GenerateResponse>(await fetch('/api/documents/generate', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({
      templateUrl,
      records,
      options: {
        permissionMode: 'tenant_readable',
        ownerTransferEnabled: false,
      },
    }),
  }));
}

export function saveCloudDocAutoConfig(input: {
  templateUrl: string;
  activeTableId?: string | null;
  templateTitle: string;
  documentId: string;
  mapping: Record<string, string>;
  outputFieldId: string;
}): Promise<void> {
  return fetch('/api/configs/auto', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateUrl: input.templateUrl,
      tableId: input.activeTableId || '',
      payload: {
        templateUrl: input.templateUrl,
        templateTitle: input.templateTitle,
        templateId: input.documentId,
        tableId: input.activeTableId || '',
        bindings: input.mapping,
        outputFieldId: input.outputFieldId,
      },
    }),
  }).then(() => undefined);
}
