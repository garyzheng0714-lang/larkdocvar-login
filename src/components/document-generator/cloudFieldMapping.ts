import type { TableField } from './types';

// 飞书云文档模式下的字段匹配与单元格取值纯函数。
// 从 CloudDocGeneratorApp.tsx 提取，便于独立测试（不依赖 React/DOM）。
// 与 mapping.ts 的 findSmartField（Docx 模板模式）是两套不同算法，刻意不合并。

export function normalizeName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[【】[\]()（）{}<>《》_.\-]/g, '');
}

export function findBestMatchedField(variable: string, fields: TableField[]): TableField | undefined {
  const normalizedVariable = normalizeName(variable);
  if (!normalizedVariable) return undefined;
  const exact = fields.find((field) => normalizeName(field.name) === normalizedVariable);
  if (exact) return exact;
  return fields.find((field) => {
    const normalizedField = normalizeName(field.name);
    return normalizedField.includes(normalizedVariable) || normalizedVariable.includes(normalizedField);
  });
}

export function stringifyCellValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifyCellValue).filter(Boolean).join('');
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    if (typeof objectValue.text === 'string') return objectValue.text;
    if (typeof objectValue.name === 'string') return objectValue.name;
    if (typeof objectValue.title === 'string') return objectValue.title;
  }
  return String(value);
}
