// 变量词典：同一个意思的变量记一次「标准名 + 别名」，例如 身份证号 = 证件号。
// 运营在多维表格「变量」表里维护，按行同步到这里（键是表格行号，改名不丢）。
// 用途两处：检查模板时提示「证件号建议改成身份证号」；生成时 aliasStrategy=dictionary 才互相顶替。
import { UserFacingError } from './documentRenderStorageErrors';
import { TemplateObjectNotFoundError, type TemplateObjectStore } from './documentTemplateStorage';

export type DocumentVariableEntry = {
  id: string;
  name: string;
  aliases: string[];
  description?: string;
  format?: string;
  updatedAt: string;
};

export type DocumentVariableEntryInput = {
  name: string;
  aliases?: string[] | string;
  description?: string;
  format?: string;
};

const DICTIONARY_KEY = '_variables.json';
const DICTIONARY_CONTENT_TYPE = 'application/json; charset=utf-8';
const MAX_NAME_LENGTH = 64;
const MAX_ALIASES = 20;

function cleanName(input: string): string {
  return input.replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
}

// 多维表格里别名常写成「证件号、身份证」「证件号,身份证」，也可能是多选数组。
export function parseAliasList(input: string[] | string | undefined): string[] {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,，、;；\n]+/);
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of raw) {
    const name = cleanName(String(item));
    if (!name || seen.has(name)) continue;
    seen.add(name);
    output.push(name);
  }
  return output;
}

export function normalizeEntryInput(id: string, input: DocumentVariableEntryInput): DocumentVariableEntry {
  const entryId = id.trim();
  if (!entryId || entryId.length > 128) throw new UserFacingError('变量编号不合法。');
  const name = cleanName(input.name || '');
  if (!name) throw new UserFacingError('变量标准名不能为空。');
  if (name.length > MAX_NAME_LENGTH) throw new UserFacingError(`变量名不能超过 ${MAX_NAME_LENGTH} 个字。`);
  const aliases = parseAliasList(input.aliases).filter((alias) => alias !== name);
  if (aliases.length > MAX_ALIASES) throw new UserFacingError(`一个变量最多 ${MAX_ALIASES} 个别名。`);
  if (aliases.some((alias) => alias.length > MAX_NAME_LENGTH)) throw new UserFacingError(`别名不能超过 ${MAX_NAME_LENGTH} 个字。`);
  return {
    id: entryId,
    name,
    aliases,
    ...(input.description?.trim() ? { description: input.description.trim().slice(0, 500) } : {}),
    ...(input.format?.trim() ? { format: input.format.trim().slice(0, 64) } : {}),
    updatedAt: new Date().toISOString(),
  };
}

// 同一个名字只能属于一组，否则生成时不知道该顶替谁。
export function findNameConflict(entries: DocumentVariableEntry[], candidate: DocumentVariableEntry): string | null {
  const candidateNames = [candidate.name, ...candidate.aliases];
  for (const entry of entries) {
    if (entry.id === candidate.id) continue;
    const taken = new Set([entry.name, ...entry.aliases]);
    const clash = candidateNames.find((name) => taken.has(name));
    if (clash) return `「${clash}」已经记在变量「${entry.name}」下面，同一个名字只能属于一组。`;
  }
  return null;
}

function groupOf(entries: DocumentVariableEntry[], name: string): DocumentVariableEntry | undefined {
  return entries.find((entry) => entry.name === name || entry.aliases.includes(name));
}

// 模板里写的是别名时，返回它的标准名；本身就是标准名或不在词典里，返回 null。
export function standardNameFor(entries: DocumentVariableEntry[], variable: string): string | null {
  const entry = groupOf(entries, variable);
  return entry && entry.name !== variable ? entry.name : null;
}

// 生成时用：调用方没传、但同组里传了的变量，用同组的值顶上。
// derived 记录「顶上的变量 ← 来自哪个变量」，用来判断多余变量和回给调用方看。
export function applyVariableAliases(
  provided: Record<string, string>,
  entries: DocumentVariableEntry[],
): { variables: Record<string, string>; derived: Record<string, string> } {
  const variables = Object.assign(Object.create(null) as Record<string, string>, provided);
  const derived = Object.create(null) as Record<string, string>;
  for (const entry of entries) {
    const members = [entry.name, ...entry.aliases];
    const source = members.find((name) => Object.prototype.hasOwnProperty.call(provided, name));
    if (!source) continue;
    for (const name of members) {
      if (Object.prototype.hasOwnProperty.call(variables, name)) continue;
      variables[name] = provided[source];
      derived[name] = source;
    }
  }
  return { variables, derived };
}

export class DocumentVariableStore {
  constructor(
    private readonly store: TemplateObjectStore,
    private readonly runExclusive: <T>(operation: () => Promise<T>) => Promise<T>,
  ) {}

  async list(): Promise<DocumentVariableEntry[]> {
    try {
      const buffer = await this.store.getObject(this.store.objectName(DICTIONARY_KEY));
      const parsed = JSON.parse(buffer.toString('utf8')) as { variables?: unknown };
      return Array.isArray(parsed.variables)
        ? parsed.variables.filter((item): item is DocumentVariableEntry => Boolean(item && typeof item === 'object' && (item as DocumentVariableEntry).id && (item as DocumentVariableEntry).name))
        : [];
    } catch (error) {
      if (error instanceof TemplateObjectNotFoundError) return [];
      throw error;
    }
  }

  async upsert(id: string, input: DocumentVariableEntryInput): Promise<DocumentVariableEntry> {
    const entry = normalizeEntryInput(id, input);
    return this.runExclusive(async () => {
      const entries = await this.list();
      const conflict = findNameConflict(entries, entry);
      if (conflict) throw new UserFacingError(conflict);
      await this.write([...entries.filter((item) => item.id !== entry.id), entry]);
      return entry;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const entries = await this.list();
      const next = entries.filter((item) => item.id !== id.trim());
      if (next.length === entries.length) return false;
      await this.write(next);
      return true;
    });
  }

  private async write(entries: DocumentVariableEntry[]): Promise<void> {
    const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
    await this.store.putObject(DICTIONARY_KEY, Buffer.from(JSON.stringify({ variables: sorted }, null, 2)), DICTIONARY_CONTENT_TYPE);
  }
}
