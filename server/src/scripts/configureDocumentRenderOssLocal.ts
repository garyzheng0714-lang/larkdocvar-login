import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path, { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

type RawConfig = Record<string, unknown>;

export type DocumentRenderOssLocalConfig = {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  prefix?: string;
  ttlSeconds?: string;
};

const REQUIRED_KEYS = [
  'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID',
  'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET',
  'DOCUMENT_RENDER_OSS_BUCKET',
  'DOCUMENT_RENDER_OSS_REGION',
] as const;

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function parseDotenvText(input: string): RawConfig {
  const result: RawConfig = {};
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return result;
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
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseInput(input: string): RawConfig {
  const trimmed = input.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('输入必须是 JSON 对象或 KEY=VALUE 格式。');
    }
    return parsed as RawConfig;
  }
  return parseDotenvText(trimmed);
}

function readValue(raw: RawConfig, names: string[]): string {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

function readInputThenEnv(input: RawConfig, env: NodeJS.ProcessEnv, names: string[]): string {
  return readValue(input, names) || readValue(env, names);
}

export function parseDocumentRenderOssLocalConfig(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
): DocumentRenderOssLocalConfig {
  const raw = parseInput(input);
  const config: DocumentRenderOssLocalConfig = {
    accessKeyId: readInputThenEnv(raw, env, ['DOCUMENT_RENDER_OSS_ACCESS_KEY_ID', 'ALIYUN_OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_ID', 'accessKeyId']),
    accessKeySecret: readInputThenEnv(raw, env, ['DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET', 'ALIYUN_OSS_ACCESS_KEY_SECRET', 'OSS_ACCESS_KEY_SECRET', 'accessKeySecret']),
    bucket: readInputThenEnv(raw, env, ['DOCUMENT_RENDER_OSS_BUCKET', 'ALIYUN_OSS_BUCKET', 'OSS_BUCKET', 'bucket']),
    region: readInputThenEnv(raw, env, ['DOCUMENT_RENDER_OSS_REGION', 'ALIYUN_OSS_REGION', 'OSS_REGION', 'OSS_REGION_ID', 'region']),
    prefix: readInputThenEnv(raw, env, ['DOCUMENT_RENDER_OSS_PREFIX', 'prefix']) || 'document-renders',
    ttlSeconds: readInputThenEnv(raw, env, ['DOCUMENT_RENDER_DOWNLOAD_TTL_SECONDS', 'ttlSeconds']) || '3600',
  };
  const missing = [
    ['DOCUMENT_RENDER_OSS_ACCESS_KEY_ID', config.accessKeyId],
    ['DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET', config.accessKeySecret],
    ['DOCUMENT_RENDER_OSS_BUCKET', config.bucket],
    ['DOCUMENT_RENDER_OSS_REGION', config.region],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`OSS 配置不完整，缺少：${missing.join(', ')}`);
  }
  return config;
}

export function buildDocumentRenderOssEnvValues(config: DocumentRenderOssLocalConfig): Record<string, string> {
  return {
    DOCUMENT_RENDER_OSS_ACCESS_KEY_ID: config.accessKeyId,
    DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET: config.accessKeySecret,
    DOCUMENT_RENDER_OSS_BUCKET: config.bucket,
    DOCUMENT_RENDER_OSS_REGION: config.region,
    DOCUMENT_RENDER_OSS_PREFIX: config.prefix || 'document-renders',
    DOCUMENT_RENDER_DOWNLOAD_TTL_SECONDS: config.ttlSeconds || '3600',
  };
}

function formatEnvValue(value: string): string {
  return JSON.stringify(value);
}

export function upsertEnvContent(content: string, values: Record<string, string>): string {
  const keys = new Set(Object.keys(values));
  const written = new Set<string>();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !keys.has(key)) {
      output.push(line);
      continue;
    }
    if (written.has(key)) continue;
    output.push(`${key}=${formatEnvValue(values[key])}`);
    written.add(key);
  }
  while (output.length > 0 && output[output.length - 1] === '') {
    output.pop();
  }
  const missing = Object.keys(values).filter((key) => !written.has(key));
  if (missing.length > 0) {
    if (output.length > 0) output.push('');
    output.push('# Document render OSS local private config');
    for (const key of missing) {
      output.push(`${key}=${formatEnvValue(values[key])}`);
    }
  }
  return `${output.join('\n')}\n`;
}

async function readExisting(pathname: string): Promise<string> {
  try {
    return await readFile(pathname, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function main(): Promise<void> {
  const input = await readStdin();
  const config = parseDocumentRenderOssLocalConfig(input);
  const values = buildDocumentRenderOssEnvValues(config);
  const targetPath = process.env.DOCUMENT_RENDER_LOCAL_ENV_PATH || path.join(process.cwd(), '.env.local');
  const current = await readExisting(targetPath);
  const next = upsertEnvContent(current, values);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, next, { mode: 0o600 });
  await chmod(targetPath, 0o600);
  console.log(JSON.stringify({
    ok: true,
    path: targetPath,
    updatedKeys: Object.keys(values),
    next: 'npm run verify:oss',
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  });
}
