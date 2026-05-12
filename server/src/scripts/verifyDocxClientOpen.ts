import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_WPS_APP = '/Applications/wpsoffice.app';
const DEFAULT_WORD_APP = '/Applications/Microsoft Word.app';
const DEFAULT_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 500;
const ERROR_PATTERNS = [
  '无法打开',
  '打不开',
  '文件损坏',
  '已损坏',
  '格式不支持',
  '不支持此文件',
  'corrupt',
  'damaged',
  'cannot open',
  'unsupported',
];

type ClientId = 'word' | 'wps';
type ClientApp = {
  id: ClientId;
  appPath: string;
  processName: string;
  displayName: string;
};
type ClientSnapshot = {
  windowNames: string[];
  texts: string[];
};
type ClientReport = {
  ok: boolean;
  milestoneRunId?: string;
  app: string;
  file?: string;
  windowTitle?: string;
  checks?: string[];
  error?: string;
  reportFile?: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function getFilePath(): string {
  const rawPath = process.argv[2] || process.env.DOCUMENT_RENDER_CLIENT_FILE || '';
  if (!rawPath.trim()) {
    fail('请传入要验证的 Docx 文件路径，或设置 DOCUMENT_RENDER_CLIENT_FILE。');
  }
  return resolve(rawPath);
}

function getTimeoutMs(): number {
  const rawValue = process.env.DOCUMENT_RENDER_CLIENT_TIMEOUT_MS || '';
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TIMEOUT_MS;
}

async function runAppleScript(lines: string[]): Promise<string> {
  const args = lines.flatMap((line) => ['-e', line]);
  const { stdout } = await execFileAsync('/usr/bin/osascript', args, {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveClientApp(): Promise<ClientApp> {
  const requestedApp = (process.env.DOCUMENT_RENDER_CLIENT_APP || 'auto').trim().toLowerCase();
  const wordAppPath = process.env.DOCUMENT_RENDER_CLIENT_WORD_APP || DEFAULT_WORD_APP;
  const wpsAppPath = process.env.DOCUMENT_RENDER_CLIENT_WPS_APP || DEFAULT_WPS_APP;
  const candidates: ClientApp[] = [
    { id: 'word', appPath: wordAppPath, processName: 'Microsoft Word', displayName: 'Word' },
    { id: 'wps', appPath: wpsAppPath, processName: 'WPS Office', displayName: 'WPS' },
  ];
  const allowedCandidates = requestedApp === 'word' || requestedApp === 'wps'
    ? candidates.filter((candidate) => candidate.id === requestedApp)
    : candidates;
  for (const candidate of allowedCandidates) {
    if (await pathExists(candidate.appPath)) {
      return candidate;
    }
  }
  fail(
    requestedApp === 'word' || requestedApp === 'wps'
      ? `未找到指定客户端：${requestedApp}。`
      : '未找到可用的 Word 或 WPS 客户端。',
  );
}

async function openWithClient(filePath: string, client: ClientApp): Promise<void> {
  await access(filePath);
  await access(client.appPath);
  await execFileAsync('/usr/bin/open', ['-a', client.appPath, filePath], {
    encoding: 'utf8',
    timeout: 10000,
  });
}

async function getClientSnapshot(client: ClientApp): Promise<ClientSnapshot> {
  const output = await runAppleScript([
    'tell application "System Events"',
    `if not (exists process "${client.processName}") then return "__NO_PROCESS__"`,
    `tell process "${client.processName}"`,
    'set joinedWindows to ""',
    'set joinedTexts to ""',
    'repeat with currentWindow in windows',
    'try',
    'set joinedWindows to joinedWindows & (name of currentWindow as text) & linefeed',
    'repeat with currentText in static texts of currentWindow',
    'try',
    'set joinedTexts to joinedTexts & (value of currentText as text) & linefeed',
    'end try',
    'end repeat',
    'end try',
    'end repeat',
    'return joinedWindows & "__DOCX_CLIENT_TEXTS__" & joinedTexts',
    'end tell',
    'end tell',
  ]);

  if (output === '__NO_PROCESS__') {
    return { windowNames: [], texts: [] };
  }

  const [rawWindows = '', rawTexts = ''] = output.split('__DOCX_CLIENT_TEXTS__');
  return {
    windowNames: rawWindows.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    texts: rawTexts.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
  };
}

function assertNoClientError(client: ClientApp, snapshot: ClientSnapshot): void {
  const combinedText = snapshot.windowNames.concat(snapshot.texts).join('\n').toLowerCase();
  const matchedPattern = ERROR_PATTERNS.find((pattern) => combinedText.includes(pattern.toLowerCase()));
  if (matchedPattern) {
    fail(`${client.displayName} 打开文件时出现异常提示：${matchedPattern}`);
  }
}

async function waitForOpenedFile(client: ClientApp, fileName: string, timeoutMs: number): Promise<ClientSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: ClientSnapshot = { windowNames: [], texts: [] };
  while (Date.now() <= deadline) {
    lastSnapshot = await getClientSnapshot(client);
    assertNoClientError(client, lastSnapshot);
    if (lastSnapshot.windowNames.some((name) => name.includes(fileName))) {
      return lastSnapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  fail(`${client.displayName} 未在 ${timeoutMs}ms 内打开目标文件。当前窗口：${lastSnapshot.windowNames.join(', ') || '无'}`);
}

async function writeReport(reportPath: string, report: ClientReport): Promise<ClientReport> {
  const milestoneRunId = (process.env.DOCUMENT_RENDER_MILESTONE1_RUN_ID || '').trim();
  const withRunId = milestoneRunId ? { milestoneRunId, ...report } : report;
  if (!reportPath) return withRunId;
  await mkdir(dirname(reportPath), { recursive: true });
  const output = { ...withRunId, reportFile: reportPath };
  await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

async function main(): Promise<void> {
  const filePath = getFilePath();
  const fileName = basename(filePath);
  const client = await resolveClientApp();
  await openWithClient(filePath, client);
  const snapshot = await waitForOpenedFile(client, fileName, getTimeoutMs());
  const report = await writeReport(process.env.DOCUMENT_RENDER_CLIENT_REPORT_PATH || '', {
    ok: true,
    app: client.id,
    file: filePath,
    windowTitle: snapshot.windowNames.find((name) => name.includes(fileName)) || fileName,
    checks: [`${client.id}-process-visible`, 'docx-window-visible', 'no-client-error-dialog'],
  });
  console.log(JSON.stringify(report));
}

main().catch((error) => {
  const reportPath = process.env.DOCUMENT_RENDER_CLIENT_REPORT_PATH || '';
  const rawPath = process.argv[2] || process.env.DOCUMENT_RENDER_CLIENT_FILE || '';
  writeReport(reportPath, {
    ok: false,
    app: (process.env.DOCUMENT_RENDER_CLIENT_APP || 'auto').trim().toLowerCase() || 'auto',
    file: rawPath.trim() ? resolve(rawPath) : undefined,
    error: error instanceof Error ? error.message : String(error),
  }).then((report) => {
    console.error(JSON.stringify(report));
    process.exit(1);
  }).catch((writeError) => {
    console.error(JSON.stringify({
      ok: false,
      app: 'wps',
      error: writeError instanceof Error ? writeError.message : String(writeError),
    }));
    process.exit(1);
  });
});
