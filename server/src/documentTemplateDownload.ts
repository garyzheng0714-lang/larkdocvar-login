// 从业务方给的链接下载 Docx 模板：只放行 HTTPS 公网地址（防 SSRF），限大小、限重定向、限总时长。
import axios from 'axios';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { UserFacingError } from './documentRenderStorageErrors';
import { createFixedLookup, isBlockedIpAddress } from './documentRenderUrlSafety';

export const MAX_TEMPLATE_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_TEMPLATE_REDIRECTS = 3;

type VerifiedTemplateUrl = { url: URL; lookup?: LookupFunction };

export function allowPrivateTemplateUrls(): boolean { return process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS === 'true'; }

export async function validateTemplateUrl(rawUrl: string): Promise<VerifiedTemplateUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UserFacingError('模板链接格式不正确。');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UserFacingError('模板链接只支持 HTTP 或 HTTPS。');
  }
  if (url.username || url.password) {
    throw new UserFacingError('模板链接不能包含用户名或密码。');
  }
  if (url.protocol !== 'https:' && !allowPrivateTemplateUrls()) {
    throw new UserFacingError('Docx 模板链接默认只允许 HTTPS。');
  }
  if (!allowPrivateTemplateUrls()) {
    let addresses;
    try {
      addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    } catch {
      throw new UserFacingError('Docx 模板链接无法访问，请检查链接是否正确。');
    }
    if (addresses.length === 0 || addresses.some((item) => isBlockedIpAddress(item.address))) {
      throw new UserFacingError('模板链接不能指向内网或本机地址。');
    }
    return {
      url,
      lookup: createFixedLookup(url.hostname, addresses),
    };
  }
  return { url };
}

export async function downloadTemplateDocx(rawUrl: string, redirectCount = 0): Promise<Buffer> {
  const target = await validateTemplateUrl(rawUrl);
  let response;
  try {
    response = await axios.get<ArrayBuffer>(target.url.toString(), {
      responseType: 'arraybuffer',
      timeout: 30000,
      // axios 的 timeout 只是 socket 空闲超时——对端每 29s 滴一个字节即可绕过它无限拖住下载。
      // 再加一个墙钟总时限硬上限，保证慢滴服务器无法让单份渲染 / 异步任务永久挂起。
      signal: AbortSignal.timeout(60_000),
      maxContentLength: MAX_TEMPLATE_DOWNLOAD_BYTES,
      maxBodyLength: MAX_TEMPLATE_DOWNLOAD_BYTES,
      maxRedirects: 0,
      proxy: false,
      httpAgent: target.lookup ? new http.Agent({ lookup: target.lookup }) : undefined,
      httpsAgent: target.lookup ? new https.Agent({ lookup: target.lookup }) : undefined,
      validateStatus: (status) => (status >= 200 && status < 300) || (status >= 300 && status < 400),
    });
  } catch (error) {
    if (axios.isAxiosError(error) && String(error.message || '').includes('maxContentLength')) throw new UserFacingError('Docx 模板不能超过 20MB。');
    throw new UserFacingError('Docx 模板链接无法访问，请检查链接是否正确。');
  }

  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= MAX_TEMPLATE_REDIRECTS) {
      throw new UserFacingError('模板链接重定向次数过多。');
    }
    const location = response.headers.location;
    if (!location) {
      throw new UserFacingError('模板链接重定向缺少目标地址。');
    }
    return downloadTemplateDocx(new URL(String(location), target.url).toString(), redirectCount + 1);
  }

  return Buffer.from(response.data);
}
