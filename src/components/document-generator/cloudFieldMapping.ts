import type { TableField } from './types';
import { matchField } from './fieldMatching';

// 飞书云文档模式下的字段匹配与单元格取值纯函数。
// 从 CloudDocGeneratorApp.tsx 提取，便于独立测试（不依赖 React/DOM）。

export function findBestMatchedField(variable: string, fields: TableField[]): TableField | undefined {
  return matchField(variable, fields, {
    strategy: 'normalized',
    allowContains: true,
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
