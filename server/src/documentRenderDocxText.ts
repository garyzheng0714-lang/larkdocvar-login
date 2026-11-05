// Docx 正文 XML 的纯文本工具：取变量、替换 {{占位符}}、残留检查、把被 Word 拆开的占位符 run 归一。
// 不碰网络和存储；渲染（documentRenderApi）和模板检查（documentTemplateInspect）共用。
import { isImagePlaceholderName } from './documentRenderImages';

export function extractVariablesFromText(input: string): string[] {
  const variables: string[] = [];
  const seen = new Set<string>();
  const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(input)) !== null) {
    const name = match[1]?.trim() || '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    variables.push(name);
  }
  return variables;
}

// 残留占位符判定：渲染完成后文本里若仍残留形如 {{...}}（含空占位 {{ }}）的"完整 token"，
// 即视为没替换干净，拒绝产出半成品。关键是只认完整 token——绝不能对替换后的文本做裸
// includes('{{'/'}}') 扫描：用户填入的值里含字面的孤立 {{ 或 }}（公式 f(x) }}、代码、JSON、
// 模板示例都很常见）并不构成 token，过去被误判成残留导致整单生成无故失败，是头号信任杀手。
export const RESIDUAL_PLACEHOLDER_PATTERN = /\{\{[^{}]*\}\}/;

export function textHasResidualPlaceholder(text: string): boolean {
  return RESIDUAL_PLACEHOLDER_PATTERN.test(text);
}

export function xmlHasResidualPlaceholders(xml: string): boolean {
  return textHasResidualPlaceholder(collectTextNodeSegments(xml).combinedText);
}

export function renderText(input: string, variables: Record<string, string>): string {
  return input.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawName: string) => {
    const name = rawName.trim();
    return Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : match;
  });
}

export function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXml(input: string): string {
  return input
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

export function extractPreviewTextFromDocumentXml(xml: string): string {
  const paragraphs = xml.match(/<w:p[\s\S]*?<\/w:p>/g) || [];
  if (paragraphs.length > 0) {
    return paragraphs
      .map((paragraph) => collectTextNodeSegments(paragraph).combinedText)
      .join('\n')
      .trim();
  }

  return collectTextNodeSegments(xml).combinedText.trim();
}

export type TextNodeSegment = {
  contentStart: number;
  contentEnd: number;
  textStart: number;
  textEnd: number;
  text: string;
};

export function collectTextNodeSegments(xml: string): { segments: TextNodeSegment[]; combinedText: string } {
  const segments: TextNodeSegment[] = [];
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let match: RegExpExecArray | null = null;
  let textCursor = 0;

  while ((match = pattern.exec(xml)) !== null) {
    const fullMatch = match[0];
    const rawText = match[1] || '';
    const openingEndOffset = fullMatch.indexOf('>') + 1;
    const contentStart = match.index + openingEndOffset;
    const contentEnd = contentStart + rawText.length;
    const text = unescapeXml(rawText);
    segments.push({
      contentStart,
      contentEnd,
      textStart: textCursor,
      textEnd: textCursor + text.length,
      text,
    });
    textCursor += text.length;
  }

  return {
    segments,
    combinedText: segments.map((segment) => segment.text).join(''),
  };
}

export function replacePlaceholdersInTextNodes(xml: string, variables: Record<string, string>): {
  xml: string;
  found: string[];
} {
  let matchedParagraph = false;
  const foundSet = new Set<string>();
  const outputXml = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraphXml) => {
    matchedParagraph = true;
    const rendered = replacePlaceholdersInTextNodeScope(paragraphXml, variables);
    for (const name of rendered.found) foundSet.add(name);
    return rendered.xml;
  });
  if (matchedParagraph) {
    return { xml: outputXml, found: Array.from(foundSet) };
  }
  return replacePlaceholdersInTextNodeScope(xml, variables);
}

export function replacePlaceholdersInTextNodeScope(xml: string, variables: Record<string, string>): {
  xml: string;
  found: string[];
} {
  const { segments, combinedText } = collectTextNodeSegments(xml);
  if (segments.length === 0) {
    return { xml, found: [] };
  }

  const found = extractVariablesFromText(combinedText).filter((name) => !isImagePlaceholderName(name));
  const operations: Array<{ start: number; end: number; replacement: string }> = [];
  const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(combinedText)) !== null) {
    const name = match[1]?.trim() || '';
    if (!Object.prototype.hasOwnProperty.call(variables, name)) {
      continue;
    }
    operations.push({
      start: match.index,
      end: match.index + match[0].length,
      replacement: variables[name],
    });
  }

  if (operations.length === 0) {
    return { xml, found };
  }

  const segmentOutputs = segments.map((segment) => {
    let output = '';
    let cursor = segment.textStart;

    for (const operation of operations) {
      if (operation.end <= segment.textStart || operation.start >= segment.textEnd) {
        continue;
      }

      const copyEnd = Math.min(operation.start, segment.textEnd);
      if (cursor < copyEnd) {
        output += combinedText.slice(cursor, copyEnd);
      }

      if (operation.start >= segment.textStart && operation.start < segment.textEnd) {
        output += operation.replacement;
      }

      cursor = Math.max(cursor, Math.min(operation.end, segment.textEnd));
    }

    if (cursor < segment.textEnd) {
      output += combinedText.slice(cursor, segment.textEnd);
    }

    return output;
  });

  let outputXml = '';
  let xmlCursor = 0;
  segments.forEach((segment, index) => {
    const replacement = segmentOutputs[index], prefix = xml.slice(xmlCursor, segment.contentStart);
    outputXml += /^\s|\s$/.test(replacement) && !prefix.includes('xml:space=') ? prefix.replace(/<w:t\b/, '<w:t xml:space="preserve"') : prefix;
    outputXml += escapeXml(replacement);
    xmlCursor = segment.contentEnd;
  });
  outputXml += xml.slice(xmlCursor);

  return { xml: outputXml, found };
}

// 把每个段落里构成 {{...}} 的相邻 run 的 rPr，统一为「变量名主体重叠字符最多的那个 run」的样式。
// easy-template-x 替换时取占位符起始 run 的样式，归一化后起始 run 已携带变量名样式，
// 从而彻底修复「Word 把占位符拆进不同样式 run 导致替换值样式丢失」的根因。
export function normalizePlaceholderRuns(xml: string): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraphXml) => normalizeParagraphRuns(paragraphXml));
}

export function normalizeParagraphRuns(paragraphXml: string): string {
  const runPattern = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
  const runs: Array<{ runXml: string; rPr: string; text: string; matchStart: number; matchEnd: number; charStart: number; charEnd: number }> = [];
  let runMatch: RegExpExecArray | null = null;
  let charCursor = 0;
  while ((runMatch = runPattern.exec(paragraphXml)) !== null) {
    const runXml = runMatch[0];
    // rPr 正则放宽：兼容自闭合 <w:rPr/> 与带属性 <w:rPr ...>，否则失配退化为空串会把样式抹掉。
    const rPrMatch = runXml.match(/<w:rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:rPr>)/);
    const rPr = rPrMatch ? rPrMatch[0] : '';
    const text = Array.from(runXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)).map((part) => unescapeXml(part[1] || '')).join('');
    runs.push({ runXml, rPr, text, matchStart: runMatch.index, matchEnd: runMatch.index + runXml.length, charStart: charCursor, charEnd: charCursor + text.length });
    charCursor += text.length;
  }
  if (runs.length === 0) return paragraphXml;
  const combinedText = runs.map((run) => run.text).join('');

  const placeholderPattern = /\{\{\s*[^{}]+?\s*\}\}/g;
  const repByRunIndex = new Map<number, string>();
  let placeholder: RegExpExecArray | null = null;
  while ((placeholder = placeholderPattern.exec(combinedText)) !== null) {
    const phStart = placeholder.index;
    const phEnd = placeholder.index + placeholder[0].length;
    const bodyStart = phStart + 2;
    const bodyEnd = phEnd - 2;
    const covered: number[] = [];
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].charStart < phEnd && runs[i].charEnd > phStart) covered.push(i);
    }
    if (covered.length === 0) continue;
    // 代表样式 = 与变量名主体 [bodyStart,bodyEnd) 重叠字符最多的那个 run 的 rPr
    let bestIndex = covered[0];
    let bestOverlap = -1;
    for (const i of covered) {
      const overlap = Math.min(runs[i].charEnd, bodyEnd) - Math.max(runs[i].charStart, bodyStart);
      if (overlap > bestOverlap) { bestOverlap = overlap; bestIndex = i; }
    }
    const representativeRPr = runs[bestIndex].rPr;
    // easy-template-x 把整个变量值塞进【占位符起始 run】（covered 中最靠前的那个），值的样式只由它决定。
    const startIndex = covered[0];
    // 起始 run 的最终样式 = 代表样式 ∪ 主体区间其它 covered run 的字符级强调样式（下划线/加粗/斜体/删除线等）。
    // 排除起始 run 自身样式（它常裹着花括号，样式不代表变量名，应被主体代表样式取代——保住「样式统一到主体」语义）；
    // 但变量名主体某些字符独有的强调样式（如填空横线 <w:u> 只描在「丙」上）必须并进来，否则替换值丢失这些样式（用户报障）。
    let startRPr = representativeRPr;
    for (const i of covered) {
      if (i === startIndex) continue;
      startRPr = mergeRunPropertiesXml(startRPr, runs[i].rPr);
    }
    // 起始 run 写并集样式；其余 covered run 仍统一为代表样式（维持占位符整体样式一致的既有设计）。
    for (const i of covered) repByRunIndex.set(i, i === startIndex ? startRPr : representativeRPr);
  }
  if (repByRunIndex.size === 0) return paragraphXml;

  let output = paragraphXml;
  const indices = Array.from(repByRunIndex.keys()).sort((a, b) => b - a); // 从后往前改写，避免位置偏移
  for (const i of indices) {
    const run = runs[i];
    const targetRPr = repByRunIndex.get(i) || '';
    let newRunXml: string;
    if (run.rPr) {
      newRunXml = run.runXml.replace(run.rPr, targetRPr); // targetRPr 为空串时即删除原 rPr
    } else if (targetRPr) {
      newRunXml = run.runXml.replace(/(<w:r\b[^>]*>)/, `$1${targetRPr}`);
    } else {
      newRunXml = run.runXml;
    }
    output = output.slice(0, run.matchStart) + newRunXml + output.slice(run.matchEnd);
  }
  return output;
}

// 取出 <w:rPr> 的内部内容（成对标签取其间内容，自闭合 <w:rPr/> 视为空内容）。
export function extractRunPropertiesInner(rPr: string): string {
  const paired = rPr.match(/<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/);
  if (paired) return paired[1];
  return ''; // 自闭合 <w:rPr/>
}

// 合并两个 <w:rPr>：以 baseRPr 为基底，把 ownRPr 里 base 缺失的顶层字符级样式子标签并进去。
// 按子标签名去重，base 已有的样式不被 own 覆盖（保住整段一致样式的代表语义）；
// own 独有的样式（如只覆盖变量名部分字符的 <w:u>）则保留，避免 run 归一化误删字符级样式。
export function mergeRunPropertiesXml(baseRPr: string, ownRPr: string): string {
  if (!ownRPr) return baseRPr;
  if (!baseRPr) return ownRPr;
  // 注意：必须先剥掉 <w:rPr> 外层壳再匹配子标签，否则正则会把整个 <w:rPr>…</w:rPr> 当成单个子元素。
  const childPattern = /<w:([A-Za-z]+)\b[^>]*?(?:\/>|>[\s\S]*?<\/w:\1>)/g;
  const baseInner = extractRunPropertiesInner(baseRPr);
  const ownInner = extractRunPropertiesInner(ownRPr);
  const baseTags = new Set(Array.from(baseInner.matchAll(childPattern)).map((m) => m[1]));
  const additions: string[] = [];
  for (const m of ownInner.matchAll(childPattern)) {
    if (!baseTags.has(m[1])) additions.push(m[0]);
  }
  if (additions.length === 0) return baseRPr;
  // 把 own 独有子元素插到 base 的 </w:rPr> 之前；base 为自闭合 <w:rPr/> 时先展开成成对标签。
  if (/<w:rPr\b[^>]*\/>/.test(baseRPr)) {
    return baseRPr.replace(/<w:rPr\b([^>]*?)\/>/, `<w:rPr$1>${additions.join('')}</w:rPr>`);
  }
  return baseRPr.replace(/<\/w:rPr>/, `${additions.join('')}</w:rPr>`);
}
