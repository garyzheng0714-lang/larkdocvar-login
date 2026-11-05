import express from 'express';
import { randomUUID } from 'node:crypto';

function requestIdFromHeader(request: express.Request): string {
  const headerValue = request.headers['x-request-id'];
  const requestId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof requestId === 'string' && requestId.trim() ? requestId.trim().slice(0, 128) : randomUUID();
}

const jsonParseErrorHandler: express.ErrorRequestHandler = (error, request, response, _next) => {
  const status = typeof error?.status === 'number' && error.status === 413 ? 413 : 400;
  response.status(status).json({
    ok: false,
    requestId: requestIdFromHeader(request),
    error: status === 413 ? '请求体过大，请减少请求内容后重试。' : '请求参数不合法。',
  });
};

function createJsonParser(limit: string): Array<express.RequestHandler | express.ErrorRequestHandler> {
  return [
    express.json({ limit }),
    jsonParseErrorHandler,
  ];
}

export const documentRenderJsonParser: Array<express.RequestHandler | express.ErrorRequestHandler> = createJsonParser('10mb');

// 也收表单格式：多维表格自动化把单元格拼进 JSON 时不转义引号和换行，用表单体发才稳。
export const documentTemplateBodyParser: Array<express.RequestHandler | express.ErrorRequestHandler> = [
  express.json({ limit: '30mb' }),
  express.urlencoded({ extended: false, limit: '1mb' }),
  jsonParseErrorHandler,
];
