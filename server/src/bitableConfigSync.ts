import axios, { AxiosError } from 'axios';

const FEISHU_OPEN_API = 'https://open.feishu.cn/open-apis';

const FIELD_USER_OPEN_ID = 'user_open_id';
const FIELD_TABLE_ID = 'table_id';
const FIELD_CONFIG_NAME = 'config_name';
const FIELD_TEMPLATE_ID = 'template_id';
const FIELD_TEMPLATE_TITLE = 'template_title';
const FIELD_TEMPLATE_URL = 'template_url';
const FIELD_PAYLOAD_JSON = 'payload_json';
const FIELD_CREATED_AT = 'created_at';
const FIELD_UPDATED_AT = 'updated_at';

const REQUIRED_TEXT_FIELDS = [
  FIELD_USER_OPEN_ID,
  FIELD_TABLE_ID,
  FIELD_CONFIG_NAME,
  FIELD_TEMPLATE_ID,
  FIELD_TEMPLATE_TITLE,
  FIELD_TEMPLATE_URL,
  FIELD_PAYLOAD_JSON,
  FIELD_CREATED_AT,
  FIELD_UPDATED_AT,
];

interface BitableSyncOptions {
  enabled: boolean;
  appId: string;
  appSecret: string;
  appToken: string;
  tableId: string;
}

interface SyncStatus {
  ok: boolean;
  source: 'bitable' | 'disabled';
  message?: string;
  checkedAt: string;
}

interface BitableDataEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

interface BitableFieldItem {
  field_id: string;
  field_name: string;
  type: number;
}

interface BitableListFieldsData {
  items?: BitableFieldItem[];
  has_more?: boolean;
  page_token?: string;
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

interface BitableConfigRecord {
  recordId: string;
  openId: string;
  tableId: string;
  configName: string;
  templateId: string;
  templateTitle: string;
  templateUrl: string;
  payloadJson: string;
  createdAt: string;
  updatedAt: string;
}

interface UpsertConfigInput {
  openId: string;
  tableId: string;
  configName: string;
  payloadJson: string;
  templateId: string;
  templateTitle: string;
  templateUrl: string;
}

function isoNow(): string {
  return new Date().toISOString();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const responseData = error.response?.data as { msg?: string; error?: string } | undefined;
    return responseData?.msg || responseData?.error || error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function pickFieldText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const text = (item as { text?: string }).text;
          if (typeof text === 'string') return text;
        }
        return '';
      })
      .filter((item) => item.length > 0);
    if (parts.length > 0) {
      return parts.join('');
    }
  }
  return '';
}

export class BitableConfigSyncService {
  private readonly options: BitableSyncOptions;
  private tokenCache: { value: string; expiresAt: number } | null = null;

  constructor(options: BitableSyncOptions) {
    this.options = options;
  }

  isEnabled(): boolean {
    return this.options.enabled;
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.value;
    }

    const response = await axios.post<{ code: number; msg: string; tenant_access_token?: string; expire?: number }>(
      `${FEISHU_OPEN_API}/auth/v3/tenant_access_token/internal`,
      {
        app_id: this.options.appId,
        app_secret: this.options.appSecret,
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

    const expiresIn = Math.max(60, (body.expire || 7200) - 120);
    this.tokenCache = {
      value: body.tenant_access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    return body.tenant_access_token;
  }

  private async request<T>(method: 'GET' | 'POST' | 'PUT', path: string, options?: {
    params?: Record<string, string | number | boolean>;
    data?: unknown;
  }): Promise<T> {
    const token = await this.getTenantAccessToken();
    const response = await axios.request<BitableDataEnvelope<T>>({
      method,
      url: `${FEISHU_OPEN_API}${path}`,
      params: options?.params,
      data: options?.data,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      timeout: 30000,
    });

    const body = response.data;
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new Error(`飞书 Bitable 接口失败：[code=${body.code}] ${body.msg || '未知错误'}`);
    }
    return (body.data || {}) as T;
  }

  private async listAllFields(): Promise<BitableFieldItem[]> {
    const all: BitableFieldItem[] = [];
    let pageToken = '';
    while (true) {
      const data = await this.request<BitableListFieldsData>(
        'GET',
        `/bitable/v1/apps/${this.options.appToken}/tables/${this.options.tableId}/fields`,
        { params: { page_size: 500, page_token: pageToken } },
      );
      all.push(...(data.items || []));
      if (!data.has_more || !data.page_token) break;
      pageToken = data.page_token;
    }
    return all;
  }

  async ensureSchema(): Promise<SyncStatus> {
    if (!this.options.enabled) {
      return {
        ok: true,
        source: 'disabled',
        message: '未启用 Bitable 同步',
        checkedAt: isoNow(),
      };
    }

    try {
      const existing = await this.listAllFields();
      const existingNames = new Set(existing.map((item) => item.field_name));
      for (const fieldName of REQUIRED_TEXT_FIELDS) {
        if (existingNames.has(fieldName)) continue;
        await this.request('POST', `/bitable/v1/apps/${this.options.appToken}/tables/${this.options.tableId}/fields`, {
          data: {
            field_name: fieldName,
            type: 1,
          },
        });
      }

      return {
        ok: true,
        source: 'bitable',
        checkedAt: isoNow(),
      };
    } catch (error) {
      return {
        ok: false,
        source: 'bitable',
        message: `多维表格字段初始化失败：${toErrorMessage(error)}`,
        checkedAt: isoNow(),
      };
    }
  }

  private async listAllRecords(): Promise<BitableRecordItem[]> {
    const all: BitableRecordItem[] = [];
    let pageToken = '';
    while (true) {
      const data = await this.request<BitableListRecordsData>(
        'GET',
        `/bitable/v1/apps/${this.options.appToken}/tables/${this.options.tableId}/records`,
        {
          params: {
            page_size: 500,
            page_token: pageToken,
          },
        },
      );
      all.push(...(data.items || []));
      if (!data.has_more || !data.page_token) break;
      pageToken = data.page_token;
    }
    return all;
  }

  private parseRecord(item: BitableRecordItem): BitableConfigRecord {
    const fields = item.fields || {};
    return {
      recordId: item.record_id,
      openId: pickFieldText(fields[FIELD_USER_OPEN_ID]),
      tableId: pickFieldText(fields[FIELD_TABLE_ID]),
      configName: pickFieldText(fields[FIELD_CONFIG_NAME]),
      templateId: pickFieldText(fields[FIELD_TEMPLATE_ID]),
      templateTitle: pickFieldText(fields[FIELD_TEMPLATE_TITLE]),
      templateUrl: pickFieldText(fields[FIELD_TEMPLATE_URL]),
      payloadJson: pickFieldText(fields[FIELD_PAYLOAD_JSON]),
      createdAt: pickFieldText(fields[FIELD_CREATED_AT]),
      updatedAt: pickFieldText(fields[FIELD_UPDATED_AT]),
    };
  }

  async listUserConfigs(openId: string, tableId?: string): Promise<BitableConfigRecord[]> {
    const schema = await this.ensureSchema();
    if (!schema.ok) {
      throw new Error(schema.message || '多维表格字段初始化失败');
    }

    const rows = (await this.listAllRecords())
      .map((item) => this.parseRecord(item))
      .filter((item) => item.openId === openId && item.configName)
      .filter((item) => {
        if (!tableId) return true;
        return item.tableId === tableId;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return rows;
  }

  async getUserConfigByRecordId(openId: string, recordId: string, tableId?: string): Promise<BitableConfigRecord | null> {
    const rows = await this.listUserConfigs(openId, tableId);
    return rows.find((row) => row.recordId === recordId) || null;
  }

  async getUserConfigByName(openId: string, configName: string, tableId?: string): Promise<BitableConfigRecord | null> {
    const rows = await this.listUserConfigs(openId, tableId);
    return rows.find((row) => row.configName === configName) || null;
  }

  async upsertUserConfig(input: UpsertConfigInput): Promise<BitableConfigRecord> {
    const schema = await this.ensureSchema();
    if (!schema.ok) {
      throw new Error(schema.message || '多维表格字段初始化失败');
    }

    const existing = await this.getUserConfigByName(input.openId, input.configName, input.tableId);
    const now = isoNow();
    const fields: Record<string, string> = {
      [FIELD_USER_OPEN_ID]: input.openId,
      [FIELD_TABLE_ID]: input.tableId,
      [FIELD_CONFIG_NAME]: input.configName,
      [FIELD_TEMPLATE_ID]: input.templateId,
      [FIELD_TEMPLATE_TITLE]: input.templateTitle,
      [FIELD_TEMPLATE_URL]: input.templateUrl,
      [FIELD_PAYLOAD_JSON]: input.payloadJson,
      [FIELD_UPDATED_AT]: now,
    };

    if (existing) {
      await this.request(
        'PUT',
        `/bitable/v1/apps/${this.options.appToken}/tables/${this.options.tableId}/records/${existing.recordId}`,
        { data: { fields } },
      );
      return {
        ...existing,
        ...{
          openId: input.openId,
          tableId: input.tableId,
          configName: input.configName,
          templateId: input.templateId,
          templateTitle: input.templateTitle,
          templateUrl: input.templateUrl,
          payloadJson: input.payloadJson,
          updatedAt: now,
        },
      };
    }

    const createResp = await this.request<{ record?: { record_id?: string } }>(
      'POST',
      `/bitable/v1/apps/${this.options.appToken}/tables/${this.options.tableId}/records`,
      {
        data: {
          fields: {
            ...fields,
            [FIELD_CREATED_AT]: now,
          },
        },
      },
    );

    const recordId = createResp.record?.record_id;
    if (!recordId) {
      throw new Error('多维表格写入成功但未返回 record_id');
    }

    return {
      recordId,
      openId: input.openId,
      tableId: input.tableId,
      configName: input.configName,
      templateId: input.templateId,
      templateTitle: input.templateTitle,
      templateUrl: input.templateUrl,
      payloadJson: input.payloadJson,
      createdAt: now,
      updatedAt: now,
    };
  }
}

export type { SyncStatus, BitableConfigRecord, UpsertConfigInput };
