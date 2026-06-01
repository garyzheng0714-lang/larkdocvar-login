import axios from 'axios';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import JSZip from 'jszip';
import sharp from 'sharp';
import { z } from 'zod';
import { UserFacingError } from './documentRenderStorageErrors';
import { createFixedLookup, isBlockedIpAddress } from './documentRenderUrlSafety';

const MAX_IMAGE_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS = 3;
const DEFAULT_MAX_IMAGE_WIDTH_MM = 160;
const EMU_PER_PX = 9525;
const EMU_PER_IN = 914400;
const EMU_PER_CM = 360000;
const EMU_PER_MM = 36000;
const EMU_PER_PT = 12700;

type VerifiedImageUrl = { url: URL; lookup?: LookupFunction };
type ImageAlign = 'left' | 'center' | 'right';
type ImageFit = 'contain' | 'stretch';
type ImageUnit = 'px' | 'mm' | 'cm' | 'in' | 'pt' | 'emu';

export type DocumentRenderImageVariableInput = {
  url?: string;
  urls?: string[];
  ossProcess?: string;
  width?: number | string;
  height?: number | string;
  maxWidth?: number | string;
  maxHeight?: number | string;
  align?: string;
  fit?: string;
  alt?: string;
};

export type RenderedImageVariable = {
  name: string;
  url: string;
  width: number;
  height: number;
  widthPx: number;
  heightPx: number;
  align: ImageAlign;
  fit: ImageFit;
  contentType: string;
  fileName: string;
  originalWidthPx: number;
  originalHeightPx: number;
  ossProcess?: string;
};

export type ImagePlaceholderRenderResult = {
  found: string[];
  missing: string[];
  rendered: RenderedImageVariable[];
};

export const imageVariableValueSchema: z.ZodType<DocumentRenderImageVariableInput> = z.object({
  url: z.string().trim().min(1).optional(),
  urls: z.array(z.string().trim().min(1)).min(1).max(5).optional(),
  ossProcess: z.string().trim().min(1).max(512).optional(),
  width: z.union([z.number().positive().max(10000), z.string().trim().min(1).max(32)]).optional(),
  height: z.union([z.number().positive().max(10000), z.string().trim().min(1).max(32)]).optional(),
  maxWidth: z.union([z.number().positive().max(10000), z.string().trim().min(1).max(32)]).optional(),
  maxHeight: z.union([z.number().positive().max(10000), z.string().trim().min(1).max(32)]).optional(),
  align: z.string().trim().max(16).optional(),
  fit: z.string().trim().max(16).optional(),
  alt: z.string().trim().max(255).optional(),
}).refine((value) => Boolean(value.url || value.urls?.[0]), '图片变量必须提供 url 或 urls。');

export const imageVariableMapSchema = z.record(z.string().trim().min(1), imageVariableValueSchema).default({});

function allowPrivateImageUrls(): boolean {
  return process.env.DOCUMENT_IMAGE_ALLOW_PRIVATE_URLS === 'true' || process.env.DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS === 'true';
}

async function validateImageUrl(rawUrl: string): Promise<VerifiedImageUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UserFacingError('图片链接格式不正确。');
  }

  if (!['http:', 'https:'].includes(url.protocol)) throw new UserFacingError('图片链接只支持 HTTP 或 HTTPS。');
  if (url.username || url.password) throw new UserFacingError('图片链接不能包含用户名或密码。');
  if (url.protocol !== 'https:' && !allowPrivateImageUrls()) throw new UserFacingError('图片链接默认只允许 HTTPS。');
  if (allowPrivateImageUrls()) return { url };

  let addresses;
  try {
    addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new UserFacingError('图片链接无法访问，请检查链接是否正确。');
  }
  if (addresses.length === 0 || addresses.some((item) => isBlockedIpAddress(item.address))) {
    throw new UserFacingError('图片链接不能指向内网或本机地址。');
  }
  return { url, lookup: createFixedLookup(url.hostname, addresses) };
}

export function buildImageUrlWithOssProcess(rawUrl: string, ossProcess?: string): string {
  if (!ossProcess?.trim()) return rawUrl;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UserFacingError('图片链接格式不正确。');
  }
  url.searchParams.set('x-oss-process', ossProcess.trim());
  return url.toString();
}

async function downloadImage(rawUrl: string, redirectCount = 0): Promise<Buffer> {
  const target = await validateImageUrl(rawUrl);
  let response;
  try {
    response = await axios.get<ArrayBuffer>(target.url.toString(), {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: MAX_IMAGE_DOWNLOAD_BYTES,
      maxBodyLength: MAX_IMAGE_DOWNLOAD_BYTES,
      maxRedirects: 0,
      proxy: false,
      httpAgent: target.lookup ? new http.Agent({ lookup: target.lookup }) : undefined,
      httpsAgent: target.lookup ? new https.Agent({ lookup: target.lookup }) : undefined,
      validateStatus: (status) => (status >= 200 && status < 300) || (status >= 300 && status < 400),
    });
  } catch (error) {
    if (axios.isAxiosError(error) && String(error.message || '').includes('maxContentLength')) throw new UserFacingError('图片文件不能超过 10MB。');
    throw new UserFacingError('图片链接无法访问，请检查链接是否正确。');
  }

  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= MAX_IMAGE_REDIRECTS) throw new UserFacingError('图片链接重定向次数过多。');
    const location = response.headers.location;
    if (!location) throw new UserFacingError('图片链接重定向缺少目标地址。');
    return downloadImage(new URL(String(location), target.url).toString(), redirectCount + 1);
  }

  return Buffer.from(response.data);
}

function normalizeAlign(input?: string): ImageAlign {
  const value = (input || 'center').trim().toLowerCase();
  if (value === 'left' || value === '左' || value === '左对齐') return 'left';
  if (value === 'right' || value === '右' || value === '右对齐') return 'right';
  return 'center';
}

function normalizeFit(input?: string): ImageFit {
  return (input || '').trim().toLowerCase() === 'stretch' ? 'stretch' : 'contain';
}

export function isImagePlaceholderName(input: string): boolean {
  const value = input.trim();
  return value.startsWith('image:') || value.startsWith('图片:');
}

export function normalizeImageVariableName(input: string): string {
  const value = input.trim();
  if (value.startsWith('image:')) return value.slice('image:'.length).trim();
  if (value.startsWith('图片:')) return value.slice('图片:'.length).trim();
  return value;
}

function parseLength(input: number | string | undefined): { value: number; unit: ImageUnit } | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'number') return { value: input, unit: 'px' };
  const match = input.trim().match(/^(\d+(?:\.\d+)?)(px|mm|cm|in|pt|emu)?$/i);
  if (!match) throw new UserFacingError('图片尺寸参数格式不正确，请使用 120px、40mm、5cm、2in、36pt 或 914400emu。');
  return { value: Number(match[1]), unit: (match[2]?.toLowerCase() as ImageUnit | undefined) || 'px' };
}

function lengthToEmu(input: number | string | undefined): number | undefined {
  const parsed = parseLength(input);
  if (!parsed) return undefined;
  const factors: Record<ImageUnit, number> = { px: EMU_PER_PX, mm: EMU_PER_MM, cm: EMU_PER_CM, in: EMU_PER_IN, pt: EMU_PER_PT, emu: 1 };
  return Math.round(parsed.value * factors[parsed.unit]);
}

function emuToPx(emu: number): number {
  return Math.round(emu / EMU_PER_PX);
}

function fitSize(input: {
  originalWidthPx: number;
  originalHeightPx: number;
  width?: number | string;
  height?: number | string;
  maxWidth?: number | string;
  maxHeight?: number | string;
  fit: ImageFit;
}): { width: number; height: number } {
  const naturalWidth = input.originalWidthPx * EMU_PER_PX;
  const naturalHeight = input.originalHeightPx * EMU_PER_PX;
  const width = lengthToEmu(input.width);
  const height = lengthToEmu(input.height);
  let targetWidth = width || naturalWidth;
  let targetHeight = height || naturalHeight;

  if (width && !height) targetHeight = Math.round(width * naturalHeight / naturalWidth);
  if (!width && height) targetWidth = Math.round(height * naturalWidth / naturalHeight);
  if (width && height && input.fit === 'contain') {
    const ratio = Math.min(width / naturalWidth, height / naturalHeight);
    targetWidth = Math.round(naturalWidth * ratio);
    targetHeight = Math.round(naturalHeight * ratio);
  }

  const maxWidth = lengthToEmu(input.maxWidth) || DEFAULT_MAX_IMAGE_WIDTH_MM * EMU_PER_MM;
  const maxHeight = lengthToEmu(input.maxHeight);
  const ratio = Math.min(1, maxWidth / targetWidth, maxHeight ? maxHeight / targetHeight : 1);
  return { width: Math.round(targetWidth * ratio), height: Math.round(targetHeight * ratio) };
}

function parsePlaceholderOptions(raw: string): { name: string; options: Partial<DocumentRenderImageVariableInput> } | null {
  const normalized = raw.trim();
  const prefix = normalized.startsWith('image:') ? 'image:' : normalized.startsWith('图片:') ? '图片:' : '';
  if (!prefix) return null;
  const parts = normalized.slice(prefix.length).split('|').map((item) => item.trim()).filter(Boolean);
  const name = parts.shift()?.trim();
  if (!name) return null;
  const options: Partial<DocumentRenderImageVariableInput> = {};
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    if (['w', 'width', '宽'].includes(key)) options.width = value;
    else if (['h', 'height', '高'].includes(key)) options.height = value;
    else if (['maxw', 'maxwidth', '最大宽'].includes(key)) options.maxWidth = value;
    else if (['maxh', 'maxheight', '最大高'].includes(key)) options.maxHeight = value;
    else if (['align', '对齐'].includes(key)) options.align = value;
    else if (['fit', '适配'].includes(key)) options.fit = value;
    else if (['alt', '说明'].includes(key)) options.alt = value;
    else if (['oss', 'ossprocess', 'x-oss-process', '图片处理'].includes(key)) options.ossProcess = value;
  }
  return { name, options };
}

function escapeXml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function unescapeXml(input: string): string {
  return input.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

function collectText(xml: string): string {
  return Array.from(xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)).map((match) => unescapeXml(match[1] || '')).join('');
}

function getNextMediaIndex(zip: JSZip): number {
  const indexes = Object.keys(zip.files).map((name) => name.match(/^word\/media\/image(\d+)\./)?.[1]).filter(Boolean).map(Number);
  return Math.max(0, ...indexes) + 1;
}

function getNextRelationshipId(xml: string): string {
  const ids = Array.from(xml.matchAll(/\bId=["']rId(\d+)["']/g)).map((match) => Number(match[1])).filter(Number.isFinite);
  return `rId${Math.max(0, ...ids) + 1}`;
}

async function getNextDocPrId(zip: JSZip): Promise<number> {
  let maxId = 0;
  const xmlFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/') && name.endsWith('.xml'));
  for (const name of xmlFiles) {
    const xml = await zip.file(name)?.async('string');
    if (!xml) continue;
    for (const match of xml.matchAll(/<wp:docPr\b[^>]*\bid=["'](\d+)["']/g)) {
      maxId = Math.max(maxId, Number(match[1]));
    }
  }
  return maxId + 1;
}

async function addContentType(zip: JSZip, extension: string, contentType: string): Promise<void> {
  const file = zip.file('[Content_Types].xml');
  const xml = await file?.async('string');
  if (!xml || new RegExp(`<Default\\b[^>]*Extension=["']${extension}["']`).test(xml)) return;
  zip.file('[Content_Types].xml', xml.replace('</Types>', `  <Default Extension="${extension}" ContentType="${contentType}"/>\n</Types>`));
}

async function addImageRelationship(zip: JSZip, partPath: string, mediaPath: string): Promise<string> {
  const relsPath = `word/_rels/${partPath.slice('word/'.length)}.rels`;
  const existing = await zip.file(relsPath)?.async('string');
  const baseXml = existing || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const id = getNextRelationshipId(baseXml);
  const target = mediaPath.slice('word/'.length);
  const relationship = `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;
  zip.file(relsPath, baseXml.replace('</Relationships>', `${relationship}</Relationships>`));
  return id;
}

function setParagraphAlignment(pPr: string | undefined, align: ImageAlign): string {
  const jc = `<w:jc w:val="${align}"/>`;
  if (!pPr) return `<w:pPr>${jc}</w:pPr>`;
  const withoutJc = pPr.replace(/<w:jc\b[^/]*(?:\/>|>[\s\S]*?<\/w:jc>)/g, '');
  return withoutJc.replace('</w:pPr>', `${jc}</w:pPr>`);
}

function buildDrawingXml(input: { relId: string; docPrId: number; width: number; height: number; name: string; alt: string }): string {
  const safeName = escapeXml(input.name);
  const safeAlt = escapeXml(input.alt);
  return `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${input.width}" cy="${input.height}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${input.docPrId}" name="${safeName}" descr="${safeAlt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${input.docPrId}" name="${safeName}" descr="${safeAlt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${input.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${input.width}" cy="${input.height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

async function normalizeImage(buffer: Buffer): Promise<{ buffer: Buffer; extension: string; contentType: string; widthPx: number; heightPx: number }> {
  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new UserFacingError('图片文件无法识别，请上传 PNG、JPG、GIF 或 WebP 图片。');
  }
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > 25_000_000) throw new UserFacingError('图片尺寸异常，已拒绝处理。');
  if (metadata.format === 'jpeg') return { buffer, extension: 'jpg', contentType: 'image/jpeg', widthPx: metadata.width, heightPx: metadata.height };
  if (metadata.format === 'png') return { buffer, extension: 'png', contentType: 'image/png', widthPx: metadata.width, heightPx: metadata.height };
  if (metadata.format === 'gif') return { buffer, extension: 'gif', contentType: 'image/gif', widthPx: metadata.width, heightPx: metadata.height };
  if (metadata.format === 'webp') {
    const converted = await sharp(buffer).png().toBuffer();
    return { buffer: converted, extension: 'png', contentType: 'image/png', widthPx: metadata.width, heightPx: metadata.height };
  }
  throw new UserFacingError('图片格式不支持，请使用 PNG、JPG、GIF 或 WebP。');
}

async function prepareImage(name: string, input: DocumentRenderImageVariableInput, placeholderOptions: Partial<DocumentRenderImageVariableInput>, cache: Map<string, Promise<ReturnType<typeof normalizeImage> extends Promise<infer T> ? T : never>>): Promise<{ image: Awaited<ReturnType<typeof normalizeImage>>; url: string; options: DocumentRenderImageVariableInput; align: ImageAlign; fit: ImageFit; ossProcess?: string }> {
  const options = { ...placeholderOptions, ...input };
  const rawUrl = options.url || options.urls?.[0];
  if (!rawUrl) throw new UserFacingError(`图片变量 ${name} 缺少图片链接。`);
  const url = buildImageUrlWithOssProcess(rawUrl, options.ossProcess);
  let imagePromise = cache.get(url);
  if (!imagePromise) {
    imagePromise = downloadImage(url).then((buffer) => normalizeImage(buffer));
    cache.set(url, imagePromise);
  }
  return { image: await imagePromise, url, options, align: normalizeAlign(options.align), fit: normalizeFit(options.fit), ossProcess: options.ossProcess };
}

async function replaceImagesInParagraph(input: {
  zip: JSZip;
  paragraphXml: string;
  partPath: string;
  imageVariables: Record<string, DocumentRenderImageVariableInput>;
  cache: Map<string, Promise<Awaited<ReturnType<typeof normalizeImage>>>>;
  nextMediaIndex: { value: number };
  nextDocPrId: { value: number };
}): Promise<{ xml: string; found: string[]; missing: string[]; rendered: RenderedImageVariable[] }> {
  const text = collectText(input.paragraphXml);
  const placeholders = Array.from(text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)).map((match) => ({ full: match[0], parsed: parsePlaceholderOptions(match[1] || '') })).filter((item) => item.parsed);
  if (placeholders.length === 0) return { xml: input.paragraphXml, found: [], missing: [], rendered: [] };
  if (placeholders.length > 1 || text.trim() !== placeholders[0].full.trim()) throw new UserFacingError('图片变量必须单独放在一个段落或表格单元格段落中。');

  const placeholder = placeholders[0].parsed;
  if (!placeholder) return { xml: input.paragraphXml, found: [], missing: [], rendered: [] };
  const provided = input.imageVariables[placeholder.name];
  if (!provided) return { xml: input.paragraphXml, found: [placeholder.name], missing: [placeholder.name], rendered: [] };

  const prepared = await prepareImage(placeholder.name, provided, placeholder.options, input.cache);
  const size = fitSize({
    originalWidthPx: prepared.image.widthPx,
    originalHeightPx: prepared.image.heightPx,
    width: prepared.options.width,
    height: prepared.options.height,
    maxWidth: prepared.options.maxWidth,
    maxHeight: prepared.options.maxHeight,
    fit: prepared.fit,
  });
  const mediaIndex = input.nextMediaIndex.value;
  input.nextMediaIndex.value += 1;
  const docPrId = input.nextDocPrId.value;
  input.nextDocPrId.value += 1;
  const mediaPath = `word/media/image${mediaIndex}.${prepared.image.extension}`;
  input.zip.file(mediaPath, prepared.image.buffer);
  await addContentType(input.zip, prepared.image.extension, prepared.image.contentType);
  const relId = await addImageRelationship(input.zip, input.partPath, mediaPath);
  const openingTag = input.paragraphXml.match(/^<w:p(?:\s[^>]*)?>/)?.[0] || '<w:p>';
  const pPr = input.paragraphXml.match(/<w:pPr[\s\S]*?<\/w:pPr>/)?.[0];
  const drawing = buildDrawingXml({ relId, docPrId, width: size.width, height: size.height, name: `Image ${placeholder.name}`, alt: prepared.options.alt || placeholder.name });
  return {
    xml: `${openingTag}${setParagraphAlignment(pPr, prepared.align)}${drawing}</w:p>`,
    found: [placeholder.name],
    missing: [],
    rendered: [{
      name: placeholder.name,
      url: prepared.url,
      width: size.width,
      height: size.height,
      widthPx: emuToPx(size.width),
      heightPx: emuToPx(size.height),
      align: prepared.align,
      fit: prepared.fit,
      contentType: prepared.image.contentType,
      fileName: pathBaseName(mediaPath),
      originalWidthPx: prepared.image.widthPx,
      originalHeightPx: prepared.image.heightPx,
      ossProcess: prepared.ossProcess,
    }],
  };
}

function pathBaseName(input: string): string {
  return input.split('/').pop() || input;
}

async function replaceImagesInXml(zip: JSZip, partPath: string, xml: string, imageVariables: Record<string, DocumentRenderImageVariableInput>, cache: Map<string, Promise<Awaited<ReturnType<typeof normalizeImage>>>>, nextMediaIndex: { value: number }, nextDocPrId: { value: number }): Promise<{ xml: string; found: string[]; missing: string[]; rendered: RenderedImageVariable[] }> {
  const found = new Set<string>();
  const missing = new Set<string>();
  const rendered: RenderedImageVariable[] = [];
  let output = '';
  let cursor = 0;
  const pattern = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(xml)) !== null) {
    output += xml.slice(cursor, match.index);
    const result = await replaceImagesInParagraph({ zip, paragraphXml: match[0], partPath, imageVariables, cache, nextMediaIndex, nextDocPrId });
    result.found.forEach((item) => found.add(item));
    result.missing.forEach((item) => missing.add(item));
    rendered.push(...result.rendered);
    output += result.xml;
    cursor = match.index + match[0].length;
  }
  output += xml.slice(cursor);
  return { xml: output, found: Array.from(found), missing: Array.from(missing), rendered };
}

export async function replaceImagePlaceholdersInDocx(zip: JSZip, imageVariables: Record<string, DocumentRenderImageVariableInput>): Promise<ImagePlaceholderRenderResult> {
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof normalizeImage>>>>();
  const nextMediaIndex = { value: getNextMediaIndex(zip) };
  const nextDocPrId = { value: await getNextDocPrId(zip) };
  const found = new Set<string>();
  const missing = new Set<string>();
  const rendered: RenderedImageVariable[] = [];
  const xmlFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/') && name.endsWith('.xml'));
  for (const partPath of xmlFiles) {
    const file = zip.file(partPath);
    if (!file) continue;
    const xml = await file.async('string');
    const result = await replaceImagesInXml(zip, partPath, xml, imageVariables, cache, nextMediaIndex, nextDocPrId);
    result.found.forEach((item) => found.add(item));
    result.missing.forEach((item) => missing.add(item));
    rendered.push(...result.rendered);
    zip.file(partPath, result.xml);
  }
  return { found: Array.from(found), missing: Array.from(missing), rendered };
}

export const __test__ = {
  buildImageUrlWithOssProcess,
  parsePlaceholderOptions,
  fitSize,
  normalizeAlign,
};
