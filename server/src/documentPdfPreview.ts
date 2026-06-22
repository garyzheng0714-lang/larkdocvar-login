import axios from 'axios';
import FormData from 'form-data';
import { DOCX_CONTENT_TYPE, ensureDocxExtension, sanitizeFileName } from './documentRenderFile';
import { UserFacingError } from './documentRenderStorageErrors';

const MAX_TEMPLATE_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_GOTENBERG_TIMEOUT_MS = 30_000;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || '');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getGotenbergTimeoutMs(): number {
  return readPositiveIntegerEnv('GOTENBERG_TIMEOUT_MS', DEFAULT_GOTENBERG_TIMEOUT_MS);
}

export async function convertDocxToPdfPreview(input: {
  buffer: Buffer;
  fileName: string;
}): Promise<{ contentType: 'application/pdf'; size: number; fileBase64: string }> {
  const baseUrl = (process.env.GOTENBERG_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new UserFacingError('PDF 预览服务未配置，请联系管理员。');
  }
  const form = new FormData();
  form.append('files', input.buffer, {
    filename: ensureDocxExtension(sanitizeFileName(input.fileName, '预览.docx')),
    contentType: DOCX_CONTENT_TYPE,
  });
  try {
    const response = await axios.post(`${baseUrl}/forms/libreoffice/convert`, form, {
      headers: form.getHeaders(),
      responseType: 'arraybuffer',
      timeout: getGotenbergTimeoutMs(),
      maxBodyLength: MAX_TEMPLATE_DOWNLOAD_BYTES,
      maxContentLength: MAX_TEMPLATE_DOWNLOAD_BYTES,
      validateStatus: (status) => status >= 200 && status < 300,
    });
    const pdf = Buffer.from(response.data);
    return {
      contentType: 'application/pdf',
      size: pdf.length,
      fileBase64: pdf.toString('base64'),
    };
  } catch {
    throw new UserFacingError('PDF 预览生成失败，请稍后重试。');
  }
}
