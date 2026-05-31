import type express from 'express';
import { FeishuApiError } from '../feishu';

const INTERNAL_ERROR_MESSAGE = '服务暂时不可用，请稍后重试。';

export function sendInternalError(response: express.Response, context: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[${context}]`, error instanceof Error ? error.message : String(error));
  response.status(500).json({ ok: false, error: INTERNAL_ERROR_MESSAGE });
}

export function sendFeishuTemplateError(response: express.Response, context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes('无法从模板链接中解析') ||
    normalized.includes('模板文档链接为空') ||
    normalized.includes('field validation failed')
  ) {
    response.status(400).json({ ok: false, error: '无效的飞书云文档链接。' });
    return;
  }

  if (
    error instanceof FeishuApiError &&
    (
      normalized.includes('forbidden') ||
      normalized.includes('permission') ||
      normalized.includes('无权')
    )
  ) {
    response.status(403).json({ ok: false, error: '应用暂无权限读取该模板，请确认模板已授权给当前飞书应用。' });
    return;
  }

  sendInternalError(response, context, error);
}
