import type express from 'express';
import { randomUUID } from 'node:crypto';

const DEFAULT_ALLOWED_BASE_IDS = ['LRdYbfi6NauOOesIdImcJ8sPn6h'];

export interface BitableSidebarCredential {
  baseId: string;
  tableId: string;
  baseUserId?: string;
  tenantKey?: string;
}

export type BitableSidebarValidator = (credential: BitableSidebarCredential) => boolean | Promise<boolean>;

function requestIdFromHeader(request: express.Request): string {
  const value = request.headers['x-request-id'];
  const requestId = Array.isArray(value) ? value[0] : value;
  return typeof requestId === 'string' && requestId.trim() ? requestId.trim().slice(0, 128) : randomUUID();
}

function readHeader(request: express.Request, name: string): string {
  const value = request.headers[name.toLowerCase()];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{6,160}$/.test(value);
}

function parseList(value: string | undefined, fallback: string[] = []): string[] {
  const parsed = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function matchesAllowed(value: string, allowed: string[]): boolean {
  return allowed.length === 0 || allowed.includes(value);
}

export function validateBitableSidebarAccess(credential: BitableSidebarCredential): boolean {
  const allowedBaseIds = parseList(process.env.BITABLE_SIDEBAR_ALLOWED_BASE_IDS, DEFAULT_ALLOWED_BASE_IDS);
  const allowedTableIds = parseList(process.env.BITABLE_SIDEBAR_ALLOWED_TABLE_IDS);
  const allowedTenantKeys = parseList(process.env.FEISHU_ALLOWED_TENANT_KEYS);

  if (!matchesAllowed(credential.baseId, allowedBaseIds)) {
    return false;
  }
  if (!matchesAllowed(credential.tableId, allowedTableIds)) {
    return false;
  }
  if (allowedTenantKeys.length > 0 && credential.tenantKey && !matchesAllowed(credential.tenantKey, allowedTenantKeys)) {
    return false;
  }
  return true;
}

export function createBitableSidebarAuthGuard(
  validateAccess: BitableSidebarValidator = validateBitableSidebarAccess,
): express.RequestHandler {
  return async (request, response, next) => {
    if (request.method === 'OPTIONS') {
      next();
      return;
    }

    const credential: BitableSidebarCredential = {
      baseId: readHeader(request, 'x-bitable-base-id'),
      tableId: readHeader(request, 'x-bitable-table-id'),
      baseUserId: readHeader(request, 'x-bitable-base-user-id') || undefined,
      tenantKey: readHeader(request, 'x-bitable-tenant-key') || undefined,
    };

    if (
      !credential.baseId ||
      !credential.tableId ||
      !isSafeIdentifier(credential.baseId) ||
      !isSafeIdentifier(credential.tableId)
    ) {
      response.status(401).json({
        ok: false,
        requestId: requestIdFromHeader(request),
        error: '请在飞书多维表格侧边栏中打开插件后再操作。',
      });
      return;
    }

    try {
      const allowed = await validateAccess(credential);
      if (!allowed) {
        response.status(403).json({
          ok: false,
          requestId: requestIdFromHeader(request),
          error: '当前多维表格授权不可用，请在侧边栏中重新打开插件。',
        });
        return;
      }
    } catch (error) {
      console.error('[bitable-sidebar-auth]', error instanceof Error ? error.message : String(error));
      response.status(503).json({
        ok: false,
        requestId: requestIdFromHeader(request),
        error: '侧边栏授权校验暂时不可用，请稍后重试。',
      });
      return;
    }

    next();
  };
}

export const __test__ = {
  parseList,
};
