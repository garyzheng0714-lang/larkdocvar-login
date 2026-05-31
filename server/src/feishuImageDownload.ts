// feishuImageDownload.ts — 飞书图片下载和 SSRF 防护

import type { LookupAddress } from 'node:dns';
import dns from 'node:dns/promises';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import sharp from 'sharp';
import {
  IMAGE_DOWNLOAD_ALLOWED_HOSTS,
  MAX_IMAGE_DOWNLOAD_BYTES,
  MAX_IMAGE_DOWNLOAD_REDIRECTS,
  MAX_IMAGE_INPUT_PIXELS,
  ALLOWED_DECODED_IMAGE_FORMATS,
  type VerifiedImageDownloadTarget,
} from './feishuTypes';

function ipv4ToNumber(address: string): number {
  return address
    .split('.')
    .reduce((acc, item) => (acc << 8) + Number(item), 0) >>> 0;
}

function isIpv4InRange(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}

function isBlockedIpAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, bits]) => isIpv4InRange(address, String(base), Number(bits)));
  }

  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice('::ffff:'.length);
      if (net.isIP(mapped) === 4) {
        return isBlockedIpAddress(mapped);
      }
      const parts = mapped.split(':');
      if (parts.length === 2 && parts.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) {
        const first = Number.parseInt(parts[0], 16);
        const second = Number.parseInt(parts[1], 16);
        if (Number.isFinite(first) && Number.isFinite(second)) {
          return isBlockedIpAddress(
            [
              (first >> 8) & 0xff,
              first & 0xff,
              (second >> 8) & 0xff,
              second & 0xff,
            ].join('.'),
          );
        }
      }
    }
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab][0-9a-f]?:/i.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    );
  }

  return true;
}

function isAllowedImageHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return IMAGE_DOWNLOAD_ALLOWED_HOSTS.some(
    (allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`),
  );
}

function buildPinnedLookup(expectedHostname: string, addresses: LookupAddress[]): LookupFunction {
  const normalizedHost = expectedHostname.toLowerCase().replace(/\.$/, '');
  return ((hostname: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb !== 'function') {
      throw new Error('lookup callback is required');
    }

    if (hostname.toLowerCase().replace(/\.$/, '') !== normalizedHost) {
      cb(new Error('图片下载域名与校验域名不一致。'));
      return;
    }

    const opts = typeof options === 'object' && options !== null ? options as { family?: number; all?: boolean } : {};
    const requestedFamily = typeof options === 'number' ? options : opts.family || 0;
    const candidates = requestedFamily
      ? addresses.filter((item) => item.family === requestedFamily)
      : addresses;

    if (candidates.length === 0) {
      cb(new Error('图片链接没有可用的已校验解析地址。'));
      return;
    }

    if (opts.all) {
      cb(null, candidates);
      return;
    }

    cb(null, candidates[0].address, candidates[0].family);
  }) as LookupFunction;
}

export async function validateImageDownloadUrl(rawUrl: string): Promise<VerifiedImageDownloadTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('图片链接格式不合法。');
  }

  if (url.protocol !== 'https:') {
    throw new Error('图片链接只允许 HTTPS。');
  }
  if (url.username || url.password) {
    throw new Error('图片链接不能包含用户名或密码。');
  }
  if (!isAllowedImageHost(url.hostname)) {
    throw new Error(`图片链接域名不在允许范围内：${url.hostname}`);
  }

  const literalIpFamily = net.isIP(url.hostname);
  if (literalIpFamily) {
    if (isBlockedIpAddress(url.hostname)) {
      throw new Error('图片链接不能指向内网或保留 IP。');
    }
    return {
      url,
      lookup: buildPinnedLookup(url.hostname, [{ address: url.hostname, family: literalIpFamily as 4 | 6 }]),
    };
  }

  const addresses = await dns.lookup(url.hostname, { all: true });
  if (addresses.length === 0) {
    throw new Error('图片链接域名解析失败。');
  }
  for (const item of addresses) {
    if (isBlockedIpAddress(item.address)) {
      throw new Error('图片链接域名解析到内网或保留 IP。');
    }
  }

  return {
    url,
    lookup: buildPinnedLookup(url.hostname, addresses),
  };
}

export function normalizeContentType(contentType: unknown): string {
  const raw = Array.isArray(contentType) ? contentType[0] : contentType;
  return String(raw || 'image/png').split(';')[0].trim().toLowerCase();
}

export function imageFormatToUploadInfo(format: string | undefined): { contentType: string; extension: string } {
  const normalized = String(format || '').toLowerCase();
  if (!ALLOWED_DECODED_IMAGE_FORMATS.has(normalized)) {
    throw new Error('图片真实格式不支持。');
  }
  if (normalized === 'jpeg') {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  return { contentType: `image/${normalized}`, extension: normalized };
}

export async function prepareImageForUpload(
  image: { buffer: Buffer; contentType: string },
  targetWidth: number,
): Promise<{ buffer: Buffer; contentType: string; extension: string }> {
  const width = Number.isFinite(targetWidth) ? Math.max(0, Math.min(2000, Math.floor(targetWidth))) : 0;
  const metadata = await sharp(image.buffer, { limitInputPixels: MAX_IMAGE_INPUT_PIXELS }).metadata();
  const uploadInfo = imageFormatToUploadInfo(metadata.format);
  const original = {
    buffer: image.buffer,
    ...uploadInfo,
  };
  if (width <= 0) {
    return original;
  }

  const resized = await sharp(image.buffer, { limitInputPixels: MAX_IMAGE_INPUT_PIXELS })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .png()
    .toBuffer();
  return { buffer: resized, contentType: 'image/png', extension: 'png' };
}

export async function downloadAndProcessImage(
  imageUrl: string,
  targetWidth?: number,
): Promise<{ buffer: Buffer; contentType: string; extension: string }> {
  const verified = await validateImageDownloadUrl(imageUrl);
  const response = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let redirectCount = 0;

    function request(url: URL) {
      https.get(url.toString(), {
        lookup: verified.lookup,
        timeout: 30_000,
        headers: { 'User-Agent': 'DocxGenerator/1.0' },
      }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          redirectCount++;
          if (redirectCount > MAX_IMAGE_DOWNLOAD_REDIRECTS) {
            reject(new Error('图片下载重定向次数过多。'));
            return;
          }
          try {
            const redirectUrl = new URL(res.headers.location, url);
            request(redirectUrl);
          } catch {
            reject(new Error('图片下载重定向链接格式不合法。'));
          }
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`图片下载失败，HTTP ${res.statusCode}`));
          return;
        }

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_IMAGE_DOWNLOAD_BYTES) {
            reject(new Error('图片文件过大。'));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          resolve(Buffer.concat(chunks));
        });

        res.on('error', reject);
      }).on('error', reject);
    }

    request(verified.url);
  });

  const contentType = normalizeContentType('image/png');
  return prepareImageForUpload({ buffer: response, contentType }, targetWidth || 0);
}

export const __test__ = {
  isBlockedIpAddress,
  isAllowedImageHost,
  validateImageDownloadUrl,
  ipv4ToNumber,
  isIpv4InRange,
};
