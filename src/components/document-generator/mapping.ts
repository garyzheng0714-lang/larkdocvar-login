import type { TableField, Template, TemplateVariable } from './types';
import { matchField } from './fieldMatching';

export const CUSTOM_MAPPING_VALUE = '__custom__';

export function isCompatibleField(variable: TemplateVariable, field: TableField): boolean {
  return variable.kind === 'image' ? field.type === 'attachment' : field.type !== 'attachment';
}

export function findSmartField(variable: TemplateVariable, fields: TableField[]): string | undefined {
  return matchField(variable.name, fields, {
    strategy: 'normalized',
    suggestedId: variable.suggested,
    compatible: (field) => isCompatibleField(variable, field),
  })?.id;
}

export function buildDefaultMapping(template: Template | null, fields: TableField[]): Record<string, string> {
  if (!template?.variables) return {};
  const mapping: Record<string, string> = {};
  for (const variable of template.variables) {
    const matched = findSmartField(variable, fields);
    if (matched) mapping[variable.name] = matched;
  }
  return mapping;
}

export function buildStandaloneMapping(template: Template | null): Record<string, string> {
  if (!template?.variables) return {};
  return Object.fromEntries(template.variables.map((v) => [v.name, CUSTOM_MAPPING_VALUE]));
}

export function reconcileMapping(
  template: Template | null,
  fields: TableField[],
  currentMapping: Record<string, string>,
  options: { allowCustom?: boolean } = {},
): Record<string, string> {
  if (!template?.variables) return {};
  const next: Record<string, string> = {};
  for (const variable of template.variables) {
    const current = currentMapping[variable.name];
    const currentField = fields.find((f) => f.id === current);
    if (options.allowCustom && current === CUSTOM_MAPPING_VALUE) {
      next[variable.name] = current;
      continue;
    }
    // 用户显式清空的绑定（值为空字符串）必须尊重，不能靠智能匹配在下一次选区变化时偷偷绑回去——
    // 否则用户刚清掉的字段会被自动填上一个他并不想要的字段。只有从未设置过（key 不存在 / undefined）的
    // 变量才做智能匹配（首次加载模板时的自动匹配走 buildDefaultMapping，不受影响）。
    if (current === '') {
      next[variable.name] = '';
      continue;
    }
    if (currentField && isCompatibleField(variable, currentField)) {
      next[variable.name] = current;
      continue;
    }
    const matched = findSmartField(variable, fields);
    if (matched) next[variable.name] = matched;
  }
  return next;
}

export function isSameMapping(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}
