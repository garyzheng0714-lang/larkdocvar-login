import '../env';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type GateStatus = 'pass' | 'fail';
type Gate = {
  name: string;
  status: GateStatus;
  evidence: string;
};
type Blocker = {
  name: string;
  evidence: string;
};
type Requirement = Gate & {
  category: string;
  artifact: string;
};

type VerifyReport = {
  ok?: boolean;
  milestoneRunId?: string;
  storage?: string;
  generatedFile?: string;
  checks?: string[];
  stability?: {
    sequential?: { total?: number; ok?: number; p95Ms?: number };
    concurrent?: { total?: number; ok?: number; p95Ms?: number };
  };
};
type ClientReport = { ok?: boolean; milestoneRunId?: string; file?: string; checks?: string[] };
type SecretReport = {
  ok?: boolean;
  milestoneRunId?: string;
  checkedKeys?: string[];
  matches?: Array<{ key?: string; files?: string[] }>;
};
type FeishuImportReport = {
  ok?: boolean;
  milestoneRunId?: string;
  mode?: string;
  file?: string;
  checks?: string[];
  error?: string;
  diagnostics?: { nextStep?: string };
};
type ErrorSummary = { code?: string; message?: string };
type OssReport = {
  ok?: boolean;
  milestoneRunId?: string;
  bucketEnv?: string;
  region?: string;
  checks?: string[];
  error?: ErrorSummary;
  diagnostics?: {
    hint?: string;
    config?: {
      accessKeyIdEnv?: string;
      accessKeySecretEnv?: string;
      bucketEnv?: string;
      regionEnv?: string;
      normalizedRegion?: string;
      prefix?: string;
    };
    visibleBucketsError?: ErrorSummary;
  };
};
type RunIdReport = { milestoneRunId?: string } | null;

const DEFAULT_REPORT_PATH = '/tmp/larkdocvar-document-render-latest-report.json';
const DEFAULT_CLIENT_REPORT_PATH = '/tmp/larkdocvar-docx-client-latest-report.json';
const DEFAULT_FEISHU_IMPORT_REPORT_PATH = '/tmp/larkdocvar-feishu-import-latest-report.json';
const DEFAULT_OSS_REPORT_PATH = '/tmp/larkdocvar-oss-latest-report.json';
const DEFAULT_SECRET_REPORT_PATH = '/tmp/larkdocvar-secrets-latest-report.json';
const DEFAULT_AUDIT_REPORT_PATH = '/tmp/larkdocvar-milestone1-audit-latest-report.json';
const OSS_ENV_GROUPS = [
  {
    canonical: 'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID',
    names: ['DOCUMENT_RENDER_OSS_ACCESS_KEY_ID', 'ALIYUN_OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_ID'],
  },
  {
    canonical: 'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET',
    names: ['DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET', 'ALIYUN_OSS_ACCESS_KEY_SECRET', 'OSS_ACCESS_KEY_SECRET'],
  },
  {
    canonical: 'DOCUMENT_RENDER_OSS_BUCKET',
    names: ['DOCUMENT_RENDER_OSS_BUCKET', 'ALIYUN_OSS_BUCKET', 'OSS_BUCKET'],
  },
  {
    canonical: 'DOCUMENT_RENDER_OSS_REGION',
    names: ['DOCUMENT_RENDER_OSS_REGION', 'ALIYUN_OSS_REGION', 'OSS_REGION', 'OSS_REGION_ID'],
  },
];
const TOS_ENV_GROUPS = [
  {
    canonical: 'TOS_ACCESS_KEY',
    names: ['TOS_ACCESS_KEY', 'TOS_ACCESS_KEY_ID'],
  },
  {
    canonical: 'TOS_SECRET_KEY',
    names: ['TOS_SECRET_KEY', 'TOS_SECRET_ACCESS_KEY'],
  },
  {
    canonical: 'TOS_BUCKET',
    names: ['TOS_BUCKET'],
  },
  {
    canonical: 'TOS_REGION',
    names: ['TOS_REGION'],
  },
];
export const REQUIRED_CHECKS = [
  'frontend-title-ok',
  'response-contract-ok',
  'download-contract-ok',
  'download-ttl-ok',
  'download-storage-ok',
  'download-ok',
  'docx-opened-as-zip',
  'docx-opened-by-textutil',
  'variables-replaced',
  'no-placeholders',
  'style-kept',
  'missing-variables-ok',
  'unused-variables-ok',
  'error-contract-ok',
  'stability-ok',
  'document-render-contract-tests-present',
  'document-render-security-tests-present',
  'browser-origin-guard-tests-present',
  'browser-origin-guard-mounted-present',
  'document-render-20-template-regression-present',
  'document-render-template-library-manifest-present',
  'document-render-size-tests-present',
  'document-render-error-tests-present',
  'document-render-download-ttl-tests-present',
  'document-render-storage-mode-tests-present',
  'document-render-oss-config-alias-tests-present',
  'document-render-oss-storage-tests-present',
  'document-render-tos-storage-tests-present',
  'document-render-docx-scope-tests-present',
  'document-render-no-half-finished-tests-present',
  'document-render-boundary-tests-present',
  'document-render-zip-safety-tests-present',
  'readme-curl-example-present',
  'readme-success-response-present',
  'readme-stable-fields-present',
  'readme-missing-variable-example-present',
  'readme-unused-variable-example-present',
  'readme-damaged-template-example-present',
  'readme-residual-placeholder-example-present',
  'readme-oss-missing-example-present',
  'readme-oss-troubleshooting-present',
  'readme-oss-permission-checklist-present',
];
export const REQUIRED_FEISHU_EXECUTE_CHECKS = [
  'import-command-finished',
  'import-ticket-present',
  'import-result-present',
];
export const REQUIRED_OSS_CHECKS = [
  'put-ok',
  'signature-url-ok',
  'download-ok',
  'delete-ok',
];

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readReport(path: string): Promise<VerifyReport | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as VerifyReport;
  } catch {
    return null;
  }
}

async function readClientReport(path: string): Promise<ClientReport | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ClientReport;
  } catch {
    return null;
  }
}

async function readSecretReport(path: string): Promise<SecretReport | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SecretReport;
  } catch {
    return null;
  }
}

async function readFeishuImportReport(path: string): Promise<FeishuImportReport | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as FeishuImportReport;
  } catch {
    return null;
  }
}

async function readOssReport(path: string): Promise<OssReport | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as OssReport;
  } catch {
    return null;
  }
}

async function writeJsonReport(path: string, report: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

function readConfiguredEnvName(names: string[], env: NodeJS.ProcessEnv = process.env): string {
  return names.find((name) => Boolean((env[name] || '').trim())) || '';
}

function getAuditStorageProvider(env: NodeJS.ProcessEnv = process.env): 'oss' | 'tos' {
  const explicit = (env.DOCUMENT_RENDER_STORAGE_PROVIDER || env.DOCUMENT_RENDER_OBJECT_STORAGE_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'tos') return 'tos';
  if (explicit === 'oss') return 'oss';
  const hasTos = TOS_ENV_GROUPS.every((group) => readConfiguredEnvName(group.names, env));
  const hasOss = OSS_ENV_GROUPS.every((group) => readConfiguredEnvName(group.names, env));
  return hasTos && !hasOss ? 'tos' : 'oss';
}

export function getOssEnvStatus(env: NodeJS.ProcessEnv = process.env): { ok: boolean; evidence: string; missing: string } {
  const groups = getAuditStorageProvider(env) === 'tos' ? TOS_ENV_GROUPS : OSS_ENV_GROUPS;
  const configured = groups.map((group) => ({
    canonical: group.canonical,
    envName: readConfiguredEnvName(group.names, env),
  }));
  const missing = configured.filter((item) => !item.envName).map((item) => item.canonical);
  if (missing.length > 0) {
    return {
      ok: false,
      evidence: '',
      missing: missing.join(', '),
    };
  }
  return {
    ok: true,
    evidence: configured.map((item) => item.envName).join(', '),
    missing: '',
  };
}

function pass(name: string, evidence: string): Gate {
  return { name, status: 'pass', evidence };
}

function fail(name: string, evidence: string): Gate {
  return { name, status: 'fail', evidence };
}

function toBlocker(gate: Gate | undefined): Blocker | null {
  if (!gate || gate.status !== 'fail') return null;
  return { name: gate.name, evidence: gate.evidence };
}

function requirement(
  category: string,
  name: string,
  passed: boolean,
  evidence: string,
  artifact: string,
): Requirement {
  return { category, name, status: passed ? 'pass' : 'fail', evidence, artifact };
}

export function summarizeOssReport(report: OssReport | null, path: string): string {
  if (!report) return `未找到 OSS 报告：${path}`;
  if (report.ok) return path;
  const code = report.error?.code ? `code=${report.error.code}` : '';
  const message = report.error?.message || '';
  const config = report.diagnostics?.config
    ? [
      '配置来源',
      report.diagnostics.config.accessKeyIdEnv ? `accessKeyId=${report.diagnostics.config.accessKeyIdEnv}` : '',
      report.diagnostics.config.bucketEnv ? `bucket=${report.diagnostics.config.bucketEnv}` : '',
      report.diagnostics.config.regionEnv ? `region=${report.diagnostics.config.regionEnv}` : '',
      report.diagnostics.config.normalizedRegion ? `normalizedRegion=${report.diagnostics.config.normalizedRegion}` : '',
    ].filter(Boolean).join('；')
    : '';
  const visibleBucketsError = report.diagnostics?.visibleBucketsError
    ? [
      '可见 bucket 查询失败',
      report.diagnostics.visibleBucketsError.code ? `code=${report.diagnostics.visibleBucketsError.code}` : '',
      report.diagnostics.visibleBucketsError.message || '',
    ].filter(Boolean).join('；')
    : '';
  const hint = report.diagnostics?.hint ? `下一步：${report.diagnostics.hint}` : '';
  return [path, code, message, config, visibleBucketsError, hint].filter(Boolean).join('；');
}

export function summarizeFeishuImportReport(report: FeishuImportReport | null, path: string): string {
  if (!report) return `未找到飞书导入报告：${path}`;
  if (report.ok) return path;
  const nextStep = report.diagnostics?.nextStep ? `下一步：${report.diagnostics.nextStep}` : '';
  return [path, report.mode ? `mode=${report.mode}` : '', report.error || '导入未通过', nextStep].filter(Boolean).join('；');
}

export function summarizeSecretReport(report: SecretReport | null, path: string): string {
  if (!report) return `未找到密钥扫描报告：${path}`;
  const keys = (report.checkedKeys || []).join(', ');
  const matches = (report.matches || [])
    .map((match) => `${match.key || 'unknown'}=${(match.files || []).join(',')}`)
    .join('；');
  if (report.ok) return keys ? `${path}；checked=${keys}` : path;
  return [path, matches || '发现受跟踪文件包含敏感配置值'].filter(Boolean).join('；');
}

export function summarizeRunIdStatus(
  expectedRunId: string,
  reports: Array<{ name: string; report: RunIdReport }>,
): { ok: boolean; evidence: string } {
  const reportRunIds = Array.from(new Set(
    reports.map(({ report }) => report?.milestoneRunId || '').filter(Boolean),
  ));
  const requiredRunId = expectedRunId || (reportRunIds.length === 1 ? reportRunIds[0] : '');
  if (!requiredRunId) {
    return {
      ok: false,
      evidence: reportRunIds.length > 1
        ? `未设置 DOCUMENT_RENDER_MILESTONE1_RUN_ID，且报告 run id 不一致：${reportRunIds.join(', ')}`
        : '未设置 DOCUMENT_RENDER_MILESTONE1_RUN_ID，且报告缺少可推断的同次运行 run id',
    };
  }
  const mismatches = reports
    .filter(({ report }) => report?.milestoneRunId !== requiredRunId)
    .map(({ name, report }) => `${name}=${report?.milestoneRunId || 'missing'}`);
  if (mismatches.length === 0) {
    return { ok: true, evidence: `runId=${requiredRunId}` };
  }
  return {
    ok: false,
    evidence: `expected=${requiredRunId}；${mismatches.join('；')}`,
  };
}

export function selectPrimaryBlockers(
  gates: Gate[],
  context: {
    reportOk: boolean;
    allOssEnv: boolean;
    ossReportReady: boolean;
    storage?: string;
    feishuReportAvailable: boolean;
    feishuImportReportReady: boolean;
    secretReportReady: boolean;
  },
): Blocker[] {
  const gateByName = new Map(gates.map((gate) => [gate.name, gate]));
  const selected: Blocker[] = [];
  const add = (name: string): void => {
    const blocker = toBlocker(gateByName.get(name));
    if (blocker && !selected.some((item) => item.name === blocker.name)) {
      selected.push(blocker);
    }
  };

  if (!context.secretReportReady) add('受跟踪密钥扫描通过');
  if (!context.allOssEnv) add('OSS 环境变量已配置');
  if (!context.ossReportReady) add('真实 OSS 预检通过');
  if (context.reportOk && context.allOssEnv && context.ossReportReady && !['oss', 'tos'].includes(context.storage || '')) {
    add('API 返回 OSS 下载链路');
  }
  if ((context.reportOk || context.feishuReportAvailable) && !context.feishuImportReportReady) {
    add('飞书实际导入验证通过');
  }
  if (selected.length > 0) return selected;
  return gates.filter((gate) => gate.status === 'fail').map(({ name, evidence }) => ({ name, evidence }));
}

async function main(): Promise<void> {
  const reportPath = process.env.DOCUMENT_RENDER_MILESTONE1_REPORT_PATH
    || process.env.DOCUMENT_RENDER_VERIFY_REPORT_PATH
    || DEFAULT_REPORT_PATH;
  const ossReportPath = process.env.DOCUMENT_RENDER_OSS_REPORT_PATH || DEFAULT_OSS_REPORT_PATH;
  const secretReportPath = process.env.DOCUMENT_RENDER_SECRET_REPORT_PATH || DEFAULT_SECRET_REPORT_PATH;
  const clientReportPath = process.env.DOCUMENT_RENDER_CLIENT_REPORT_PATH || DEFAULT_CLIENT_REPORT_PATH;
  const feishuImportReportPath = process.env.DOCUMENT_RENDER_FEISHU_IMPORT_REPORT_PATH || DEFAULT_FEISHU_IMPORT_REPORT_PATH;
  const auditReportPath = process.env.DOCUMENT_RENDER_AUDIT_REPORT_PATH || DEFAULT_AUDIT_REPORT_PATH;
  const report = await readReport(reportPath);
  const ossReport = await readOssReport(ossReportPath);
  const secretReport = await readSecretReport(secretReportPath);
  const clientReport = await readClientReport(clientReportPath);
  const feishuImportReport = await readFeishuImportReport(feishuImportReportPath);
  const checks = new Set(report?.checks || []);
  const ossChecks = new Set(ossReport?.checks || []);
  const clientChecks = new Set(clientReport?.checks || []);
  const feishuImportChecks = new Set(feishuImportReport?.checks || []);
  const sequential = report?.stability?.sequential;
  const concurrent = report?.stability?.concurrent;
  const generatedFile = report?.generatedFile || '';
  const hasChecks = (names: string[]) => names.every((check) => checks.has(check));
  const hasOssChecks = REQUIRED_OSS_CHECKS.every((check) => ossChecks.has(check));
  const hasFeishuExecuteChecks = REQUIRED_FEISHU_EXECUTE_CHECKS.every((check) => feishuImportChecks.has(check));
  const hasClientProcessCheck = clientChecks.has('word-process-visible') || clientChecks.has('wps-process-visible');
  const hasClientChecks = hasClientProcessCheck && ['docx-window-visible', 'no-client-error-dialog'].every((check) => clientChecks.has(check));
  const reportOk = report?.ok === true;
  const generatedFileExists = Boolean(generatedFile) && await pathExists(generatedFile);
  const sequentialOk = Boolean(sequential?.total && sequential.ok === sequential.total && sequential.total >= 500 && Number(sequential.p95Ms) < 5000);
  const concurrentOk = Boolean(concurrent?.total && concurrent.ok === concurrent.total && concurrent.total >= 20 && Number(concurrent.p95Ms) < 5000);
  const ossEnvStatus = getOssEnvStatus();
  const allOssEnv = ossEnvStatus.ok;
  const ossEvidence = summarizeOssReport(ossReport, ossReportPath);
  const secretEvidence = summarizeSecretReport(secretReport, secretReportPath);
  const feishuImportEvidence = summarizeFeishuImportReport(feishuImportReport, feishuImportReportPath);
  const ossReportReady = ossReport?.ok === true && hasOssChecks;
  const secretReportReady = secretReport?.ok === true && (secretReport.matches || []).length === 0;
  const clientReportReady = clientReport?.ok === true && clientReport.file === generatedFile && hasClientChecks;
  const feishuImportReportReady = feishuImportReport?.ok === true
    && feishuImportReport.mode === 'execute'
    && feishuImportReport.file === generatedFile
    && hasFeishuExecuteChecks;
  const runIdStatus = summarizeRunIdStatus(process.env.DOCUMENT_RENDER_MILESTONE1_RUN_ID || '', [
    { name: 'api', report },
    { name: 'oss', report: ossReport },
    { name: 'secrets', report: secretReport },
    { name: 'client', report: clientReport },
    { name: 'feishu', report: feishuImportReport },
  ]);
  const requirements: Requirement[] = [
    requirement('OSS 下载链路', '生成后的 Docx 上传到 OSS', ossReportReady, ossEvidence, 'server/src/scripts/verifyOssStorage.ts'),
    requirement('OSS 下载链路', 'API 返回 OSS 下载链接，不返回本地临时链接', ['oss', 'tos'].includes(report?.storage || ''), `storage=${report?.storage || 'unknown'}`, reportPath),
    requirement('OSS 下载链路', '下载链接有效期可配置，例如 1 小时 / 24 小时', hasChecks(['download-ttl-ok', 'document-render-download-ttl-tests-present', 'document-render-oss-storage-tests-present']), 'download-ttl-ok, documentRenderDownload.test.ts, documentRenderOssStorage.test.ts', 'server/src/scripts/verifyDocumentRenderMilestone1.ts + server/src/documentRenderDownload.test.ts + server/src/documentRenderOssStorage.test.ts'),
    requirement('OSS 下载链路', '本地无 OSS 配置时才降级 local', hasChecks(['document-render-storage-mode-tests-present', 'document-render-oss-config-alias-tests-present']), 'documentRenderApi.test.ts, documentRenderOssConfig.test.ts', 'server/src/documentRenderApi.test.ts + server/src/documentRenderOssConfig.test.ts'),
    requirement('Docx 格式兼容', '支持正文、表格、页眉、页脚里的变量', hasChecks(['document-render-docx-scope-tests-present']), 'document-render-docx-scope-tests-present', 'server/src/documentRenderApi.test.ts'),
    requirement('Docx 格式兼容', '支持变量被 Word 拆成多个文本节点', hasChecks(['document-render-docx-scope-tests-present', 'document-render-boundary-tests-present']), 'document-render-docx-scope-tests-present, document-render-boundary-tests-present', 'server/src/documentRenderApi.test.ts + server/src/documentRenderBoundaries.test.ts'),
    requirement('Docx 格式兼容', '替换后保留基础样式', hasChecks(['style-kept', 'document-render-boundary-tests-present']), 'style-kept, document-render-boundary-tests-present', `${reportPath} + server/src/documentRenderBoundaries.test.ts`),
    requirement('Docx 格式兼容', '至少 20 份不同结构模板回归通过', hasChecks(['document-render-20-template-regression-present', 'document-render-template-library-manifest-present']), 'document-render-20-template-regression-present, document-render-template-library-manifest-present', 'server/src/documentRenderApi.test.ts + docs/docx-regression-template-library.json'),
    requirement('生成质量', '所有已传变量必须被替换', hasChecks(['variables-replaced']), 'variables-replaced', reportPath),
    requirement('生成质量', '未传变量返回 missingVariables，不能生成半成品', hasChecks(['missing-variables-ok', 'document-render-error-tests-present', 'document-render-no-half-finished-tests-present']), 'missing-variables-ok, no-half-finished tests', reportPath),
    requirement('生成质量', '生成文件可被客户端打开且不报错', clientReportReady, clientReportPath, 'server/src/scripts/verifyDocxClientOpen.ts'),
    requirement('生成质量', '生成后文件里不得残留变量占位符', hasChecks(['no-placeholders']), 'no-placeholders', reportPath),
    requirement('稳定性', '单个模板最大支持 20MB', hasChecks(['document-render-size-tests-present']), 'document-render-size-tests-present', 'server/src/documentRenderSize.test.ts'),
    requirement('稳定性', '单次生成 p95 响应时间小于 5 秒', sequentialOk && concurrentOk, `sequential=${sequential?.p95Ms ?? 'unknown'}ms concurrent=${concurrent?.p95Ms ?? 'unknown'}ms`, reportPath),
    requirement('稳定性', '连续生成 500 次无崩溃', sequentialOk, JSON.stringify(sequential || null), reportPath),
    requirement('稳定性', '并发 20 个请求成功率 99% 以上', concurrentOk, JSON.stringify(concurrent || null), reportPath),
    requirement('安全', '默认禁止内网、本机、云元数据地址作为模板链接', hasChecks(['document-render-security-tests-present']), 'document-render-security-tests-present', 'server/src/documentRenderSecurity.test.ts'),
    requirement('安全', '禁止非 HTTPS 模板链接，除非本地实验显式开启', hasChecks(['document-render-security-tests-present']), 'document-render-security-tests-present', 'server/src/documentRenderSecurity.test.ts'),
    requirement('安全', '防 zip bomb、坏 Docx、伪装 Docx', hasChecks(['document-render-zip-safety-tests-present']), 'document-render-zip-safety-tests-present', 'server/src/documentRenderApi.test.ts'),
    requirement('安全', '浏览器跨站生成请求会被来源校验拦截，同时保留服务端 API 接入', hasChecks(['browser-origin-guard-tests-present', 'browser-origin-guard-mounted-present']), 'browser-origin-guard-tests-present, browser-origin-guard-mounted-present', 'server/src/browserOriginGuard.test.ts + server/src/index.ts'),
    requirement('安全', '错误信息只给用户可理解原因，不暴露内部堆栈', hasChecks(['document-render-error-tests-present']), 'document-render-error-tests-present', 'server/src/documentRenderErrors.test.ts'),
    requirement('安全', 'OSS 密钥不进入受版本管理文件', secretReportReady, secretEvidence, 'server/src/scripts/verifyNoTrackedSecrets.ts'),
    requirement('API 易接入', 'README 有可复制 curl 示例', hasChecks(['readme-curl-example-present']), 'readme-curl-example-present', 'README.md'),
    requirement('API 易接入', 'README 有成功、缺失变量、模板损坏、OSS 配置缺失等示例', hasChecks(['readme-success-response-present', 'readme-missing-variable-example-present', 'readme-damaged-template-example-present', 'readme-oss-missing-example-present', 'readme-oss-troubleshooting-present']), 'README response examples and OSS troubleshooting', 'README.md'),
    requirement('API 易接入', '返回字段稳定：ok、document、variables、download、requestId', hasChecks(['response-contract-ok', 'download-contract-ok', 'readme-stable-fields-present']), 'response/download/readme contract checks', reportPath),
    requirement('外部打开', '飞书文档实际导入不报错', feishuImportReportReady, feishuImportEvidence, 'server/src/scripts/verifyFeishuDocxImport.ts'),
    requirement('完成门禁', 'OSS/密钥扫描/API/客户端/飞书报告必须来自同一次完整验证', runIdStatus.ok, runIdStatus.evidence, 'server/src/scripts/verifyDocumentRenderMilestone1Full.ts'),
  ];
  const gates: Gate[] = [
    reportOk
      ? pass('本地/接口验收报告存在', reportPath)
      : fail('本地/接口验收报告存在', `未找到可用报告：${reportPath}`),
    REQUIRED_CHECKS.every((check) => checks.has(check))
      ? pass('替换质量检查完整', REQUIRED_CHECKS.join(', '))
      : fail('替换质量检查完整', `缺少：${REQUIRED_CHECKS.filter((check) => !checks.has(check)).join(', ')}`),
    sequentialOk
      ? pass('连续 500 次生成稳定性', `total=${sequential?.total}, p95=${sequential?.p95Ms}ms`)
      : fail('连续 500 次生成稳定性', JSON.stringify(sequential || null)),
    concurrentOk
      ? pass('并发 20 次生成稳定性', `total=${concurrent?.total}, p95=${concurrent?.p95Ms}ms`)
      : fail('并发 20 次生成稳定性', JSON.stringify(concurrent || null)),
    generatedFileExists
      ? pass('生成样例文件存在', generatedFile)
      : fail('生成样例文件存在', generatedFile || '报告中没有 generatedFile'),
    clientReportReady
      ? pass('客户端打开验证通过', clientReportPath)
      : fail('客户端打开验证通过', `未找到匹配的客户端报告：${clientReportPath}`),
    allOssEnv
      ? pass('OSS 环境变量已配置', ossEnvStatus.evidence)
      : fail('OSS 环境变量已配置', `缺少：${ossEnvStatus.missing}`),
    ossReportReady
      ? pass('真实 OSS 预检通过', ossReportPath)
      : fail('真实 OSS 预检通过', `需要包含 put/signature/download/delete 的通过报告：${ossEvidence}`),
    secretReportReady
      ? pass('受跟踪密钥扫描通过', secretEvidence)
      : fail('受跟踪密钥扫描通过', secretEvidence),
    ['oss', 'tos'].includes(report?.storage || '')
      ? pass('API 返回 OSS 下载链路', `storage=${report?.storage || 'unknown'}`)
      : fail('API 返回 OSS 下载链路', `storage=${report?.storage || 'unknown'}`),
    feishuImportReportReady
      ? pass('飞书实际导入验证通过', feishuImportReportPath)
      : fail('飞书实际导入验证通过', `需要 execute 报告且文件匹配：${feishuImportEvidence}`),
    runIdStatus.ok
      ? pass('同次运行报告一致', runIdStatus.evidence)
      : fail('同次运行报告一致', runIdStatus.evidence),
  ];
  const ok = gates.every((gate) => gate.status === 'pass');
  const blockers = gates
    .filter((gate) => gate.status === 'fail')
    .map(({ name, evidence }) => ({ name, evidence }));
  const primaryBlockers = selectPrimaryBlockers(gates, {
    reportOk,
    allOssEnv,
    ossReportReady,
    storage: report?.storage,
    feishuReportAvailable: Boolean(feishuImportReport),
    feishuImportReportReady,
    secretReportReady,
  });
  const auditReport = {
    ok,
    objective: '里程碑 1：Docx API 可生产使用',
    reportPath,
    ossReportPath,
    secretReportPath,
    clientReportPath,
    feishuImportReportPath,
    auditReportPath,
    primaryBlockers,
    blockers,
    gates,
    requirements,
  };
  await writeJsonReport(auditReportPath, auditReport);
  console.log(JSON.stringify(auditReport, null, 2));
  if (!ok) process.exit(1);
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
