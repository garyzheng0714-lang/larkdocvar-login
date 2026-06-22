import type express from 'express';
import { isAllowedTenant, peekSessionForRequest } from './auth';

const DEFAULT_BITABLE_SIDEBAR_ALLOWED_BASE_IDS: string[] = [];

function splitCsv(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function validateBitableSidebarHeaders(input: {
  baseId?: string | null;
  tableId?: string | null;
  tenantKey?: string | null;
}): { ok: true } | { ok: false; error: string } {
  const baseId = (input.baseId || '').trim();
  const tableId = (input.tableId || '').trim();
  const tenantKey = (input.tenantKey || '').trim();
  if (!baseId || !tableId) {
    return { ok: false, error: '请在飞书多维表格侧边栏中打开插件后再操作。' };
  }

  const allowedBaseIds = splitCsv(process.env.BITABLE_SIDEBAR_ALLOWED_BASE_IDS);
  const effectiveBaseIds = allowedBaseIds.length > 0
    ? allowedBaseIds
    : DEFAULT_BITABLE_SIDEBAR_ALLOWED_BASE_IDS;
  if (effectiveBaseIds.length > 0 && !effectiveBaseIds.includes(baseId)) {
    return { ok: false, error: '当前多维表格不在允许访问范围内。' };
  }
  if (effectiveBaseIds.length === 0 && isProduction()) {
    return { ok: false, error: '服务未配置允许访问的多维表格。' };
  }

  const allowedTableIds = splitCsv(process.env.BITABLE_SIDEBAR_ALLOWED_TABLE_IDS);
  if (allowedTableIds.length > 0 && !allowedTableIds.includes(tableId)) {
    return { ok: false, error: '当前数据表不在允许访问范围内。' };
  }

  if (!tenantKey && isProduction()) {
    return { ok: false, error: '缺少飞书租户信息，请在飞书多维表格侧边栏中重试。' };
  }
  if (tenantKey && !isAllowedTenant(tenantKey)) {
    return { ok: false, error: '当前飞书租户不在允许访问范围内。' };
  }

  return { ok: true };
}

export function createCloudDocAccessGuard(): express.RequestHandler {
  return async (request, response, next) => {
    try {
      const session = await peekSessionForRequest(request);
      if (session) {
        next();
        return;
      }
    } catch {
      // Keep the public error stable; callers do not need storage details.
    }

    response.status(401).json({ ok: false, error: '请先完成可信登录后再操作。' });
  };
}
