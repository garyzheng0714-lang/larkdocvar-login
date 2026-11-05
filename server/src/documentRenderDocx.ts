// Docx 渲染引擎：拆包、安全检查、把 {{变量}} 换成值、统计找到/缺少的变量。
// 只管「一份模板 + 一组变量 → 一份 Docx」，不管请求参数、存储和路由（那些在 documentRenderApi.ts）。
import JSZip from 'jszip';
import { TemplateHandler } from 'easy-template-x';
import { UserFacingError } from './documentRenderStorageErrors';
import { MAX_TEMPLATE_DOWNLOAD_BYTES } from './documentTemplateDownload';
import {
  collectTextNodeSegments,
  extractPreviewTextFromDocumentXml,
  extractVariablesFromText,
  normalizePlaceholderRuns,
  replacePlaceholdersInTextNodes,
  xmlHasResidualPlaceholders,
} from './documentRenderDocxText';
import { isImagePlaceholderName, normalizeImageVariableName, replaceImagePlaceholdersInDocx, type DocumentRenderImageVariableInput, type RenderedImageVariable } from './documentRenderImages';

const DEFAULT_MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_ZIP_ENTRIES = 1000;

export function normalizeImageVariables(input: Record<string, DocumentRenderImageVariableInput> | undefined): Record<string, DocumentRenderImageVariableInput> {
  const output = Object.create(null) as Record<string, DocumentRenderImageVariableInput>;
  for (const [key, value] of Object.entries(input || {})) {
    const name = normalizeImageVariableName(key);
    if (!name) continue;
    output[name] = value;
  }
  return output;
}

// easy-template-x 的 getContentParts 只覆盖 document.xml + 页眉 header* + 页脚 footer* + chart，
// 且缺失变量会被替换成空串——这些部件处理完不会再残留"真占位符"。脚注 footnotes.xml / 尾注 endnotes.xml
// 它完全不处理，仍留着原始 {{x}}，需要事后兜底文本替换。这个集合就是"需要兜底"的部件白名单。
const EASY_TEMPLATE_FALLBACK_PARTS = new Set(['word/footnotes.xml', 'word/endnotes.xml']);
function isEasyTemplateFallbackPart(name: string): boolean {
  return EASY_TEMPLATE_FALLBACK_PARTS.has(name);
}

// 参与变量提取与 found/missing 统计、以及需要做变量替换的"正文类"部件：
// 引擎覆盖的正文/页眉/页脚 + 需兜底的脚注/尾注。批注 comments.xml、设置 settings.xml 等辅助部件排除在外——
// 那里若出现 {{示例}} 不是模板变量，混进来会误报 missing 甚至让整单渲染失败。
function isVariableContentPart(name: string): boolean {
  return name === 'word/document.xml'
    || /^word\/header\d*\.xml$/.test(name)
    || /^word\/footer\d*\.xml$/.test(name)
    || EASY_TEMPLATE_FALLBACK_PARTS.has(name);
}

export function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || '');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
const getMaxUnzippedBytes = () => readPositiveIntegerEnv('DOCUMENT_RENDER_MAX_UNZIPPED_BYTES', DEFAULT_MAX_UNZIPPED_BYTES);
const getMaxZipEntries = () => readPositiveIntegerEnv('DOCUMENT_RENDER_MAX_ZIP_ENTRIES', DEFAULT_MAX_ZIP_ENTRIES);

function getZipObjectUncompressedSize(file: JSZip.JSZipObject): number {
  const internalData = (file as unknown as { _data?: { uncompressedSize?: number } })._data;
  const size = internalData?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0;
}

function assertSafeDocxZip(zip: JSZip): void {
  const entries = Object.values(zip.files);
  if (entries.length > getMaxZipEntries()) {
    throw new UserFacingError('Docx 模板文件体积异常，已拒绝处理。');
  }

  const maxUnzippedBytes = getMaxUnzippedBytes();
  let totalUnzippedBytes = 0;
  for (const file of entries) {
    if (file.dir) continue;
    totalUnzippedBytes += getZipObjectUncompressedSize(file);
    if (totalUnzippedBytes > maxUnzippedBytes) {
      throw new UserFacingError('Docx 模板文件体积异常，已拒绝处理。');
    }
  }
}

function hasMainDocumentRelationship(xml: string): boolean {
  const relationships = xml.match(/<Relationship\b[^>]*>/g) || [];
  return relationships.some((item) => (
    /Type=["'][^"']*\/officeDocument["']/.test(item)
    && /Target=["']\/?word\/document\.xml["']/.test(item)
  ));
}

function getDocxTextEngine(): 'easy-template-x' | 'legacy' {
  // 默认走 easy-template-x（修复样式不统一/多行/跨 run 等根因）；可用 env 回退 legacy 兜底。
  return process.env.DOCUMENT_RENDER_TEXT_ENGINE === 'legacy' ? 'legacy' : 'easy-template-x';
}

const easyTemplateHandler = new TemplateHandler({ delimiters: { tagStart: '{{', tagEnd: '}}' } });

// 新文本渲染引擎：run 归一化 + easy-template-x（纯字面替换、正确处理跨 run/多行/嵌套表格）。
// 图片占位符仍复用 replaceImagePlaceholdersInDocx；返回契约与 renderDocx 完全一致。
export async function renderDocxWithEasyTemplate(
  templateBuffer: Buffer,
  variables: Record<string, string>,
  imageVariables: Record<string, DocumentRenderImageVariableInput> = {},
): Promise<{
  buffer: Buffer;
  previewText: string; found: string[]; missing: string[]; hasResidualPlaceholders: boolean;
  images: { found: string[]; missing: string[]; rendered: RenderedImageVariable[] };
}> {
  if (templateBuffer.length > MAX_TEMPLATE_DOWNLOAD_BYTES) throw new UserFacingError('Docx 模板不能超过 20MB。');
  if (templateBuffer.subarray(0, 2).toString('utf8') !== 'PK') throw new UserFacingError('Docx 模板文件损坏或格式不支持。');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(templateBuffer);
  } catch {
    throw new UserFacingError('Docx 模板文件损坏或格式不支持。');
  }
  assertSafeDocxZip(zip);
  if (!zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) throw new UserFacingError('Docx 模板缺少必要的 Word 文档结构。');
  const contentTypesXml = await zip.file('[Content_Types].xml')?.async('string');
  if (!contentTypesXml?.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) throw new UserFacingError('Docx 模板缺少必要的 Word 文档结构。');
  const rootRelsXml = await zip.file('_rels/.rels')?.async('string');
  if (!rootRelsXml || !hasMainDocumentRelationship(rootRelsXml)) throw new UserFacingError('Docx 模板缺少必要的 Word 文档结构。');

  // 图片占位符（{{image:xxx}} → drawing），复用现有实现
  const renderedImages = await replaceImagePlaceholdersInDocx(zip, normalizeImageVariables(imageVariables));

  // 收集模板里出现的文本变量名（用于 found/missing），并对各 word/*.xml 做 run 归一化。
  // 变量名只从"正文类"部件收集：批注 comments.xml、设置等辅助部件里若写了 {{示例}} 不是模板变量，
  // 混进 found 会被误判为 missing（未提供该变量）导致整单 400 拒绝生成。
  const foundSet = new Set<string>();
  const xmlFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/') && name.endsWith('.xml'));
  for (const name of xmlFiles) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    if (isVariableContentPart(name)) {
      for (const variableName of extractVariablesFromText(collectTextNodeSegments(xml).combinedText).filter((candidate) => !isImagePlaceholderName(candidate))) {
        foundSet.add(variableName);
      }
    }
    zip.file(name, normalizePlaceholderRuns(xml));
  }

  const intermediate = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  let processedBuffer: Buffer;
  try {
    processedBuffer = Buffer.from(await easyTemplateHandler.process(intermediate, variables));
  } catch {
    throw new UserFacingError('文档生成失败：模板内容无法解析，请检查模板占位符是否完整。');
  }

  // easy-template-x 已用 XML 感知方式替换了 document/header/footer（缺失变量替成空串，不留真占位符）。
  // 对它不覆盖、仍留着原始 {{x}} 的脚注/尾注部件，在此做兜底文本替换，保证脚注等位置也被替换。
  //
  // 关键红线：兜底只能作用于脚注/尾注，绝不能对 document/header/footer 再跑一遍文本替换。
  // 此刻用户变量值已写进这些部件的 XML，值里字面的 {{某字段}}（说明文案、示例、粘贴内容里很常见）
  // 会被当成占位符二次替换 → 把另一个变量的值静默注入进来，产出串包的错误文档；也不能据此判残留而 400
  // （值里的示例括号不是残留）。这是"看起来成功、内容却错"的信任杀手，务必只兜底引擎不覆盖的部件。
  const finalZip = await JSZip.loadAsync(processedBuffer);
  let hasResidualPlaceholders = false;
  for (const name of Object.keys(finalZip.files).filter((n) => n.startsWith('word/') && n.endsWith('.xml'))) {
    if (!isEasyTemplateFallbackPart(name)) continue;
    const file = finalZip.file(name);
    if (!file) continue;
    let xml = await file.async('string');
    if (xmlHasResidualPlaceholders(xml)) {
      xml = replacePlaceholdersInTextNodes(xml, variables).xml;
      finalZip.file(name, xml);
    }
    if (xmlHasResidualPlaceholders(xml)) hasResidualPlaceholders = true;
  }
  const finalBuffer = Buffer.from(await finalZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const finalDocumentXml = (await finalZip.file('word/document.xml')?.async('string')) || '';

  const textFound = Array.from(foundSet);
  const found = Array.from(new Set([...textFound, ...renderedImages.found.map((name) => `image:${name}`)]));
  const missing = Array.from(new Set([
    ...textFound.filter((name) => !Object.prototype.hasOwnProperty.call(variables, name)),
    ...renderedImages.missing.map((name) => `image:${name}`),
  ]));

  return {
    buffer: finalBuffer,
    previewText: extractPreviewTextFromDocumentXml(finalDocumentXml),
    found,
    missing,
    hasResidualPlaceholders,
    images: renderedImages,
  };
}

export async function renderDocx(templateBuffer: Buffer, variables: Record<string, string>, imageVariables: Record<string, DocumentRenderImageVariableInput> = {}): Promise<{
  buffer: Buffer;
  previewText: string; found: string[]; missing: string[]; hasResidualPlaceholders: boolean;
  images: { found: string[]; missing: string[]; rendered: RenderedImageVariable[] };
}> {
  if (getDocxTextEngine() === 'easy-template-x') {
    return renderDocxWithEasyTemplate(templateBuffer, variables, imageVariables);
  }
  if (templateBuffer.length > MAX_TEMPLATE_DOWNLOAD_BYTES) throw new UserFacingError('Docx 模板不能超过 20MB。');
  if (templateBuffer.subarray(0, 2).toString('utf8') !== 'PK') throw new UserFacingError('Docx 模板文件损坏或格式不支持。');

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(templateBuffer);
  } catch {
    throw new UserFacingError('Docx 模板文件损坏或格式不支持。');
  }

  assertSafeDocxZip(zip);

  if (!zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) throw new UserFacingError('Docx 模板缺少必要的 Word 文档结构。');
  const contentTypesXml = await zip.file('[Content_Types].xml')?.async('string');
  if (!contentTypesXml?.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) throw new UserFacingError('Docx 模板缺少必要的 Word 文档结构。');
  const rootRelsXml = await zip.file('_rels/.rels')?.async('string');
  if (!rootRelsXml || !hasMainDocumentRelationship(rootRelsXml)) throw new UserFacingError('Docx 模板缺少必要的 Word 文档结构。');

  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new UserFacingError('Docx 模板缺少正文内容。');

  const foundSet = new Set<string>();
  let renderedDocumentXml = documentXml;
  let hasResidualPlaceholders = false;
  const renderedImages = await replaceImagePlaceholdersInDocx(zip, normalizeImageVariables(imageVariables));

  const xmlFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/') && name.endsWith('.xml'));
  for (const name of xmlFiles) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    const rendered = replacePlaceholdersInTextNodes(xml, variables);
    for (const found of rendered.found) {
      foundSet.add(found);
    }
    hasResidualPlaceholders ||= xmlHasResidualPlaceholders(rendered.xml);
    zip.file(name, rendered.xml);
    if (name === 'word/document.xml') {
      renderedDocumentXml = rendered.xml;
    }
  }

  const found = Array.from(new Set([...Array.from(foundSet), ...renderedImages.found.map((name) => `image:${name}`)]));
  const missing = Array.from(new Set([
    ...found.filter((name) => !Object.prototype.hasOwnProperty.call(variables, name) && !name.startsWith('image:')),
    ...renderedImages.missing.map((name) => `image:${name}`),
  ]));
  return {
    buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    previewText: extractPreviewTextFromDocumentXml(renderedDocumentXml),
    found,
    missing,
    hasResidualPlaceholders,
    images: renderedImages,
  };
}
