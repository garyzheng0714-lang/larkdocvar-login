import { useCallback, useEffect, useState } from 'react';
import type { Template, TemplateThumbnail, TemplateVariable } from './types';

interface ServerIndexItem {
  templateId: string;
  name: string;
  status: 'active' | 'deleted';
  activeVersionId: string;
  versionCount: number;
  variables: string[];
  thumbnail?: TemplateThumbnail;
  category?: string;
  visibility?: 'private' | 'shared';
  description?: string;
  createdByOpenId?: string;
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

function normalizeImageVariableName(name: string): string {
  const value = name.trim();
  if (value.startsWith('image:')) return value.slice('image:'.length).trim();
  if (value.startsWith('图片:')) return value.slice('图片:'.length).trim();
  return value;
}

function toTemplate(item: ServerIndexItem): Template {
  const variables: TemplateVariable[] = item.variables.map((name) => {
    // 仅依据显式 image:/图片: 前缀判定图片变量，与后端 isImagePlaceholderName 保持一致；
    // 不再用名称启发式（曾把"签名/印章/logo"等纯文本变量误判为图片，导致整条生成失败）。
    const isImage = name.trim().startsWith('image:') || name.trim().startsWith('图片:');
    return {
      name: isImage ? normalizeImageVariableName(name) : name,
      kind: isImage ? 'image' : 'text',
    };
  });
  return {
    id: item.templateId,
    name: item.name,
    varCount: variables.length,
    updatedAt: formatUpdatedAt(item.updatedAt),
    category: item.category || '全部',
    description: item.description,
    visibility: item.visibility || 'shared',
    kind: 'doc',
    variables,
    thumbnail: item.thumbnail,
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
