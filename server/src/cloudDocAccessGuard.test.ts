import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBitableSidebarHeaders } from './cloudDocAccessGuard';

const ENV_KEYS = [
  'NODE_ENV',
  'BITABLE_SIDEBAR_ALLOWED_BASE_IDS',
  'BITABLE_SIDEBAR_ALLOWED_TABLE_IDS',
  'FEISHU_ALLOWED_TENANT_KEYS',
] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('云文档侧边栏访问校验在非生产环境允许未配置白名单的真实表头', () => {
  withEnv({ NODE_ENV: 'development' }, () => {
    assert.deepEqual(validateBitableSidebarHeaders({
      baseId: 'base_1',
      tableId: 'tbl_1',
    }), { ok: true });
  });
});

test('云文档侧边栏访问校验在生产环境必须配置 Base 白名单和租户信息', () => {
  withEnv({ NODE_ENV: 'production' }, () => {
    assert.deepEqual(validateBitableSidebarHeaders({
      baseId: 'base_1',
      tableId: 'tbl_1',
    }), { ok: false, error: '服务未配置允许访问的多维表格。' });
  });
});

test('云文档侧边栏访问校验同时检查 Base、Table 和 Tenant 白名单', () => {
  withEnv({
    NODE_ENV: 'production',
    BITABLE_SIDEBAR_ALLOWED_BASE_IDS: 'base_allowed',
    BITABLE_SIDEBAR_ALLOWED_TABLE_IDS: 'tbl_allowed',
    FEISHU_ALLOWED_TENANT_KEYS: 'tenant_allowed',
  }, () => {
    assert.deepEqual(validateBitableSidebarHeaders({
      baseId: 'base_allowed',
      tableId: 'tbl_allowed',
      tenantKey: 'tenant_allowed',
    }), { ok: true });

    assert.equal(validateBitableSidebarHeaders({
      baseId: 'base_other',
      tableId: 'tbl_allowed',
      tenantKey: 'tenant_allowed',
    }).ok, false);

    assert.equal(validateBitableSidebarHeaders({
      baseId: 'base_allowed',
      tableId: 'tbl_other',
      tenantKey: 'tenant_allowed',
    }).ok, false);

    assert.equal(validateBitableSidebarHeaders({
      baseId: 'base_allowed',
      tableId: 'tbl_allowed',
      tenantKey: 'tenant_other',
    }).ok, false);
  });
});
