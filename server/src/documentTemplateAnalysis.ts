// 读懂一份模板文件：拿到原文件 → 批注转变量 → 找出变量 → 做缩略图。
// 上传模板（新建/新增版本）和「检查模板」走同一套，检查说能发布的，上传时就是同样的结果。
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { ensureDocxExtension, sanitizeFileName } from './documentRenderFile';
import { UserFacingError } from './documentRenderStorageErrors';
import { renderDocx } from './documentRenderDocx';
import { collectTextNodeSegments } from './documentRenderDocxText';
import { isImagePlaceholderName } from './documentRenderImages';
import { convertCommentAnnotationsToTemplate } from './documentTemplateAnnotations';
import { downloadTemplateDocx } from './documentTemplateDownload';
import { buildTemplateThumbnail, stripImagePrefix, type DocumentTemplateThumbnail } from './documentTemplateThumbnail';

const MAX_UPLOADED_TEMPLATE_BYTES = 20 * 1024 * 1024;
const TEXT_PART_PATTERN = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

export type TemplateSourceInput = {
  url?: string;
  fileBase64?: string;
  fileName?: string;
  name?: string;
};

export type TemplateSource = {
  buffer: Buffer;
  sourceUrl: string;
  // 原文件指纹（批注转换之前）。「检查」和「发布」靠它确认是同一份文件。
  sourceSha256: string;
};

export type AnalyzedTemplate = {
  buffer: Buffer;
  sha256: string;
  size: number;
  variables: string[];
  thumbnail: DocumentTemplateThumbnail;
  fileName: string;
};

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function decodeUploadedTemplate(input: TemplateSourceInput): Buffer | null {
  const raw = input.fileBase64?.trim();
  if (!raw) return null;
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw new UserFacingError('模板文件内容不合法，请重新上传。');
  }
  if (buffer.length === 0) throw new UserFacingError('模板文件为空，请重新上传。');
  if (buffer.length > MAX_UPLOADED_TEMPLATE_BYTES) throw new UserFacingError('Docx 模板不能超过 20MB。');
  return buffer;
}

export async function loadTemplateSource(input: TemplateSourceInput): Promise<TemplateSource> {
  const sourceUrl = input.url?.trim() || '';
  const uploaded = decodeUploadedTemplate(input);
  if (!sourceUrl && !uploaded) throw new UserFacingError('模板链接或模板文件不能为空。');
  const buffer = uploaded || await downloadTemplateDocx(sourceUrl);
  return { buffer, sourceUrl, sourceSha256: sha256(buffer) };
}

export function templateFileName(input: TemplateSourceInput): string {
  return ensureDocxExtension(sanitizeFileName(input.fileName || input.name || '模板.docx', '模板.docx'));
}

export async function analyzeTemplate(source: TemplateSource, input: TemplateSourceInput): Promise<AnalyzedTemplate> {
  const annotated = await convertCommentAnnotationsToTemplate(source.buffer);
  const buffer = annotated.buffer;
  const rendered = await renderDocx(buffer, {});
  const variables = annotated.variables.length > 0 ? annotated.variables : rendered.found;
  // 缩略图预览：用变量名自身作为值再渲染一次，让占位符显示为变量名。
  // （renderDocx 对未提供的变量会替换成空串，直接用空变量渲染会丢失占位符文本。）
  const previewVariables: Record<string, string> = {};
  for (const name of variables) {
    if (!isImagePlaceholderName(name)) previewVariables[name] = stripImagePrefix(name);
  }
  const preview = Object.keys(previewVariables).length > 0
    ? await renderDocx(buffer, previewVariables)
    : rendered;
  return {
    buffer,
    sha256: sha256(buffer),
    size: buffer.length,
    variables,
    thumbnail: buildTemplateThumbnail(preview.previewText, variables),
    fileName: templateFileName(input),
  };
}

// 模板正文（含页眉页脚、脚注尾注）按段落拼出来的纯文字，给「检查模板」找写法问题用。
export async function readTemplateText(buffer: Buffer): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return '';
  }
  const parts = Object.keys(zip.files).filter((name) => TEXT_PART_PATTERN.test(name)).sort();
  const paragraphs: string[] = [];
  for (const name of parts) {
    const xml = await zip.file(name)?.async('string');
    if (!xml) continue;
    for (const paragraph of xml.match(/<w:p[\s\S]*?<\/w:p>/g) || []) {
      const text = collectTextNodeSegments(paragraph).combinedText;
      if (text.trim()) paragraphs.push(text);
    }
  }
  return paragraphs.join('\n');
}
