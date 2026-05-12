import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import '../env';

const execFileAsync = promisify(execFile);
const DEFAULT_IMPORT_NAME = `Docx API 验收导入-${new Date().toISOString().replace(/[:.]/g, '-')}`;

type CliResult = {
  rawOutput: string;
  json: Record<string, unknown>;
};
type ImportMode = 'dry-run' | 'execute';
type ImportReport = {
  ok: boolean;
  milestoneRunId?: string;
  mode?: ImportMode;
  identity?: string;
  file?: string;
  importName?: string;
  checks?: string[];
  result?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
  error?: string;
  reportFile?: string;
};
type CommandFailure = Error & {
  stdout?: string;
  stderr?: string;
};

export function sanitizeText(value: string): string {
  return value.replace(/ou_[A-Za-z0-9]+/g, 'ou_***');
}

function sanitizeReportValue<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReportValue(item)) as T;
  }
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = sanitizeReportValue(item);
    }
    return sanitized as T;
  }
  return value;
}

function fail(message: string): never {
  throw new Error(message);
}

function getFilePath(): string {
  const rawPath = process.argv[2] || process.env.DOCUMENT_RENDER_FEISHU_IMPORT_FILE || '';
  if (!rawPath.trim()) {
    fail('请传入要导入验证的 Docx 文件路径，或设置 DOCUMENT_RENDER_FEISHU_IMPORT_FILE。');
  }
  return resolve(rawPath);
}

function getImportName(): string {
  return (process.env.DOCUMENT_RENDER_FEISHU_IMPORT_NAME || DEFAULT_IMPORT_NAME).trim();
}

function shouldExecute(): boolean {
  return process.env.DOCUMENT_RENDER_FEISHU_IMPORT_EXECUTE === 'true';
}

function getIdentity(): string {
  return (process.env.DOCUMENT_RENDER_FEISHU_IMPORT_AS || 'user').trim() || 'user';
}

async function writeReport(reportPath: string, report: ImportReport): Promise<ImportReport> {
  const milestoneRunId = (process.env.DOCUMENT_RENDER_MILESTONE1_RUN_ID || '').trim();
  const withRunId = sanitizeReportValue(milestoneRunId ? { milestoneRunId, ...report } : report);
  if (!reportPath) return withRunId;
  await mkdir(dirname(reportPath), { recursive: true });
  const output = { ...withRunId, reportFile: reportPath };
  await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

function readJsonFromOutput(output: string): Record<string, unknown> {
  const firstBrace = output.indexOf('{');
  const lastBrace = output.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    fail(`lark-cli 没有返回 JSON：${output.slice(0, 500)}`);
  }
  return JSON.parse(output.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
}

function tryReadJsonFromOutput(output: string): Record<string, unknown> | undefined {
  const parsedObjects: Record<string, unknown>[] = [];
  for (let start = 0; start < output.length; start += 1) {
    if (output[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const char = output[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
      } else if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(output.slice(start, index + 1)) as Record<string, unknown>;
            parsedObjects.push(parsed);
          } catch {
            // Keep scanning; command failures can contain partial JSON-looking text.
          }
          start = index;
          break;
        }
      }
    }
  }
  const reversed = parsedObjects.slice().reverse();
  return reversed.find((item) => 'ok' in item) || parsedObjects[parsedObjects.length - 1];
}

function readFailureOutput(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }
  const commandError = error as CommandFailure;
  return [commandError.stdout, commandError.stderr, commandError.message].filter(Boolean).join('\n');
}

function formatFailureMessage(json: Record<string, unknown> | undefined, fallback: string): string {
  const error = json?.error;
  if (error && typeof error === 'object') {
    const item = error as { message?: unknown; code?: unknown; hint?: unknown };
    const parts = [
      item.message ? String(item.message) : '',
      item.code ? `code=${String(item.code)}` : '',
      item.hint ? String(item.hint) : '',
    ].filter(Boolean);
    if (parts.length > 0) {
      return `飞书导入失败：${parts.join('；')}`;
    }
  }
  return fallback.slice(0, 1000);
}

async function runJsonDiagnostic(args: string[]): Promise<Record<string, unknown>> {
  try {
    const { stdout, stderr } = await execFileAsync('lark-cli', args, {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return tryReadJsonFromOutput([stdout, stderr].filter(Boolean).join('\n')) || { ok: true };
  } catch (error) {
    const rawOutput = readFailureOutput(error);
    return tryReadJsonFromOutput(rawOutput) || { ok: false, error: rawOutput.slice(0, 1000) };
  }
}

async function collectAuthDiagnostics(): Promise<Record<string, unknown>> {
  const status = await runJsonDiagnostic(['auth', 'status', '--verify']);
  const appScopes = await runJsonDiagnostic(['auth', 'scopes', '--format', 'json']);
  const userImportScope = await runJsonDiagnostic(['auth', 'check', '--scope', 'docs:document:import']);
  const userScopes = Array.isArray(appScopes.userScopes) ? appScopes.userScopes.map(String) : [];
  const missingScopes = Array.isArray(userImportScope.missing) ? userImportScope.missing.map(String) : [];
  return {
    status: {
      appId: status.appId,
      brand: status.brand,
      identity: status.identity,
      defaultAs: status.defaultAs,
      hasUserToken: userImportScope.error !== 'no_token',
      note: status.note,
    },
    appScopes: {
      ok: appScopes.ok,
      count: appScopes.count,
      tokenType: appScopes.tokenType,
      hasDocumentImportScope: userScopes.includes('docs:document:import'),
    },
    userImportScope: {
      ok: userImportScope.ok,
      error: userImportScope.error,
      missing: missingScopes,
    },
  };
}

async function runLarkCli(filePath: string, execute: boolean): Promise<CliResult> {
  const cwd = dirname(filePath);
  const args = [
    'drive',
    '+import',
    '--file',
    `./${basename(filePath)}`,
    '--type',
    'docx',
    '--name',
    getImportName(),
  ];
  const folderToken = (process.env.DOCUMENT_RENDER_FEISHU_IMPORT_FOLDER_TOKEN || '').trim();
  if (folderToken) {
    args.push('--folder-token', folderToken);
  }
  const identity = getIdentity();
  if (identity) {
    args.push('--as', identity);
  }
  if (!execute) {
    args.push('--dry-run');
  }

  const { stdout, stderr } = await execFileAsync('lark-cli', args, {
    cwd,
    encoding: 'utf8',
    timeout: execute ? 120000 : 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const rawOutput = [stdout, stderr].filter(Boolean).join('\n');
  return {
    rawOutput,
    json: readJsonFromOutput(rawOutput),
  };
}

function collectDryRunChecks(json: Record<string, unknown>): string[] {
  const api = Array.isArray(json.api) ? json.api : [];
  const joined = JSON.stringify(api);
  const checks = [];
  if (joined.includes('/open-apis/drive/v1/medias/upload_all')) {
    checks.push('upload-media-api-present');
  }
  if (joined.includes('/open-apis/drive/v1/import_tasks')) {
    checks.push('import-task-api-present');
  }
  if (joined.includes('"type":"docx"') || joined.includes('\\"type\\":\\"docx\\"')) {
    checks.push('target-type-docx');
  }
  if (checks.length < 3) {
    fail(`飞书导入 dry-run 调用链不完整：${joined}`);
  }
  return checks;
}

function collectExecuteChecks(json: Record<string, unknown>): string[] {
  const serialized = JSON.stringify(json);
  const checks = ['import-command-finished'];
  if (serialized.includes('ticket')) {
    checks.push('import-ticket-present');
  }
  if (serialized.includes('url') || serialized.includes('token') || serialized.includes('result')) {
    checks.push('import-result-present');
  }
  return checks;
}

async function main(): Promise<void> {
  const filePath = getFilePath();
  await access(filePath);
  const execute = shouldExecute();
  const mode: ImportMode = execute ? 'execute' : 'dry-run';
  const result = await runLarkCli(filePath, execute);
  const checks = execute ? collectExecuteChecks(result.json) : collectDryRunChecks(result.json);

  const report = await writeReport(process.env.DOCUMENT_RENDER_FEISHU_IMPORT_REPORT_PATH || '', {
    ok: true,
    mode,
    identity: getIdentity(),
    file: filePath,
    importName: getImportName(),
    checks,
    result: result.json,
  });
  console.log(JSON.stringify(report));
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  main().catch(async (error) => {
    const rawOutput = readFailureOutput(error);
    const result = tryReadJsonFromOutput(rawOutput);
    const report = await writeReport(process.env.DOCUMENT_RENDER_FEISHU_IMPORT_REPORT_PATH || '', {
      ok: false,
      mode: shouldExecute() ? 'execute' : 'dry-run',
      identity: getIdentity(),
      file: process.argv[2] ? resolve(process.argv[2]) : undefined,
      importName: getImportName(),
      error: formatFailureMessage(result, rawOutput || String(error)),
      ...(result ? { result } : {}),
      diagnostics: await collectAuthDiagnostics(),
    });
    console.error(JSON.stringify(report));
    process.exit(1);
  });
}
