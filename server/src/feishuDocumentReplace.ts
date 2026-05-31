// feishuDocumentReplace.ts — 飞书文档块变量替换逻辑

import { UPDATABLE_TEXT_KEYS } from './feishuTypes';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasOwnVariable(variables: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(variables, name);
}

function replaceKnownPlaceholders(input: string, variables: Record<string, string>): string {
  return input.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawName: string) => {
    const name = rawName.trim();
    return hasOwnVariable(variables, name) ? variables[name] ?? '' : match;
  });
}

function isTextRunElement(element: unknown): element is Record<string, any> & { text_run: { content: string } } {
  const current = element as Record<string, any>;
  return typeof current?.text_run?.content === 'string';
}

function cloneTextRunElement(element: Record<string, any>, content: string): Record<string, any> {
  return {
    ...element,
    text_run: {
      ...element.text_run,
      content,
    },
  };
}

function replaceTextRunGroup(
  group: Array<Record<string, any> & { text_run: { content: string } }>,
  variables: Record<string, string>,
): { changed: boolean; elements: unknown[] } {
  const segments = group.map((element, index) => ({
    element,
    index,
    content: element.text_run.content,
    start: 0,
    end: 0,
  }));

  let cursor = 0;
  for (const segment of segments) {
    segment.start = cursor;
    cursor += segment.content.length;
    segment.end = cursor;
  }

  const combined = segments.map((segment) => segment.content).join('');
  const output: unknown[] = [];
  const appendOriginalRange = (start: number, end: number) => {
    if (end <= start) return;
    for (const segment of segments) {
      const from = Math.max(start, segment.start);
      const to = Math.min(end, segment.end);
      if (to <= from) continue;
      const content = segment.content.slice(from - segment.start, to - segment.start);
      if (content) {
        output.push(cloneTextRunElement(segment.element, content));
      }
    }
  };

  const findSourceElement = (offset: number): Record<string, any> => {
    return segments.find((segment) => offset >= segment.start && offset < segment.end)?.element ?? group[0];
  };

  let changed = false;
  let lastIndex = 0;
  const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(combined)) !== null) {
    const name = match[1]?.trim() || '';
    if (!hasOwnVariable(variables, name)) {
      continue;
    }

    changed = true;
    appendOriginalRange(lastIndex, match.index);
    const replacement = variables[name] ?? '';
    if (replacement) {
      output.push(cloneTextRunElement(findSourceElement(match.index), replacement));
    }
    lastIndex = match.index + match[0].length;
  }

  if (!changed) {
    return { changed: false, elements: group };
  }

  appendOriginalRange(lastIndex, combined.length);
  if (output.length === 0) {
    output.push(cloneTextRunElement(group[0], ''));
  }
  return { changed: true, elements: output };
}

export function replaceElements(elements: unknown[], variables: Record<string, string>): { changed: boolean; elements: unknown[] } {
  let changed = false;
  const nextElements: unknown[] = [];
  let textRunGroup: Array<Record<string, any> & { text_run: { content: string } }> = [];

  const flushTextRunGroup = () => {
    if (textRunGroup.length === 0) return;
    const replaced = replaceTextRunGroup(textRunGroup, variables);
    if (replaced.changed) {
      changed = true;
    }
    nextElements.push(...replaced.elements);
    textRunGroup = [];
  };

  for (const element of elements) {
    const current = element as Record<string, any>;
    if (isTextRunElement(current)) {
      textRunGroup.push(current);
      continue;
    }
    if (current?.equation?.content && typeof current.equation.content === 'string') {
      flushTextRunGroup();
      const replaced = replaceKnownPlaceholders(current.equation.content, variables);
      if (replaced !== current.equation.content) {
        changed = true;
        nextElements.push({
          ...current,
          equation: {
            ...current.equation,
            content: replaced
          }
        });
        continue;
      }
    }
    flushTextRunGroup();
    nextElements.push(current);
  }
  flushTextRunGroup();

  return { changed, elements: nextElements };
}

export function replacePlaceholders(input: string, variables: Record<string, string>): string {
  let output = input;
  const entries = Object.entries(variables).filter(([, value]) => value !== undefined);
  for (const [name, value] of entries) {
    const pattern = new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`, 'g');
    output = output.replace(pattern, value ?? '');
  }
  return output;
}

export function extractVariablesFromText(rawContent: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const regexp = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null = null;
  while ((match = regexp.exec(rawContent)) !== null) {
    const variable = match[1]?.trim();
    if (!variable || seen.has(variable)) {
      continue;
    }
    seen.add(variable);
    result.push(variable);
  }
  return result;
}

export function extractDocumentId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('模板文档链接为空。');
  }
  if (/^[a-zA-Z0-9_]{10,}$/.test(trimmed) && !trimmed.startsWith('http')) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/(?:docx|docs)\/([a-zA-Z0-9_]+)/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    const match = trimmed.match(/\/(?:docx|docs)\/([a-zA-Z0-9_]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  throw new Error('无法从模板链接中解析 document_id，请确认链接格式。');
}

export function buildDocumentTitle(templateTitle: string): string {
  return (templateTitle || '模板文档').replace(/[<>:"/\\|?*]/g, '_').slice(0, 200);
}

export function getTextElements(block: Record<string, unknown>): unknown[] | null {
  for (const key of Object.keys(block)) {
    if (!UPDATABLE_TEXT_KEYS.has(key)) {
      continue;
    }
    const value = block[key] as { elements?: unknown[] } | undefined;
    if (value && Array.isArray(value.elements)) {
      return value.elements;
    }
  }
  return null;
}

export {
  escapeRegExp,
};

export const __test__ = {
  escapeRegExp,
  hasOwnVariable,
  replaceKnownPlaceholders,
  replaceTextRunGroup,
  isTextRunElement,
  cloneTextRunElement,
};
