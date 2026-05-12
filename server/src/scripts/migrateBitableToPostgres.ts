import axios from 'axios';
import '../env';
import {
  initDatabase,
  getUserByOpenId,
  upsertUser,
  saveOrUpdateConfig,
} from '../storage';

const FEISHU_OPEN_API = 'https://open.feishu.cn/open-apis';

const FIELD_USER_OPEN_ID = 'user_open_id';
const FIELD_CONFIG_NAME = 'config_name';
const FIELD_PAYLOAD_JSON = 'payload_json';
const FIELD_UPDATED_AT = 'updated_at';

interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

interface BitableEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

interface BitableRecordItem {
  record_id: string;
  fields?: Record<string, unknown>;
}

interface BitableListRecordsData {
  items?: BitableRecordItem[];
  has_more?: boolean;
  page_token?: string;
}

interface NormalizedConfigRecord {
  recordId: string;
  openId: string;
  configName: string;
  payloadJson: string;
  updatedAt: string;
}

function getEnv(name: string): string {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

function pickFieldText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!Array.isArray(value)) return '';

  const parts = value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const text = (item as { text?: string }).text;
        if (typeof text === 'string') return text;
      }
      return '';
    })
    .filter(Boolean);
  return parts.join('').trim();
}

function normalizePayloadJson(payloadJson: string): string {
  if (!payloadJson) return '{}';
  try {
    const parsed = JSON.parse(payloadJson);
    if (parsed && typeof parsed === 'object') {
      return JSON.stringify(parsed);
    }
    return '{}';
  } catch {
    return '{}';
  }
}

function getConfigRichnessScore(payloadJson: string): number {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    let score = 0;

    const bindings = payload.bindings;
    if (bindings && typeof bindings === 'object') {
      score += Object.values(bindings as Record<string, unknown>).filter((v) => typeof v === 'string' && v.trim()).length;
    }

    if (payload.ownerSelected && typeof payload.ownerSelected === 'object') {
      score += 5;
    }

    if (Array.isArray(payload.collaborators)) {
      score += payload.collaborators.length;
    }
    return score;
  } catch {
    return 0;
  }
}

function parseTimeMs(value: string): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function pickBetterRecord(current: NormalizedConfigRecord, next: NormalizedConfigRecord): NormalizedConfigRecord {
  const currentScore = getConfigRichnessScore(current.payloadJson);
  const nextScore = getConfigRichnessScore(next.payloadJson);
  if (nextScore > currentScore) {
    return next;
  }
  if (nextScore < currentScore) {
    return current;
  }
  return parseTimeMs(next.updatedAt) >= parseTimeMs(current.updatedAt) ? next : current;
}

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const response = await axios.post<TenantTokenResponse>(
    `${FEISHU_OPEN_API}/auth/v3/tenant_access_token/internal`,
    {
      app_id: appId,
      app_secret: appSecret,
    },
    {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      timeout: 20000,
    },
  );

  const body = response.data;
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败：${body.msg || '未知错误'}`);
  }
  return body.tenant_access_token;
}

async function listAllBitableRecords(token: string, appToken: string, tableId: string): Promise<BitableRecordItem[]> {
  const records: BitableRecordItem[] = [];
  let pageToken = '';

  while (true) {
    const response = await axios.get<BitableEnvelope<BitableListRecordsData>>(
      `${FEISHU_OPEN_API}/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        params: {
          page_size: 500,
          page_token: pageToken,
        },
        timeout: 30000,
      },
    );

    const body = response.data;
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new Error(`读取 Bitable 记录失败：[code=${body.code}] ${body.msg || '未知错误'}`);
    }

    const data = body.data || {};
    records.push(...(data.items || []));
    if (!data.has_more || !data.page_token) {
      break;
    }
    pageToken = data.page_token;
  }

  return records;
}

function normalizeRecord(record: BitableRecordItem): NormalizedConfigRecord | null {
  const fields = record.fields || {};
  const openId = pickFieldText(fields[FIELD_USER_OPEN_ID]);
  const configName = pickFieldText(fields[FIELD_CONFIG_NAME]);
  if (!openId || !configName) {
    return null;
  }

  const payloadJson = normalizePayloadJson(pickFieldText(fields[FIELD_PAYLOAD_JSON]));
  const updatedAt = pickFieldText(fields[FIELD_UPDATED_AT]) || new Date().toISOString();

  return {
    recordId: record.record_id,
    openId,
    configName,
    payloadJson,
    updatedAt,
  };
}

async function ensureUserExists(openId: string, dryRun: boolean): Promise<boolean> {
  const existing = await getUserByOpenId(openId);
  if (existing) {
    return false;
  }
  if (!dryRun) {
    const shortId = openId.slice(-6) || openId;
    await upsertUser({
      openId,
      name: `迁移用户-${shortId}`,
      enName: null,
      email: null,
      avatarUrl: null,
    });
  }
  return true;
}

async function migrate(): Promise<void> {
  const appId = getEnv('FEISHU_APP_ID');
  const appSecret = getEnv('FEISHU_APP_SECRET');
  const appToken = getEnv('BITABLE_APP_TOKEN');
  const tableId = getEnv('BITABLE_TABLE_ID');
  const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

  await initDatabase();

  console.log('[migrate] 开始读取 Bitable 历史配置...');
  const tenantToken = await getTenantAccessToken(appId, appSecret);
  const allRecords = await listAllBitableRecords(tenantToken, appToken, tableId);
  console.log(`[migrate] Bitable 记录总数: ${allRecords.length}`);

  let invalidCount = 0;
  const deduped = new Map<string, NormalizedConfigRecord>();
  for (const item of allRecords) {
    const normalized = normalizeRecord(item);
    if (!normalized) {
      invalidCount += 1;
      continue;
    }
    const key = `${normalized.openId}::${normalized.configName}`;
    const existing = deduped.get(key);
    deduped.set(key, existing ? pickBetterRecord(existing, normalized) : normalized);
  }

  let createdUserCount = 0;
  let migratedConfigCount = 0;
  for (const record of deduped.values()) {
    const createdUser = await ensureUserExists(record.openId, dryRun);
    if (createdUser) {
      createdUserCount += 1;
    }

    if (!dryRun) {
      await saveOrUpdateConfig({
        openId: record.openId,
        configName: record.configName,
        payloadJson: record.payloadJson,
      });
    }
    migratedConfigCount += 1;
  }

  console.log('[migrate] 完成');
  console.log(`[migrate] 无效记录(缺少 open_id/config_name): ${invalidCount}`);
  console.log(`[migrate] 去重后配置数: ${deduped.size}`);
  console.log(`[migrate] 新建用户数: ${createdUserCount}`);
  console.log(`[migrate] ${dryRun ? '拟迁移配置数' : '已迁移配置数'}: ${migratedConfigCount}`);
  if (dryRun) {
    console.log('[migrate] 当前为 DRY_RUN=true，仅预览结果，未写入 PostgreSQL');
  }
}

void migrate().catch((error) => {
  console.error('[migrate] 失败:', error);
  process.exit(1);
});
