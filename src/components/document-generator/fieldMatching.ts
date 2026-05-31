import type { TableField } from './types';

export type FieldMatchStrategy = 'exact' | 'normalized';

interface MatchFieldOptions<TField extends Pick<TableField, 'id' | 'name'>> {
  strategy: FieldMatchStrategy;
  suggestedId?: string;
  allowContains?: boolean;
  compatible?: (field: TField) => boolean;
}

export function normalizeFieldName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[【】[\]()（）{}<>《》_.\-]/g, '');
}

function exactComparable(input: string): string {
  return input.trim().toLowerCase();
}

export function matchField<TField extends Pick<TableField, 'id' | 'name'>>(
  targetName: string,
  fields: TField[],
  options: MatchFieldOptions<TField>,
): TField | undefined {
  const candidates = options.compatible ? fields.filter(options.compatible) : fields;
  const comparableTarget = options.strategy === 'normalized'
    ? normalizeFieldName(targetName)
    : exactComparable(targetName);
  if (!comparableTarget) return undefined;

  const exact = candidates.find((field) => {
    const comparableField = options.strategy === 'normalized'
      ? normalizeFieldName(field.name)
      : exactComparable(field.name);
    return comparableField === comparableTarget;
  });
  if (exact) return exact;

  if (options.suggestedId) {
    const suggested = candidates.find((field) => field.id === options.suggestedId);
    if (suggested) return suggested;
  }

  if (!options.allowContains || options.strategy !== 'normalized') return undefined;
  return candidates.find((field) => {
    const normalizedField = normalizeFieldName(field.name);
    return normalizedField.includes(comparableTarget) || comparableTarget.includes(normalizedField);
  });
}
