import assert from 'node:assert/strict';
import test from 'node:test';
import { runConfigSelfCheck, assertConfigOrExit } from './configSelfCheck';

// 一份"生产 + 全部配齐"的基线 env，单测在它之上删字段来制造缺失。
function fullProdEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DOCUMENT_RENDER_API_KEY: 'test-api-key',
    FEISHU_FBIF_APP_ID: 'app-id',
    FEISHU_FBIF_APP_SECRET: 'app-secret',
    FEISHU_ALLOWED_TENANT_KEYS: 'tenant-a',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    DOCUMENT_RENDER_STORAGE_PROVIDER: 'tos',
    TOS_ACCESS_KEY: 'ak',
    TOS_SECRET_KEY: 'sk',
    TOS_BUCKET: 'bucket',
  } as NodeJS.ProcessEnv;
}

test('生产环境全部配齐 → 自检通过、无缺失', () => {
  const result = runConfigSelfCheck(fullProdEnv());
  assert.equal(result.ok, true);
  assert.equal(result.missing.length, 0);
});

// WHY：API key 未配置正是本次"生产裸奔 / 工作流全部 401"事故的根因，
// 自检的核心价值就是把它在启动时以 error 级别拦下，而不是等业务方报 401。
test('生产环境缺 DOCUMENT_RENDER_API_KEY → 报 error，自检不通过', () => {
  const env = fullProdEnv();
  delete env.DOCUMENT_RENDER_API_KEY;
  const result = runConfigSelfCheck(env);
  assert.equal(result.ok, false);
  const item = result.missing.find((i) => i.key === 'DOCUMENT_RENDER_API_KEY');
  assert.ok(item, '应报出 DOCUMENT_RENDER_API_KEY 缺失');
  assert.equal(item?.severity, 'error');
});

// WHY：本地开发不应被配置自检卡住，缺失只能是 warn，绝不能 error / 阻断。
test('非生产环境即使全空也只 warn、不阻断', () => {
  const result = runConfigSelfCheck({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
  assert.equal(result.ok, true);
  assert.ok(result.missing.length > 0);
  assert.ok(result.missing.every((i) => i.severity === 'warn'), '非生产缺失必须全是 warn');
});

// WHY：生产配了 provider 却漏了凭据，文件会静默落本地临时目录、重启即丢，必须被发现。
test('存储 provider=tos 但缺 TOS_BUCKET → 存储项报缺失', () => {
  const env = fullProdEnv();
  delete env.TOS_BUCKET;
  const result = runConfigSelfCheck(env);
  const item = result.missing.find((i) => i.key.startsWith('DOCUMENT_RENDER_STORAGE_PROVIDER'));
  assert.ok(item, '缺 TOS_BUCKET 时存储项应报缺失');
});

// WHY：历史部署用 FEISHU_APP_ID/SECRET 别名，自检不能把这种合法配置误报成缺失。
test('飞书凭据走 FEISHU_APP_ID 兼容别名也算配齐', () => {
  const env = fullProdEnv();
  delete env.FEISHU_FBIF_APP_ID;
  delete env.FEISHU_FBIF_APP_SECRET;
  env.FEISHU_APP_ID = 'app-id';
  env.FEISHU_APP_SECRET = 'app-secret';
  const result = runConfigSelfCheck(env);
  const item = result.missing.find((i) => i.key.startsWith('FEISHU'));
  assert.equal(item, undefined, '兼容别名配齐时不应报飞书凭据缺失');
});

// WHY：默认（非 strict）必须保证"配不全也能起服务"，避免一次配置自检改动把生产搞挂。
test('默认非 strict：生产缺配只告警、不抛错', () => {
  const logger = { log() {}, error() {} };
  assert.doesNotThrow(() =>
    assertConfigOrExit(
      runConfigSelfCheck({ NODE_ENV: 'production' } as NodeJS.ProcessEnv),
      logger,
      {} as NodeJS.ProcessEnv,
    ),
  );
});

// WHY：显式开 strict 时，配不全必须 fail loud 拒绝启动（提供给重视一致性的部署）。
test('STRICT=true 且生产缺配 → 抛错拒绝启动', () => {
  const logger = { log() {}, error() {} };
  assert.throws(() =>
    assertConfigOrExit(
      runConfigSelfCheck({ NODE_ENV: 'production' } as NodeJS.ProcessEnv),
      logger,
      { DOCUMENT_RENDER_STRICT_CONFIG: 'true' } as NodeJS.ProcessEnv,
    ),
  );
});
