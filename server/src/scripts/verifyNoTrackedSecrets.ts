import '../env';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SECRET_ENV_NAMES = [
  'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID',
  'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET',
  'DOCUMENT_RENDER_OSS_BUCKET',
  'ALIYUN_OSS_ACCESS_KEY_ID',
  'ALIYUN_OSS_ACCESS_KEY_SECRET',
  'ALIYUN_OSS_BUCKET',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'OSS_BUCKET',
  'TOS_ACCESS_KEY',
  'TOS_ACCESS_KEY_ID',
  'TOS_SECRET_KEY',
  'TOS_SECRET_ACCESS_KEY',
  'TOS_BUCKET',
];

type SecretCandidate = {
  key: string;
  value: string;
};

type SecretMatch = {
  key: string;
  files: string[];
};

type GitGrep = (value: string) => string[];
type SecretReport = {
  ok: boolean;
  milestoneRunId?: string;
  checkedKeys: string[];
  matches: SecretMatch[];
  reportFile?: string;
};

async function readOptionalFile(pathname: string): Promise<string> {
  try {
    return await readFile(pathname, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function unquoteEnvValue(value: string): string {
  if (!value) return '';
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

export function parseSecretEnvValues(content: string): SecretCandidate[] {
  const candidates: SecretCandidate[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !SECRET_ENV_NAMES.includes(match[1])) continue;
    const value = unquoteEnvValue(match[2].trim());
    if (value) candidates.push({ key: match[1], value });
  }
  return candidates;
}

export function collectSecretCandidates(
  env: NodeJS.ProcessEnv,
  envFileContents: string[],
): SecretCandidate[] {
  const candidates = [
    ...SECRET_ENV_NAMES
      .map((key) => ({ key, value: (env[key] || '').trim() }))
      .filter((item) => item.value),
    ...envFileContents.flatMap(parseSecretEnvValues),
  ];
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const id = `${item.key}\0${item.value}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function gitGrepTracked(value: string): string[] {
  const result = spawnSync('git', ['grep', '-l', '--fixed-strings', '--', value], {
    encoding: 'utf8',
  });
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error((result.stderr || 'git grep failed').trim());
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function findTrackedSecretMatches(candidates: SecretCandidate[], gitGrep: GitGrep): SecretMatch[] {
  return candidates
    .map((candidate) => ({
      key: candidate.key,
      files: gitGrep(candidate.value).filter((file) => !file.endsWith('.env.local') && !file.endsWith('.env')),
    }))
    .filter((match) => match.files.length > 0);
}

async function writeReport(report: SecretReport): Promise<SecretReport> {
  const milestoneRunId = (process.env.DOCUMENT_RENDER_MILESTONE1_RUN_ID || '').trim();
  const withRunId = milestoneRunId ? { ...report, milestoneRunId } : report;
  const reportPath = (process.env.DOCUMENT_RENDER_SECRET_REPORT_PATH || '').trim();
  if (!reportPath) return withRunId;
  await mkdir(dirname(reportPath), { recursive: true });
  const output = { ...withRunId, reportFile: reportPath };
  await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

async function main(): Promise<void> {
  const envPath = process.env.DOCUMENT_RENDER_LOCAL_ENV_PATH || '.env.local';
  const candidates = collectSecretCandidates(process.env, [
    await readOptionalFile(envPath),
    await readOptionalFile('.env'),
  ]);
  const matches = findTrackedSecretMatches(candidates, gitGrepTracked);
  const report = await writeReport({
    ok: matches.length === 0,
    checkedKeys: Array.from(new Set(candidates.map((item) => item.key))).sort(),
    matches,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  });
}
