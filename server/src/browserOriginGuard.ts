import type express from 'express';
import { randomUUID } from 'node:crypto';

function requestIdFromHeader(request: express.Request): string {
  const headerValue = request.headers['x-request-id'];
  const requestId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof requestId === 'string' && requestId.trim() ? requestId.trim().slice(0, 128) : randomUUID();
}

function rejectOrigin(response: express.Response, request: express.Request): void {
  response.status(403).json({
    ok: false,
    requestId: requestIdFromHeader(request),
    error: '请求来源不被允许。',
  });
}

export function getRequestOrigin(request: express.Request): string {
  const protocol = request.protocol || 'http';
  const host = request.headers.host || '';
  return host ? `${protocol}://${host}` : '';
}

export function isAllowedBrowserOrigin(
  origin: string,
  request: express.Request,
  allowedOrigins: Set<string>,
): boolean {
  return allowedOrigins.has(origin) || origin === getRequestOrigin(request);
}

export function createMutationOriginGuard(options: {
  allowedOrigins: Set<string>;
  requireOriginOrReferer?: boolean;
}): express.RequestHandler {
  const requireOriginOrReferer = options.requireOriginOrReferer !== false;

  return (request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      next();
      return;
    }

    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
    if (origin) {
      if (!isAllowedBrowserOrigin(origin, request, options.allowedOrigins)) {
        rejectOrigin(response, request);
        return;
      }
      next();
      return;
    }

    const referer = typeof request.headers.referer === 'string' ? request.headers.referer : '';
    if (!referer) {
      if (requireOriginOrReferer) {
        rejectOrigin(response, request);
        return;
      }
      next();
      return;
    }

    try {
      const refererOrigin = new URL(referer).origin;
      if (!isAllowedBrowserOrigin(refererOrigin, request, options.allowedOrigins)) {
        rejectOrigin(response, request);
        return;
      }
    } catch {
      rejectOrigin(response, request);
      return;
    }

    next();
  };
}
