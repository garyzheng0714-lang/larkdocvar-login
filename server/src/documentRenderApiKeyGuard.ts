import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { peekSessionForRequest } from './auth';

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function readPresentedDocumentRenderApiKey(request: Request): string {
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  const authorization = request.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

export function hasValidDocumentRenderApiKey(request: Request): boolean {
  const expected = (process.env.DOCUMENT_RENDER_API_KEY || '').trim();
  const presented = readPresentedDocumentRenderApiKey(request);
  return Boolean(expected && presented && safeEqual(presented, expected));
}

export function requireDocumentRenderApiKey(request: Request, response: Response, next: NextFunction): void {
  if (request.method === 'OPTIONS') {
    next();
    return;
  }
  const expected = (process.env.DOCUMENT_RENDER_API_KEY || '').trim();
  if (hasValidDocumentRenderApiKey(request)) {
    next();
    return;
  }
  void (async () => {
    try {
      const session = await peekSessionForRequest(request);
      if (session) {
        next();
        return;
      }
    } catch {
      // Keep the public error stable; callers do not need storage details.
    }
    if (!expected && process.env.NODE_ENV !== 'production') {
      next();
      return;
    }
    response.status(401).json({ ok: false, error: 'API Key 无效或缺失。' });
  })();
}
