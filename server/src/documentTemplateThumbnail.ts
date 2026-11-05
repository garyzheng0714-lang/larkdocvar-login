// 模板缩略图：模板 API 返回的 thumbnail 字段（文字轮廓，不是图片）。字段定义见 docs/docx-api-integration.md「模板缩略图」。
import { isImagePlaceholderName } from './documentRenderImages';

export type DocumentTemplateThumbnailLine = {
  text: string;
  role: 'title' | 'body';
};

export type DocumentTemplateThumbnail = {
  kind: 'docx-outline';
  pageRatio: number;
  lines: DocumentTemplateThumbnailLine[];
  variableNames: string[];
  hasImagePlaceholders: boolean;
};

export function stripImagePrefix(input: string): string {
  return input.trim().replace(/^(image:|图片:)/i, '').trim();
}

function normalizeThumbnailText(input: string): string {
  return input
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawName: string) => stripImagePrefix(rawName))
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(input: string, maxLength: number): string {
  return input.length > maxLength ? `${input.slice(0, maxLength - 3)}...` : input;
}

export function buildTemplateThumbnail(previewText: string, variables: string[]): DocumentTemplateThumbnail {
  const lines = previewText
    .split(/\r?\n/)
    .map((line) => truncateText(normalizeThumbnailText(line), 42))
    .filter(Boolean)
    .slice(0, 8)
    .map((text, index): DocumentTemplateThumbnailLine => ({
      text,
      role: index === 0 && text.length <= 24 ? 'title' : 'body',
    }));
  const variableNames = variables
    .filter((name) => !isImagePlaceholderName(name))
    .map(stripImagePrefix)
    .filter(Boolean)
    .slice(0, 6);

  return {
    kind: 'docx-outline',
    pageRatio: 1.414,
    lines: lines.length > 0 ? lines : variableNames.slice(0, 3).map((text) => ({ text, role: 'body' })),
    variableNames,
    hasImagePlaceholders: variables.some(isImagePlaceholderName),
  };
}
