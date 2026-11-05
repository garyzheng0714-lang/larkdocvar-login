// 检查模板：发布前把模板读一遍，告诉运营能不能发、要不要审核、哪里写错了、模板库里有没有重复的。
// 只读，不保存任何东西。多维表格「模板版本」表的「检查」按钮调它，结果写回表格。
import { UserFacingError } from './documentRenderStorageErrors';
import { analyzeTemplate, loadTemplateSource, readTemplateText, templateFileName, type TemplateSourceInput } from './documentTemplateAnalysis';
import type { DocumentTemplateThumbnail } from './documentTemplateThumbnail';
import { standardNameFor, type DocumentVariableEntry } from './documentVariableDictionary';

export type TemplateProblemCode =
  | 'UNREADABLE'
  | 'NO_VARIABLES'
  | 'FULLWIDTH_BRACES'
  | 'EMPTY_PLACEHOLDER'
  | 'UNPAIRED_BRACES'
  | 'SINGLE_BRACES'
  | 'ALIAS_NAME'
  | 'SAME_AS_ACTIVE';

export type TemplateProblem = {
  code: TemplateProblemCode;
  level: 'error' | 'warning';
  message: string;
};

export type TemplateDuplicate = {
  templateId: string;
  name: string;
  reason: 'same-file' | 'same-variables' | 'similar-name';
};

export type TemplateInspection = {
  fileName: string;
  sha256: string;
  size: number;
  variables: string[];
  variablesText: string;
  thumbnail?: DocumentTemplateThumbnail;
  problems: TemplateProblem[];
  problemsText: string;
  aliasHints: Array<{ variable: string; standardName: string }>;
  unknownVariables: string[];
  duplicates: TemplateDuplicate[];
  compare?: {
    templateId: string;
    name: string;
    activeVersionId: string;
    added: string[];
    removed: string[];
    variablesChanged: boolean;
  };
  publishable: boolean;
  needsReview: boolean;
  summaryText: string;
};

export type InspectableTemplate = {
  templateId: string;
  name: string;
  status: 'active' | 'deleted';
  activeVersionId: string;
  versions: Array<{ versionId: string; sha256: string; sourceSha256?: string; variables: string[] }>;
};

export type TemplateInspectDeps = {
  listTemplates(): Promise<Array<{ templateId: string; name: string }>>;
  getTemplate(templateId: string): Promise<InspectableTemplate>;
  listVariables(): Promise<DocumentVariableEntry[]>;
};

const VALID_PLACEHOLDER = /\{\{\s*[^{}]*?[^{}\s][^{}]*?\s*\}\}/g;
const MAX_SAMPLES = 5;

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function samplesText(samples: string[]): string {
  return samples.slice(0, MAX_SAMPLES).join('、') + (samples.length > MAX_SAMPLES ? ` 等 ${samples.length} 处` : '');
}

function around(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - 6), index + length + 6).replace(/\s+/g, ' ').trim();
}

// 找出 Word 里「看着像变量、生成时却不会被替换」的写法。
export function findWritingProblems(text: string): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  const fullwidth = unique((text.match(/[｛{]{2}[^｛｝{}\n]{0,40}[｝}]{2}/g) || []).filter((item) => /[｛｝]/.test(item)));
  if (fullwidth.length === 0 && /｛｛|｝｝/.test(text)) fullwidth.push(around(text, text.search(/｛｛|｝｝/), 2));
  if (fullwidth.length > 0) {
    problems.push({ code: 'FULLWIDTH_BRACES', level: 'error', message: `有变量用了中文大括号，生成时不会替换，请改成英文的 {{ }}：${samplesText(fullwidth)}` });
  }
  const empty = text.match(/\{\{\s*\}\}/g) || [];
  if (empty.length > 0) {
    problems.push({ code: 'EMPTY_PLACEHOLDER', level: 'error', message: `有 ${empty.length} 处空的 {{ }}，里面要写变量名。` });
  }
  // 已经报过的（正确的变量、空占位符、中英混用的大括号）先拿掉，剩下的再看配不配对。
  const rest = text
    .replace(VALID_PLACEHOLDER, ' ')
    .replace(/\{\{\s*\}\}/g, ' ')
    .replace(/[｛{]{2}[^｛｝{}\n]{0,40}[｝}]{2}/g, ' ');
  const unpaired: string[] = [];
  for (const match of rest.matchAll(/\{\{|\}\}/g)) unpaired.push(around(rest, match.index ?? 0, 2));
  if (unpaired.length > 0) {
    problems.push({ code: 'UNPAIRED_BRACES', level: 'error', message: `有大括号没配对，请检查：${samplesText(unique(unpaired))}` });
  }
  const single = unique(rest.match(/(?<!\{)\{[^{}\n]{1,30}\}(?!\})/g) || []);
  if (single.length > 0) {
    problems.push({ code: 'SINGLE_BRACES', level: 'warning', message: `有单层大括号，生成时不会替换；如果是变量请写成两层：${samplesText(single)}` });
  }
  return problems;
}

function normalizeTemplateName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.docx?$/, '')
    .replace(/-ed\d+/g, '')
    .replace(/[（(]\s*\d+\s*[)）]|副本|copy|最新版|新版|旧版|v\d+(\.\d+)*|\d{6,8}/g, '')
    .replace(/[\s_\-—·.,，。:：【】[\]()（）]+/g, '');
}

function sameSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((item) => set.has(item));
}

async function findDuplicates(
  deps: TemplateInspectDeps,
  candidate: { name: string; sourceSha256: string; sha256?: string; variables: string[] },
  excludeTemplateId?: string,
): Promise<TemplateDuplicate[]> {
  const listed = (await deps.listTemplates()).filter((item) => item.templateId !== excludeTemplateId);
  const records = await Promise.all(listed.map((item) => deps.getTemplate(item.templateId).catch(() => null)));
  const candidateName = normalizeTemplateName(candidate.name);
  const duplicates: TemplateDuplicate[] = [];
  for (const record of records) {
    if (!record || record.status === 'deleted') continue;
    const active = record.versions.find((version) => version.versionId === record.activeVersionId);
    const sameFile = record.versions.some((version) => (
      version.sourceSha256 === candidate.sourceSha256 || version.sha256 === candidate.sourceSha256 || (candidate.sha256 && version.sha256 === candidate.sha256)
    ));
    const reason: TemplateDuplicate['reason'] | null = sameFile
      ? 'same-file'
      : active && candidate.variables.length > 0 && sameSet(active.variables, candidate.variables)
        ? 'same-variables'
        : candidateName && normalizeTemplateName(record.name) === candidateName
          ? 'similar-name'
          : null;
    if (reason) duplicates.push({ templateId: record.templateId, name: record.name, reason });
  }
  return duplicates;
}

const DUPLICATE_REASON_TEXT: Record<TemplateDuplicate['reason'], string> = {
  'same-file': '同一个文件',
  'same-variables': '变量完全一样',
  'similar-name': '名字很像',
};

function buildSummary(inspection: Omit<TemplateInspection, 'summaryText'>): string {
  const errors = inspection.problems.filter((problem) => problem.level === 'error');
  const warnings = inspection.problems.filter((problem) => problem.level === 'warning');
  if (errors.length > 0) {
    return `不能发布：${errors[0].message}${errors.length > 1 ? `（还有 ${errors.length - 1} 个问题）` : ''}`;
  }
  if (inspection.problems.some((problem) => problem.code === 'SAME_AS_ACTIVE')) {
    return '和现在用的版本是同一个文件，不用重新发布。';
  }
  const parts = [`可以发布：共 ${inspection.variables.length} 个变量。`];
  if (!inspection.compare) {
    parts.push('这是新模板，需要审核后发布。');
  } else if (inspection.compare.variablesChanged) {
    const changes = [
      inspection.compare.added.length > 0 ? `新增 ${inspection.compare.added.join('、')}` : '',
      inspection.compare.removed.length > 0 ? `去掉 ${inspection.compare.removed.join('、')}` : '',
    ].filter(Boolean).join('，');
    parts.push(`比现在用的版本${changes}，需要审核后发布。`);
  } else {
    parts.push('变量和现在用的版本一样，模板负责人可以直接发布。');
  }
  if (warnings.length > 0) parts.push(`另有 ${warnings.length} 条提醒。`);
  if (inspection.duplicates.length > 0) {
    parts.push(`模板库里已有相似模板：${inspection.duplicates.map((item) => `${item.name}（${DUPLICATE_REASON_TEXT[item.reason]}）`).join('、')}。`);
  }
  return parts.join('');
}

function unreadableInspection(fileName: string, message: string): TemplateInspection {
  return {
    fileName,
    sha256: '',
    size: 0,
    variables: [],
    variablesText: '',
    problems: [{ code: 'UNREADABLE', level: 'error', message }],
    problemsText: `【要改】${message}`,
    aliasHints: [],
    unknownVariables: [],
    duplicates: [],
    publishable: false,
    needsReview: true,
    summaryText: `不能发布：${message}`,
  };
}

export async function inspectTemplate(
  input: TemplateSourceInput & { compareTemplateId?: string },
  deps: TemplateInspectDeps,
): Promise<TemplateInspection> {
  const fileName = templateFileName(input);
  const displayName = input.name?.trim() || fileName.replace(/\.docx$/i, '');
  const compareRecord = input.compareTemplateId ? await deps.getTemplate(input.compareTemplateId) : undefined;
  if (compareRecord?.status === 'deleted') throw new UserFacingError('要对比的模板已删除。');
  let source: Awaited<ReturnType<typeof loadTemplateSource>>;
  try {
    source = await loadTemplateSource(input);
  } catch (error) {
    if (!(error instanceof UserFacingError)) throw error;
    return unreadableInspection(fileName, `模板文件拿不到：${error.message}`);
  }
  const problems: TemplateProblem[] = [];
  let analyzed: Awaited<ReturnType<typeof analyzeTemplate>> | undefined;
  try {
    analyzed = await analyzeTemplate(source, input);
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : '未知原因';
    problems.push({ code: 'UNREADABLE', level: 'error', message: `模板读不了，生成会失败：${reason}` });
  }
  const variables = analyzed?.variables || [];
  if (analyzed && variables.length === 0) {
    problems.push({ code: 'NO_VARIABLES', level: 'error', message: '模板里没找到任何变量。变量要写成 {{变量名}}（英文大括号，两层）。' });
  }
  problems.push(...findWritingProblems(await readTemplateText(analyzed?.buffer || source.buffer)));

  const dictionary = await deps.listVariables();
  const aliasHints = variables
    .map((variable) => ({ variable, standardName: standardNameFor(dictionary, variable) }))
    .filter((hint): hint is { variable: string; standardName: string } => Boolean(hint.standardName));
  for (const hint of aliasHints) {
    problems.push({ code: 'ALIAS_NAME', level: 'warning', message: `「${hint.variable}」在变量表里是「${hint.standardName}」的别名，建议模板里统一写「${hint.standardName}」。` });
  }
  const known = new Set(dictionary.flatMap((entry) => [entry.name, ...entry.aliases]));
  const unknownVariables = dictionary.length > 0 ? variables.filter((name) => !known.has(name)) : [];

  let compare: TemplateInspection['compare'];
  if (compareRecord) {
    const active = compareRecord.versions.find((version) => version.versionId === compareRecord.activeVersionId);
    const activeVariables = active?.variables || [];
    const added = variables.filter((name) => !activeVariables.includes(name));
    const removed = activeVariables.filter((name) => !variables.includes(name));
    compare = {
      templateId: compareRecord.templateId,
      name: compareRecord.name,
      activeVersionId: compareRecord.activeVersionId,
      added,
      removed,
      variablesChanged: added.length > 0 || removed.length > 0,
    };
    if (active && (active.sourceSha256 === source.sourceSha256 || active.sha256 === source.sourceSha256 || active.sha256 === analyzed?.sha256)) {
      problems.push({ code: 'SAME_AS_ACTIVE', level: 'warning', message: '和现在用的版本是同一个文件。' });
    }
  }

  const duplicates = await findDuplicates(
    deps,
    { name: displayName, sourceSha256: source.sourceSha256, sha256: analyzed?.sha256, variables },
    input.compareTemplateId,
  );
  const publishable = !problems.some((problem) => problem.level === 'error');
  const inspection = {
    fileName,
    sha256: source.sourceSha256,
    size: source.buffer.length,
    variables,
    variablesText: variables.join('、'),
    ...(analyzed ? { thumbnail: analyzed.thumbnail } : {}),
    problems,
    problemsText: problems.map((problem) => `${problem.level === 'error' ? '【要改】' : '【提醒】'}${problem.message}`).join('\n'),
    aliasHints,
    unknownVariables,
    duplicates,
    ...(compare ? { compare } : {}),
    publishable,
    needsReview: !compare || compare.variablesChanged,
  };
  return { ...inspection, summaryText: buildSummary(inspection) };
}
