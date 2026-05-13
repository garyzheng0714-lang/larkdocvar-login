import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import '../env';

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 19090;
const TITLE = '<title>文档模板批量生成</title>';

type Config = {
  port: number;
  baseUrl: string;
  outputPath: string;
  verifyReportPath: string;
  ossReportPath: string;
  secretReportPath: string;
  clientReportPath: string;
  feishuReportPath: string;
  auditReportPath: string;
  runId: string;
};
type FeishuAuthStatus = { ok: boolean; evidence: string };
type PreflightTask = {
  name: string;
  run: () => Promise<void>;
};
type MilestoneEnvOptions = {
  expectedStorage?: 'oss' | 'tos' | 'local';
  feishuExecute?: boolean;
};

const OSS_STORAGE_ENV_NAMES = [
  'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID',
  'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET',
  'DOCUMENT_RENDER_OSS_BUCKET',
  'DOCUMENT_RENDER_OSS_REGION',
  'DOCUMENT_RENDER_OSS_PREFIX',
  'ALIYUN_OSS_ACCESS_KEY_ID',
  'ALIYUN_OSS_ACCESS_KEY_SECRET',
  'ALIYUN_OSS_BUCKET',
  'ALIYUN_OSS_REGION',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'OSS_BUCKET',
  'OSS_REGION',
  'OSS_REGION_ID',
];

const UNSUPPORTED_OBJECT_STORAGE_ENV_NAMES = [
  'TOS_ACCESS_KEY',
  'TOS_SECRET_KEY',
  'TOS_BUCKET',
  'TOS_REGION',
  'TOS_ENDPOINT',
  'DOCUMENT_TOS_ROOT_PREFIX',
  'DOCUMENT_RENDER_TOS_PREFIX',
];

const DOCUMENT_RENDER_RUNTIME_ENV_NAMES = [
  ...OSS_STORAGE_ENV_NAMES,
  ...UNSUPPORTED_OBJECT_STORAGE_ENV_NAMES,
  'DOCUMENT_RENDER_STORAGE_PROVIDER',
  'DOCUMENT_RENDER_OBJECT_STORAGE_PROVIDER',
  'DOCUMENT_RENDER_STORAGE_DIR',
  'DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS',
  'DOCUMENT_RENDER_PUBLIC_BASE_URL',
  'DOCUMENT_RENDER_DOWNLOAD_TTL_SECONDS',
  'DOCUMENT_RENDER_DOWNLOAD_TTL_MS',
  'DOCUMENT_RENDER_MAX_FILES',
  'DOCUMENT_RENDER_MAX_UNZIPPED_BYTES',
  'DOCUMENT_RENDER_MAX_ZIP_ENTRIES',
];

export function getConfig(): Config {
  const port = Number(process.env.DOCUMENT_RENDER_MILESTONE1_PORT || DEFAULT_PORT);
  const safePort = Number.isFinite(port) && port > 0 ? Math.floor(port) : DEFAULT_PORT;
  const baseUrl = `http://127.0.0.1:${safePort}`;
  return {
    port: safePort,
    baseUrl,
    outputPath: process.env.DOCUMENT_RENDER_VERIFY_OUTPUT_PATH || '/tmp/larkdocvar-generated-check-latest.docx',
    verifyReportPath: process.env.DOCUMENT_RENDER_VERIFY_REPORT_PATH || '/tmp/larkdocvar-document-render-latest-report.json',
    ossReportPath: process.env.DOCUMENT_RENDER_OSS_REPORT_PATH || '/tmp/larkdocvar-oss-latest-report.json',
    secretReportPath: process.env.DOCUMENT_RENDER_SECRET_REPORT_PATH || '/tmp/larkdocvar-secrets-latest-report.json',
    clientReportPath: process.env.DOCUMENT_RENDER_CLIENT_REPORT_PATH || '/tmp/larkdocvar-docx-client-latest-report.json',
    feishuReportPath: process.env.DOCUMENT_RENDER_FEISHU_IMPORT_REPORT_PATH || '/tmp/larkdocvar-feishu-import-latest-report.json',
    auditReportPath: process.env.DOCUMENT_RENDER_AUDIT_REPORT_PATH || '/tmp/larkdocvar-milestone1-audit-latest-report.json',
    runId: process.env.DOCUMENT_RENDER_MILESTONE1_RUN_ID
      || `milestone1-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  };
}

function mergeEnv(base: NodeJS.ProcessEnv, overlay: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(output)) {
    if (value === undefined) delete output[name];
  }
  for (const [name, value] of Object.entries(overlay)) {
    if (value === undefined) delete output[name];
    else output[name] = value;
  }
  return output;
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: mergeEnv(process.env, env),
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'unknown'}`));
    });
  });
}

export function parseFeishuImportAuthCheck(output: string): FeishuAuthStatus {
  const firstBrace = output.indexOf('{');
  const lastBrace = output.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return { ok: false, evidence: 'lark-cli auth check 没有返回 JSON' };
  }
  try {
    const parsed = JSON.parse(output.slice(firstBrace, lastBrace + 1)) as {
      ok?: unknown;
      error?: unknown;
      missing?: unknown;
    };
    if (parsed.ok === true) {
      return { ok: true, evidence: 'docs:document:import 授权可用' };
    }
    const missing = Array.isArray(parsed.missing) ? parsed.missing.map(String).join(', ') : '';
    const error = typeof parsed.error === 'string' ? parsed.error : '';
    return {
      ok: false,
      evidence: [
        error ? `error=${error}` : '',
        missing ? `missing=${missing}` : '',
      ].filter(Boolean).join('；') || 'docs:document:import 授权不可用',
    };
  } catch {
    return { ok: false, evidence: 'lark-cli auth check 返回的 JSON 无法解析' };
  }
}

export function buildFeishuImportAuthFailureReport(config: Config, evidence: string): Record<string, unknown> {
  return {
    milestoneRunId: config.runId,
    ok: false,
    mode: 'execute',
    identity: 'user',
    error: `飞书导入授权不可用：${evidence}`,
    diagnostics: {
      nextStep: '请先运行 lark-cli auth login --domain docs,drive --scope docs:document:import，然后重新执行 npm run verify:document-render-milestone1。',
    },
  };
}

async function writeFeishuImportAuthFailureReport(config: Config, evidence: string): Promise<void> {
  await mkdir(dirname(config.feishuReportPath), { recursive: true });
  await writeFile(
    config.feishuReportPath,
    `${JSON.stringify({ ...buildFeishuImportAuthFailureReport(config, evidence), reportFile: config.feishuReportPath }, null, 2)}\n`,
  );
}

function readAuthCheckFailure(error: unknown): FeishuAuthStatus {
  const commandError = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const rawOutput = [
    typeof commandError.stdout === 'string' ? commandError.stdout : '',
    typeof commandError.stderr === 'string' ? commandError.stderr : '',
    typeof commandError.message === 'string' ? commandError.message : '',
  ].filter(Boolean).join('\n');
  const parsed = parseFeishuImportAuthCheck(rawOutput);
  if (parsed.ok || parsed.evidence !== 'lark-cli auth check 没有返回 JSON') {
    return parsed;
  }
  return {
    ok: false,
    evidence: rawOutput.slice(0, 500) || 'lark-cli auth check 执行失败',
  };
}

async function assertFeishuImportAuthReady(config: Config): Promise<void> {
  let status: FeishuAuthStatus;
  try {
    const { stdout, stderr } = await execFileAsync('lark-cli', ['auth', 'check', '--scope', 'docs:document:import'], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    status = parseFeishuImportAuthCheck([stdout, stderr].filter(Boolean).join('\n'));
  } catch (error) {
    status = readAuthCheckFailure(error);
  }
  if (!status.ok) {
    await writeFeishuImportAuthFailureReport(config, status.evidence);
    throw new Error(`飞书导入授权不可用：${status.evidence}。请先运行 lark-cli auth login --domain docs,drive --scope docs:document:import`);
  }
}

export async function runPreflightTasks(tasks: PreflightTask[]): Promise<void> {
  const errors: string[] = [];
  for (const task of tasks) {
    try {
      await task.run();
    } catch (error) {
      errors.push(`${task.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`里程碑外部前置条件未通过：${errors.join('；')}`);
  }
}

async function runCommandAllowFailure(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await runCommand(command, args, env);
  } catch {
    // The audit command intentionally exits non-zero until every milestone gate passes.
  }
}

async function assertPortFree(port: number): Promise<void> {
  const { stdout } = await execFileAsync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).catch((error) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
      return { stdout: '' };
    }
    throw error;
  });
  if (stdout.trim()) {
    throw new Error(`端口 ${port} 已被占用，请先停止现有服务或设置 DOCUMENT_RENDER_MILESTONE1_PORT。`);
  }
}

function startApi(config: Config, baseEnv: NodeJS.ProcessEnv = process.env): ChildProcess {
  return spawn('npm', ['start'], {
    env: mergeEnv(baseEnv, {
      PORT: String(config.port),
      DOCUMENT_RENDER_PUBLIC_BASE_URL: config.baseUrl,
      DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS: 'true',
    }),
    stdio: 'inherit',
  });
}

async function stopApi(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function waitForProjectTitle(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      const html = await response.text();
      if (html.includes(TITLE)) return;
      lastError = '页面标题不匹配';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`服务启动后页面验证失败：${lastError || '超时'}`);
}

export function milestoneEnv(config: Config, options: MilestoneEnvOptions = {}): NodeJS.ProcessEnv {
  const provider = (process.env.DOCUMENT_RENDER_STORAGE_PROVIDER || process.env.DOCUMENT_RENDER_OBJECT_STORAGE_PROVIDER || '').trim().toLowerCase();
  const env: NodeJS.ProcessEnv = {
    DOCUMENT_RENDER_OSS_REPORT_PATH: config.ossReportPath,
    DOCUMENT_RENDER_SECRET_REPORT_PATH: config.secretReportPath,
    DOCUMENT_RENDER_VERIFY_BASE_URL: config.baseUrl,
    DOCUMENT_RENDER_VERIFY_EXPECT_STORAGE: options.expectedStorage || (provider === 'tos' ? 'tos' : 'oss'),
    DOCUMENT_RENDER_VERIFY_OUTPUT_PATH: config.outputPath,
    DOCUMENT_RENDER_VERIFY_REPORT_PATH: config.verifyReportPath,
    DOCUMENT_RENDER_CLIENT_REPORT_PATH: config.clientReportPath,
    DOCUMENT_RENDER_FEISHU_IMPORT_REPORT_PATH: config.feishuReportPath,
    DOCUMENT_RENDER_AUDIT_REPORT_PATH: config.auditReportPath,
    DOCUMENT_RENDER_MILESTONE1_RUN_ID: config.runId,
  };
  if (options.feishuExecute) {
    env.DOCUMENT_RENDER_FEISHU_IMPORT_EXECUTE = 'true';
  }
  return env;
}

export function withoutOssStorageEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { ...env };
  for (const name of [
    ...OSS_STORAGE_ENV_NAMES,
    ...UNSUPPORTED_OBJECT_STORAGE_ENV_NAMES,
    'DOCUMENT_RENDER_STORAGE_PROVIDER',
    'DOCUMENT_RENDER_OBJECT_STORAGE_PROVIDER',
  ]) {
    output[name] = undefined;
  }
  return output;
}

export function withoutDocumentRenderRuntimeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { ...env };
  for (const name of DOCUMENT_RENDER_RUNTIME_ENV_NAMES) {
    output[name] = undefined;
  }
  return output;
}

export async function cleanupMilestoneReports(config: Config): Promise<void> {
  await Promise.all([
    config.verifyReportPath,
    config.ossReportPath,
    config.secretReportPath,
    config.clientReportPath,
    config.feishuReportPath,
    config.auditReportPath,
  ].map((reportPath) => rm(reportPath, { force: true })));
}

async function runAudit(config: Config): Promise<void> {
  await runCommandAllowFailure('npm', ['run', 'audit:document-render-milestone1'], milestoneEnv(config));
}

async function runSecretScan(config: Config): Promise<void> {
  await runCommand('npm', ['run', 'verify:secrets'], milestoneEnv(config));
}

async function runExternalPreflights(config: Config): Promise<void> {
  await runPreflightTasks([
    {
      name: 'OSS 预检',
      run: () => runCommand('npm', ['run', 'verify:oss'], milestoneEnv(config)),
    },
    {
      name: '飞书导入授权',
      run: () => assertFeishuImportAuthReady(config),
    },
  ]);
}

async function runBuildAndTests(config: Config, options: MilestoneEnvOptions = {}): Promise<void> {
  await runCommand('npm', ['run', 'build'], milestoneEnv(config, options));
  await runCommand('npm', ['test'], withoutDocumentRenderRuntimeEnv({
    ...milestoneEnv(config, options),
    DOCUMENT_RENDER_SKIP_PROJECT_ENV: 'true',
  }));
}

async function runApiAndClientEvidence(
  config: Config,
  options: MilestoneEnvOptions & { apiEnv?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  let api: ChildProcess | null = null;
  try {
    api = startApi(config, options.apiEnv);
    await waitForProjectTitle(config.baseUrl);
    await runCommand('npm', ['run', 'verify:document-render'], milestoneEnv(config, options));
    await runCommandAllowFailure('npm', ['run', 'verify:docx-client', '--', config.outputPath], milestoneEnv(config, options));
    await runCommandAllowFailure(
      'npm',
      ['run', 'verify:feishu-import', '--', config.outputPath],
      milestoneEnv(config, { ...options, feishuExecute: true }),
    );
  } finally {
    await stopApi(api);
  }
}

async function runPreflightFailureEvidence(config: Config): Promise<void> {
  await runBuildAndTests(config, { expectedStorage: 'local' });
  await runApiAndClientEvidence(config, {
    expectedStorage: 'local',
    apiEnv: withoutDocumentRenderRuntimeEnv({
      ...process.env,
      DOCUMENT_RENDER_SKIP_PROJECT_ENV: 'true',
    }),
  });
}

async function main(): Promise<void> {
  const config = getConfig();
  let externalPreflightsPassed = false;
  try {
    await cleanupMilestoneReports(config);
    await runSecretScan(config);
    await assertPortFree(config.port);
    await runExternalPreflights(config);
    externalPreflightsPassed = true;
    await runBuildAndTests(config);
    await runApiAndClientEvidence(config);
    await runCommand('npm', ['run', 'audit:document-render-milestone1'], milestoneEnv(config));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (!externalPreflightsPassed) {
      try {
        await runPreflightFailureEvidence(config);
      } catch (evidenceError) {
        console.error(JSON.stringify({
          ok: false,
          stage: 'preflight-failure-evidence',
          error: evidenceError instanceof Error ? evidenceError.message : String(evidenceError),
        }));
      }
    }
    await runAudit(config);
    process.exitCode = 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}
