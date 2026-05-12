import OSS from 'ali-oss';
import '../env';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createTosPresignedGetUrl,
  deleteTosObject,
  normalizeTosEndpoint,
  normalizeTosPrefix,
  putTosObject,
  type TosStorageConfig,
} from '../documentRenderTosStorage';

const TEST_CONTENT = Buffer.from(`larkdocvar oss verify ${new Date().toISOString()}`);
const COMMON_OSS_REGIONS = [
  'oss-cn-beijing',
  'oss-cn-hangzhou',
  'oss-cn-shanghai',
  'oss-cn-shenzhen',
  'oss-cn-heyuan',
  'oss-cn-guangzhou',
  'oss-cn-chengdu',
  'oss-cn-qingdao',
  'oss-cn-zhangjiakou',
  'oss-cn-huhehaote',
  'oss-cn-wulanchabu',
  'oss-cn-hongkong',
  'oss-ap-southeast-1',
  'oss-ap-southeast-5',
  'oss-us-west-1',
  'oss-us-east-1',
];

type OssConfig = {
  provider: 'oss';
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  prefix: string;
  envNames: {
    accessKeyId: string;
    accessKeySecret: string;
    bucket: string;
    region: string;
  };
};
type TosVerifyConfig = TosStorageConfig & {
  provider: 'tos';
  envNames: {
    accessKeyId: string;
    accessKeySecret: string;
    bucket: string;
    region: string;
    endpoint: string;
  };
};

type ErrorSummary = {
  name?: string;
  code?: string;
  status?: number;
  message?: string;
  requestId?: string;
};

type VisibleBucketsSummary = {
  count: number;
  regions: string[];
  truncated: boolean;
};
type BucketEndpointProbe = {
  status?: number;
  code?: string;
  outcome: 'bucket-not-found-in-configured-region' | 'bucket-endpoint-reachable' | 'unknown';
  error?: ErrorSummary;
};
type BucketRegionProbeSummary = {
  checkedRegions: string[];
  reachableRegions: string[];
  notFoundCount: number;
  inconclusiveRegions: string[];
  outcome: 'bucket-endpoint-reachable-in-checked-regions' | 'bucket-not-found-in-checked-regions' | 'inconclusive';
};
type OssReport = {
  ok: boolean;
  milestoneRunId?: string;
  provider?: 'oss' | 'tos';
  bucketEnv?: string;
  region?: string;
  objectName?: string;
  downloadStatus?: number;
  bytes?: number;
  checks?: string[];
  error?: ErrorSummary;
  diagnostics?: Record<string, unknown>;
  reportFile?: string;
};

function readFirstEnv(names: string[]): { name: string; value: string } {
  for (const name of names) {
    const value = (process.env[name] || '').trim();
    if (value) return { name, value };
  }
  return { name: '', value: '' };
}

function normalizeOssRegion(region: string): string {
  return region.startsWith('oss-') ? region : `oss-${region}`;
}

function normalizeOssPrefix(prefix: string): string {
  const cleaned = prefix.split(/[\\/]+/).map((item) => item.trim()).filter((item) => item && item !== '.' && item !== '..').join('/');
  return cleaned ? `${cleaned}/` : '';
}

function getConfiguredProvider(): 'oss' | 'tos' {
  const explicit = (process.env.DOCUMENT_RENDER_STORAGE_PROVIDER || process.env.DOCUMENT_RENDER_OBJECT_STORAGE_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'tos') return 'tos';
  if (explicit === 'oss') return 'oss';
  const tosValues = [
    readFirstEnv(['TOS_ACCESS_KEY', 'TOS_ACCESS_KEY_ID']).value,
    readFirstEnv(['TOS_SECRET_KEY', 'TOS_SECRET_ACCESS_KEY']).value,
    readFirstEnv(['TOS_BUCKET']).value,
    readFirstEnv(['TOS_REGION']).value,
  ];
  const ossValues = [
    readFirstEnv(['DOCUMENT_RENDER_OSS_ACCESS_KEY_ID', 'ALIYUN_OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_ID']).value,
    readFirstEnv(['DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET', 'ALIYUN_OSS_ACCESS_KEY_SECRET', 'OSS_ACCESS_KEY_SECRET']).value,
    readFirstEnv(['DOCUMENT_RENDER_OSS_BUCKET', 'ALIYUN_OSS_BUCKET', 'OSS_BUCKET']).value,
    readFirstEnv(['DOCUMENT_RENDER_OSS_REGION', 'ALIYUN_OSS_REGION', 'OSS_REGION', 'OSS_REGION_ID']).value,
  ];
  return tosValues.every(Boolean) && !ossValues.every(Boolean) ? 'tos' : 'oss';
}

function getOssConfig(): OssConfig {
  const accessKeyId = readFirstEnv([
    'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID',
    'ALIYUN_OSS_ACCESS_KEY_ID',
    'OSS_ACCESS_KEY_ID',
  ]);
  const accessKeySecret = readFirstEnv([
    'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET',
    'ALIYUN_OSS_ACCESS_KEY_SECRET',
    'OSS_ACCESS_KEY_SECRET',
  ]);
  const bucket = readFirstEnv([
    'DOCUMENT_RENDER_OSS_BUCKET',
    'ALIYUN_OSS_BUCKET',
    'OSS_BUCKET',
  ]);
  const rawRegion = readFirstEnv([
    'DOCUMENT_RENDER_OSS_REGION',
    'ALIYUN_OSS_REGION',
    'OSS_REGION',
    'OSS_REGION_ID',
  ]);
  const missing = [
    ['DOCUMENT_RENDER_OSS_ACCESS_KEY_ID', accessKeyId.value],
    ['DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET', accessKeySecret.value],
    ['DOCUMENT_RENDER_OSS_BUCKET', bucket.value],
    ['DOCUMENT_RENDER_OSS_REGION', rawRegion.value],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`OSS 配置不完整，缺少：${missing.join(', ')}`);
  }

  return {
    provider: 'oss',
    accessKeyId: accessKeyId.value,
    accessKeySecret: accessKeySecret.value,
    bucket: bucket.value,
    region: normalizeOssRegion(rawRegion.value),
    prefix: normalizeOssPrefix(process.env.DOCUMENT_RENDER_OSS_PREFIX || 'document-renders'),
    envNames: {
      accessKeyId: accessKeyId.name,
      accessKeySecret: accessKeySecret.name,
      bucket: bucket.name,
      region: rawRegion.name,
    },
  };
}

function getTosConfig(): TosVerifyConfig {
  const accessKeyId = readFirstEnv(['TOS_ACCESS_KEY', 'TOS_ACCESS_KEY_ID']);
  const accessKeySecret = readFirstEnv(['TOS_SECRET_KEY', 'TOS_SECRET_ACCESS_KEY']);
  const bucket = readFirstEnv(['TOS_BUCKET']);
  const region = readFirstEnv(['TOS_REGION']);
  const endpoint = readFirstEnv(['TOS_ENDPOINT']);
  const missing = [
    ['TOS_ACCESS_KEY', accessKeyId.value],
    ['TOS_SECRET_KEY', accessKeySecret.value],
    ['TOS_BUCKET', bucket.value],
    ['TOS_REGION', region.value],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`TOS 配置不完整，缺少：${missing.join(', ')}`);
  }

  return {
    provider: 'tos',
    accessKeyId: accessKeyId.value,
    accessKeySecret: accessKeySecret.value,
    bucket: bucket.value,
    region: region.value,
    endpoint: normalizeTosEndpoint(region.value, endpoint.value),
    prefix: normalizeTosPrefix(process.env.DOCUMENT_RENDER_TOS_PREFIX || process.env.DOCUMENT_RENDER_OSS_PREFIX || 'document-renders'),
    envNames: {
      accessKeyId: accessKeyId.name,
      accessKeySecret: accessKeySecret.name,
      bucket: bucket.name,
      region: region.name,
      endpoint: endpoint.name,
    },
  };
}

function toErrorSummary(error: unknown): ErrorSummary {
  if (!error || typeof error !== 'object') {
    return { message: String(error) };
  }
  const item = error as {
    name?: string;
    code?: string;
    status?: number;
    message?: string;
    requestId?: string;
    tos?: ErrorSummary;
  };
  if (item.tos) {
    return item.tos;
  }
  return {
    name: item.name,
    code: item.code,
    status: item.status,
    message: item.message,
    requestId: item.requestId,
  };
}

function getHint(error: ErrorSummary): string {
  if (error.message?.startsWith('OSS 配置不完整')) {
    return '请在 .env.local 或运行环境中配置 DOCUMENT_RENDER_OSS_ACCESS_KEY_ID、DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET、DOCUMENT_RENDER_OSS_BUCKET、DOCUMENT_RENDER_OSS_REGION，再重新运行 npm run verify:oss。';
  }
  if (error.code === 'NoSuchBucket') {
    return 'Bucket 不存在，或 bucket 名称和 region 不匹配。请在阿里云 OSS 控制台确认 Bucket 与地域。';
  }
  if (error.code === 'InvalidAccessKeyId') {
    return 'AccessKey 不存在、已禁用，或不属于当前阿里云账号。';
  }
  if (error.code === 'SignatureDoesNotMatch') {
    return 'AccessKey Secret 不匹配，请重新复制密钥。';
  }
  if (error.code === 'AccessDenied') {
    return '当前 AccessKey 没有这个 Bucket 的写入、读取或签名下载权限。';
  }
  return 'OSS 预检失败，请根据 error.code 和 requestId 在阿里云 OSS 侧继续排查。';
}

function summarizeVisibleBuckets(value: unknown): VisibleBucketsSummary {
  const buckets = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { buckets?: unknown }).buckets)
      ? (value as { buckets: unknown[] }).buckets
      : [];
  const regions = Array.from(new Set(
    buckets
      .map((bucket) => String((bucket as { region?: unknown }).region || '').trim())
      .filter(Boolean),
  )).sort();
  const truncated = typeof value === 'object'
    && value !== null
    && Boolean((value as { isTruncated?: unknown }).isTruncated);
  return {
    count: buckets.length,
    regions,
    truncated,
  };
}

function extractOssXmlErrorCode(input: string): string {
  const match = input.match(/<Code>([^<]+)<\/Code>/);
  return match?.[1]?.trim() || '';
}

function classifyBucketEndpointProbe(status?: number, code = ''): BucketEndpointProbe['outcome'] {
  if (code === 'NoSuchBucket') return 'bucket-not-found-in-configured-region';
  if (code === 'AccessDenied' || status === 403 || (typeof status === 'number' && status >= 200 && status < 400)) return 'bucket-endpoint-reachable';
  return 'unknown';
}

export function summarizeBucketEndpointProbe(probe: BucketEndpointProbe): string {
  if (probe.outcome === 'bucket-not-found-in-configured-region') {
    return '配置 region 下的 bucket 端点返回 NoSuchBucket，请优先核对 bucket 名称和地域。';
  }
  if (probe.outcome === 'bucket-endpoint-reachable') {
    return '配置 region 下的 bucket 端点可达，请优先核对 AccessKey 状态和对象权限。';
  }
  if (probe.error?.message) {
    return `bucket 端点探测未完成：${probe.error.message}`;
  }
  return 'bucket 端点探测未得到明确结论。';
}

function buildRegionProbeCandidates(configuredRegion: string): string[] {
  return Array.from(new Set([configuredRegion, ...COMMON_OSS_REGIONS].filter(Boolean)));
}

export function summarizeBucketRegionProbe(summary: BucketRegionProbeSummary): string {
  if (summary.outcome === 'bucket-endpoint-reachable-in-checked-regions') {
    return `bucket 端点在这些 region 可达：${summary.reachableRegions.join(', ')}，请把 DOCUMENT_RENDER_OSS_REGION 改成实际 bucket 地域。`;
  }
  if (summary.outcome === 'bucket-not-found-in-checked-regions') {
    return `已检查 ${summary.checkedRegions.length} 个常见 OSS region，均返回 NoSuchBucket，请优先核对 bucket 名称或账号归属。`;
  }
  return `已检查 ${summary.checkedRegions.length} 个常见 OSS region，未找到明确可达地域；其中 ${summary.inconclusiveRegions.length} 个 region 结果不确定。`;
}

async function probeBucketEndpoint(bucket: string, region: string): Promise<BucketEndpointProbe> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`https://${bucket}.${region}.aliyuncs.com/`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    const code = extractOssXmlErrorCode(await response.text().catch(() => ''));
    return {
      status: response.status,
      code: code || undefined,
      outcome: classifyBucketEndpointProbe(response.status, code),
    };
  } catch (error) {
    return {
      outcome: 'unknown',
      error: toErrorSummary(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeConfiguredBucketEndpoint(config: OssConfig): Promise<BucketEndpointProbe> {
  return probeBucketEndpoint(config.bucket, config.region);
}

async function probeBucketRegions(config: OssConfig): Promise<BucketRegionProbeSummary> {
  const checkedRegions = buildRegionProbeCandidates(config.region);
  const probes = await Promise.all(checkedRegions.map(async (region) => ({
    region,
    probe: await probeBucketEndpoint(config.bucket, region),
  })));
  const reachableRegions = probes
    .filter(({ probe }) => probe.outcome === 'bucket-endpoint-reachable')
    .map(({ region }) => region);
  const notFoundCount = probes
    .filter(({ probe }) => probe.outcome === 'bucket-not-found-in-configured-region')
    .length;
  const inconclusiveRegions = probes
    .filter(({ probe }) => probe.outcome === 'unknown')
    .map(({ region }) => region);
  const outcome: BucketRegionProbeSummary['outcome'] = reachableRegions.length > 0
    ? 'bucket-endpoint-reachable-in-checked-regions'
    : notFoundCount === checkedRegions.length
      ? 'bucket-not-found-in-checked-regions'
      : 'inconclusive';

  return {
    checkedRegions,
    reachableRegions,
    notFoundCount,
    inconclusiveRegions,
    outcome,
  };
}

function createConfigDiagnostics(config: OssConfig): Record<string, string> {
  return {
    accessKeyIdEnv: config.envNames.accessKeyId,
    accessKeySecretEnv: config.envNames.accessKeySecret,
    bucketEnv: config.envNames.bucket,
    regionEnv: config.envNames.region,
    normalizedRegion: config.region,
    prefix: config.prefix,
  };
}

function createTosConfigDiagnostics(config: TosVerifyConfig): Record<string, string> {
  return {
    accessKeyIdEnv: config.envNames.accessKeyId,
    accessKeySecretEnv: config.envNames.accessKeySecret,
    bucketEnv: config.envNames.bucket,
    regionEnv: config.envNames.region,
    endpointEnv: config.envNames.endpoint,
    normalizedEndpoint: config.endpoint,
    prefix: config.prefix,
  };
}

async function writeReport(report: OssReport): Promise<OssReport> {
  const milestoneRunId = (process.env.DOCUMENT_RENDER_MILESTONE1_RUN_ID || '').trim();
  const withRunId = milestoneRunId ? { milestoneRunId, ...report } : report;
  const reportPath = (process.env.DOCUMENT_RENDER_OSS_REPORT_PATH || '').trim();
  if (!reportPath) return withRunId;
  await mkdir(dirname(reportPath), { recursive: true });
  const output = { ...withRunId, reportFile: reportPath };
  await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

async function collectDiagnostics(config: OssConfig, error: ErrorSummary): Promise<Record<string, unknown>> {
  const diagnostics: Record<string, unknown> = {
    hint: getHint(error),
    config: createConfigDiagnostics(config),
  };
  const bucketEndpointProbe = await probeConfiguredBucketEndpoint(config);
  diagnostics.configuredBucketEndpoint = bucketEndpointProbe;
  diagnostics.hint = `${diagnostics.hint}；${summarizeBucketEndpointProbe(bucketEndpointProbe)}`;
  if (bucketEndpointProbe.outcome === 'bucket-not-found-in-configured-region') {
    const bucketRegionProbe = await probeBucketRegions(config);
    diagnostics.bucketRegionProbe = bucketRegionProbe;
    diagnostics.hint = `${diagnostics.hint}；${summarizeBucketRegionProbe(bucketRegionProbe)}`;
  }
  const serviceClient = new OSS({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    region: config.region,
    secure: true,
    timeout: 30000,
  });

  try {
    diagnostics.visibleBucketsSummary = summarizeVisibleBuckets(await serviceClient.listBuckets({ 'max-keys': 50 }));
  } catch (listError) {
    const visibleBucketsError = toErrorSummary(listError);
    diagnostics.visibleBucketsError = visibleBucketsError;
    diagnostics.hint = `${diagnostics.hint}；可见 bucket 查询失败：${getHint(visibleBucketsError)}`;
  }
  return diagnostics;
}

async function main(): Promise<void> {
  const provider = getConfiguredProvider();
  if (provider === 'tos') {
    await mainTos();
    return;
  }
  const config = getOssConfig();
  const client = new OSS({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    bucket: config.bucket,
    region: config.region,
    secure: true,
    timeout: 30000,
  });
  const objectName = `${config.prefix}diagnostics/${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;

  try {
    await client.put(objectName, TEST_CONTENT, {
      mime: 'text/plain; charset=utf-8',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'private, max-age=0, no-cache',
      },
    });
    const url = client.signatureUrl(objectName, { expires: 60, method: 'GET' });
    const response = await fetch(url);
    const downloaded = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200 || !downloaded.equals(TEST_CONTENT)) {
      throw new Error(`OSS 签名下载验证失败：status=${response.status}, bytes=${downloaded.length}`);
    }
    await client.delete(objectName);

    const report = await writeReport({
      ok: true,
      provider: 'oss',
      bucketEnv: config.envNames.bucket,
      region: config.region,
      objectName,
      downloadStatus: response.status,
      bytes: downloaded.length,
      checks: ['put-ok', 'signature-url-ok', 'download-ok', 'delete-ok'],
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    await client.delete(objectName).catch(() => undefined);
    const errorSummary = toErrorSummary(error);
    const report = await writeReport({
      ok: false,
      provider: 'oss',
      bucketEnv: config.envNames.bucket,
      region: config.region,
      objectName,
      error: errorSummary,
      diagnostics: await collectDiagnostics(config, errorSummary),
    });
    console.error(JSON.stringify(report));
    process.exit(1);
  }
}

async function mainTos(): Promise<void> {
  const config = getTosConfig();
  const objectName = `${config.prefix}diagnostics/${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;

  try {
    await putTosObject(config, objectName, TEST_CONTENT, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'private, max-age=0, no-cache',
    });
    const url = createTosPresignedGetUrl(config, objectName, 60);
    const response = await fetch(url);
    const downloaded = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200 || !downloaded.equals(TEST_CONTENT)) {
      throw new Error(`TOS 签名下载验证失败：status=${response.status}, bytes=${downloaded.length}`);
    }
    await deleteTosObject(config, objectName);

    const report = await writeReport({
      ok: true,
      provider: 'tos',
      bucketEnv: config.envNames.bucket,
      region: config.region,
      objectName,
      downloadStatus: response.status,
      bytes: downloaded.length,
      checks: ['put-ok', 'signature-url-ok', 'download-ok', 'delete-ok'],
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    await deleteTosObject(config, objectName).catch(() => undefined);
    const errorSummary = toErrorSummary(error);
    const report = await writeReport({
      ok: false,
      provider: 'tos',
      bucketEnv: config.envNames.bucket,
      region: config.region,
      objectName,
      error: errorSummary,
      diagnostics: {
        hint: getHint(errorSummary),
        config: createTosConfigDiagnostics(config),
      },
    });
    console.error(JSON.stringify(report));
    process.exit(1);
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

export const __test__ = {
  buildRegionProbeCandidates,
  classifyBucketEndpointProbe,
  createConfigDiagnostics,
  extractOssXmlErrorCode,
  getConfig: getOssConfig,
  getConfiguredProvider,
  getTosConfig,
  summarizeBucketEndpointProbe,
  summarizeBucketRegionProbe,
  summarizeVisibleBuckets,
};

if (isMainModule()) {
  main().catch(async (error) => {
    const errorSummary = toErrorSummary(error);
    const report = await writeReport({
      ok: false,
      error: errorSummary,
      diagnostics: {
        hint: getHint(errorSummary),
      },
    });
    console.error(JSON.stringify(report));
    process.exit(1);
  });
}
