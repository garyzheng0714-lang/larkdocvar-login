import JSZip from 'jszip';
import { UserFacingError } from './documentRenderStorageErrors';

type AnnotationKind = 'text' | 'image';

type VariableAnnotation = {
  id: string;
  name: string;
  kind: AnnotationKind;
};

export type TemplateAnnotationConversion = {
  buffer: Buffer;
  variables: string[];
  converted: Array<{ name: string; kind: AnnotationKind }>;
};

function unescapeXml(input: string): string {
  return input.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

function escapeXml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function collectText(xml: string): string {
  return Array.from(xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)).map((match) => unescapeXml(match[1] || '')).join('');
}

function parseAnnotationText(input: string): { kind: AnnotationKind; name: string } | null {
  const normalized = input.replace(/\s+/g, ' ').trim();
  const match = normalized.match(/^(图片变量|图变量|image variable|image|变量)\s*[:：]\s*(.+)$/i);
  if (!match) return null;
  const kind = /^(图片变量|图变量|image variable|image)$/i.test(match[1] || '') ? 'image' : 'text';
  const name = (match[2] || '').trim();
  return name ? { kind, name } : null;
}

async function readAnnotations(zip: JSZip): Promise<Map<string, VariableAnnotation>> {
  const commentsXml = await zip.file('word/comments.xml')?.async('string');
  const annotations = new Map<string, VariableAnnotation>();
  if (!commentsXml) return annotations;
  const comments = commentsXml.match(/<w:comment\b[\s\S]*?<\/w:comment>/g) || [];
  for (const commentXml of comments) {
    const id = commentXml.match(/\bw:id=["']([^"']+)["']/)?.[1];
    if (!id) continue;
    const parsed = parseAnnotationText(collectText(commentXml));
    if (!parsed) continue;
    annotations.set(id, { id, ...parsed });
  }
  return annotations;
}

function firstRunProperties(xml: string): string {
  return xml.match(/<w:rPr[\s\S]*?<\/w:rPr>/)?.[0] || '';
}

function textPlaceholderRun(name: string, selectedXml: string): string {
  return `<w:r>${firstRunProperties(selectedXml)}<w:t>${escapeXml(`{{${name}}}`)}</w:t></w:r>`;
}

function paragraphAlignment(paragraphXml: string): 'left' | 'center' | 'right' {
  const value = paragraphXml.match(/<w:jc\b[^>]*\bw:val=["']([^"']+)["']/)?.[1];
  if (value === 'center' || value === 'right') return value;
  return 'left';
}

function formatMmFromEmu(input: string | undefined): string | null {
  const emu = Number(input || '');
  if (!Number.isFinite(emu) || emu <= 0) return null;
  const mm = emu / 36000;
  return `${Number(mm.toFixed(3)).toString()}mm`;
}

function formatMmFromCss(input: string | undefined): string | null {
  const match = String(input || '').trim().match(/^(\d+(?:\.\d+)?)(px|pt|in|cm|mm)?$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] || 'pt').toLowerCase();
  const mm = unit === 'px'
    ? value * 25.4 / 96
    : unit === 'pt'
      ? value * 25.4 / 72
      : unit === 'in'
        ? value * 25.4
        : unit === 'cm'
          ? value * 10
          : value;
  return `${Number(mm.toFixed(3)).toString()}mm`;
}

function vmlShapeSize(selectedXml: string): { width: string | null; height: string | null } {
  const style = selectedXml.match(/<v:shape\b[^>]*\bstyle=["']([^"']+)["']/)?.[1] || '';
  return {
    width: formatMmFromCss(style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i)?.[1]),
    height: formatMmFromCss(style.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i)?.[1]),
  };
}

function imagePlaceholderRun(name: string, selectedXml: string, paragraphXml: string): string {
  if (!/<w:drawing\b|<v:shape\b/.test(selectedXml)) throw new UserFacingError(`图片变量 ${name} 的批注范围内没有图片。`);
  const extent = selectedXml.match(/<wp:extent\b[^>]*\bcx=["'](\d+)["'][^>]*\bcy=["'](\d+)["'][^>]*\/>/);
  const vmlSize = extent ? { width: null, height: null } : vmlShapeSize(selectedXml);
  const width = formatMmFromEmu(extent?.[1]) || vmlSize.width;
  const height = formatMmFromEmu(extent?.[2]) || vmlSize.height;
  const params = [];
  if (width) params.push(`width=${width}`);
  if (height) params.push(`height=${height}`);
  params.push(`align=${paragraphAlignment(paragraphXml)}`);
  return `<w:r><w:t>${escapeXml(`{{image:${name}|${params.join('|')}}}`)}</w:t></w:r>`;
}

function stripAnnotationMarkers(xml: string, consumedIds: Set<string>): string {
  let output = xml;
  for (const id of consumedIds) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    output = output
      .replace(new RegExp(`<w:commentRangeStart\\b[^>]*\\bw:id=["']${escapedId}["'][^>]*/>`, 'g'), '')
      .replace(new RegExp(`<w:commentRangeEnd\\b[^>]*\\bw:id=["']${escapedId}["'][^>]*/>`, 'g'), '')
      .replace(new RegExp(`<w:r\\b[^>]*>(?:(?!</w:r>)[\\s\\S])*?<w:commentReference\\b[^>]*\\bw:id=["']${escapedId}["'][^>]*/>(?:(?!</w:r>)[\\s\\S])*?</w:r>`, 'g'), '');
  }
  return output;
}

function convertParagraph(paragraphXml: string, annotations: Map<string, VariableAnnotation>): {
  xml: string;
  converted: Array<{ id: string; name: string; kind: AnnotationKind }>;
} {
  const converted: Array<{ id: string; name: string; kind: AnnotationKind }> = [];
  let output = paragraphXml.replace(/<w:commentRangeStart\b[^>]*\bw:id=["']([^"']+)["'][^>]*\/>([\s\S]*?)<w:commentRangeEnd\b[^>]*\bw:id=["']\1["'][^>]*\/>/g, (match, id: string, selectedXml: string) => {
    const annotation = annotations.get(id);
    if (!annotation) return match;
    converted.push({ id, name: annotation.name, kind: annotation.kind });
    return annotation.kind === 'image'
      ? imagePlaceholderRun(annotation.name, selectedXml, paragraphXml)
      : textPlaceholderRun(annotation.name, selectedXml);
  });
  output = stripAnnotationMarkers(output, new Set(converted.map((item) => item.id)));
  return { xml: output, converted };
}

function convertXml(xml: string, annotations: Map<string, VariableAnnotation>): {
  xml: string;
  converted: Array<{ id: string; name: string; kind: AnnotationKind }>;
} {
  const converted: Array<{ id: string; name: string; kind: AnnotationKind }> = [];
  const xmlOut = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraphXml) => {
    const result = convertParagraph(paragraphXml, annotations);
    converted.push(...result.converted);
    return result.xml;
  });
  return { xml: xmlOut, converted };
}

function uniqueVariables(input: Array<{ name: string; kind: AnnotationKind }>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of input) {
    const name = item.kind === 'image' ? `image:${item.name}` : item.name;
    if (seen.has(name)) continue;
    seen.add(name);
    output.push(name);
  }
  return output;
}

async function removeConvertedComments(zip: JSZip, convertedIds: Set<string>): Promise<void> {
  if (convertedIds.size === 0) return;
  const file = zip.file('word/comments.xml');
  const commentsXml = await file?.async('string');
  if (!commentsXml) return;
  let nextXml = commentsXml;
  for (const id of convertedIds) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    nextXml = nextXml.replace(new RegExp(`<w:comment\\b[^>]*\\bw:id=["']${escapedId}["'][^>]*>[\\s\\S]*?</w:comment>`, 'g'), '');
  }
  if (/<w:comment\b/.test(nextXml)) {
    zip.file('word/comments.xml', nextXml);
    return;
  }
  zip.remove('word/comments.xml');
  const relsPath = 'word/_rels/document.xml.rels';
  const relsXml = await zip.file(relsPath)?.async('string');
  if (relsXml) {
    zip.file(relsPath, relsXml.replace(/<Relationship\b[^>]*Type=["'][^"']*\/comments["'][^>]*Target=["']comments\.xml["'][^>]*\/>/g, ''));
  }
  const contentTypesXml = await zip.file('[Content_Types].xml')?.async('string');
  if (contentTypesXml) {
    zip.file('[Content_Types].xml', contentTypesXml.replace(/<Override\b[^>]*PartName=["']\/word\/comments\.xml["'][^>]*\/>/g, ''));
  }
}

export async function convertCommentAnnotationsToTemplate(templateBuffer: Buffer): Promise<TemplateAnnotationConversion> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(templateBuffer);
  } catch {
    return { buffer: templateBuffer, variables: [], converted: [] };
  }
  const annotations = await readAnnotations(zip);
  if (annotations.size === 0) return { buffer: templateBuffer, variables: [], converted: [] };

  const converted: Array<{ id: string; name: string; kind: AnnotationKind }> = [];
  const xmlFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/') && name.endsWith('.xml') && name !== 'word/comments.xml');
  for (const name of xmlFiles) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    const result = convertXml(xml, annotations);
    converted.push(...result.converted);
    zip.file(name, result.xml);
  }

  const convertedIds = new Set(converted.map((item) => item.id));
  const unconverted = Array.from(annotations.values()).filter((annotation) => !convertedIds.has(annotation.id));
  if (unconverted.length > 0) {
    throw new UserFacingError(`变量批注 ${unconverted.map((item) => item.name).join('、')} 的范围暂不支持，请确认批注范围不要跨段落、跨单元格或落在不支持的位置。`);
  }
  if (converted.length === 0) {
    throw new UserFacingError('没有找到可转换的变量批注，请确认批注范围在正文、表格、页眉或页脚中。');
  }
  await removeConvertedComments(zip, convertedIds);
  return {
    buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    variables: uniqueVariables(converted),
    converted: converted.map(({ name, kind }) => ({ name, kind })),
  };
}

export const __test__ = {
  parseAnnotationText,
  convertXml,
};
