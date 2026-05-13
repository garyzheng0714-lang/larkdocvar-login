import type { TableField, Template, TemplateVariable } from './types';

export const CUSTOM_MAPPING_VALUE = '__custom__';

export function isCompatibleField(variable: TemplateVariable, field: TableField): boolean {
  return variable.kind === 'image' ? field.type === 'attachment' : field.type !== 'attachment';
}

export function findSmartField(variable: TemplateVariable, fields: TableField[]): string | undefined {
  const direct = fields.find(
    (f) => f.name.trim().toLowerCase() === variable.name.trim().toLowerCase()
      && isCompatibleField(variable, f),
  );
  if (direct) return direct.id;
  if (variable.suggested) {
    const suggested = fields.find((f) => f.id === variable.suggested && isCompatibleField(variable, f));
    if (suggested) return suggested.id;
  }
  return undefined;
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
