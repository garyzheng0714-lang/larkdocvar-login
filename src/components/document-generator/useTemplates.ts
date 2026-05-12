import { useCallback, useEffect, useState } from 'react';
import type { Template, TemplateVariable } from './types';

interface ServerIndexItem {
  templateId: string;
  name: string;
  status: 'active' | 'deleted';
  activeVersionId: string;
  versionCount: number;
  variables: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

function formatUpdatedAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.valueOf())) return iso;
    const m = d.getMonth() + 1;
    const day = d.getDate();
    return `${m} 月 ${day} 日`;
  } catch {
    return iso;
  }
}

function looksLikeImageVar(name: string): boolean {
  return /图片|logo|签名|印章|公章|头像|二维码|qr|image|photo/i.test(name);
}

function toTemplate(item: ServerIndexItem): Template {
  const variables: TemplateVariable[] = item.variables.map((name) => ({
    name,
    kind: looksLikeImageVar(name) ? 'image' : 'text',
  }));
  return {
    id: item.templateId,
    name: item.name,
    varCount: variables.length,
    updatedAt: formatUpdatedAt(item.updatedAt),
    category: '全部',
    kind: 'doc',
    variables,
  };
}

async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, credentials: 'include' });
}

export interface TemplatesContext {
  items: Template[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  getFullTemplate: (templateId: string) => Promise<Template | null>;
  deleteTemplate: (templateId: string) => Promise<void>;
}

export function useTemplates(): TemplatesContext {
  const [items, setItems] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/v1/document-templates', { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as { ok?: boolean; templates?: ServerIndexItem[]; error?: string };
      if (!json.ok || !Array.isArray(json.templates)) {
        throw new Error(json.error || '加载模板失败');
      }
      setItems(json.templates.filter((t) => t.status === 'active').map(toTemplate));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const getFullTemplate = useCallback(async (templateId: string): Promise<Template | null> => {
    try {
      const res = await apiFetch(`/api/v1/document-templates/${encodeURIComponent(templateId)}`);
      if (!res.ok) return null;
      const json = (await res.json()) as { ok?: boolean; template?: ServerIndexItem };
      if (!json.ok || !json.template) return null;
      return toTemplate(json.template);
    } catch {
      return null;
    }
  }, []);

  const deleteTemplate = useCallback(async (templateId: string) => {
    const res = await apiFetch(`/api/v1/document-templates/${encodeURIComponent(templateId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      throw new Error(`删除失败: HTTP ${res.status}`);
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { items, loading, error, refresh, getFullTemplate, deleteTemplate };
}
