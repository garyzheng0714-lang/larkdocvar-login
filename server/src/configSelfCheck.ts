// 启动时配置自检：把生产必备配置缺失（如 DOCUMENT_RENDER_API_KEY 未配）在启动瞬间
// 暴露到日志，而不是等业务系统报 401 才发现。默认只告警不阻断启动；
// DOCUMENT_RENDER_STRICT_CONFIG=true 时，生产存在 error 级缺失则拒绝启动。

export type ConfigSeverity = 'error' | 'warn';

export interface ConfigCheckItem {
  key: string;
  ok: boolean;
  severity: ConfigSeverity;
  message: string;
}

export interface ConfigSelfCheckResult {
  ok: boolean; // 无 error 级缺失（非生产环境恒为 true，只产生 warn）
  isProduction: boolean;
  items: ConfigCheckItem[];
  missing: ConfigCheckItem[];
}

export function runConfigSelfCheck(env: NodeJS.ProcessEnv = process.env): ConfigSelfCheckResult {
  const isProduction = env.NODE_ENV === 'production';
  const has = (key: string): boolean => Boolean((env[key] || '').trim());
  // 生产缺失=error（关键能力不可用），非生产缺失只 warn（本地开发可裸跑）。
  const sev: ConfigSeverity = isProduction ? 'error' : 'warn';

  const hasFeishuCredential =
    (has('FEISHU_FBIF_APP_ID') && has('FEISHU_FBIF_APP_SECRET')) ||
    (has('FEISHU_APP_ID') && has('FEISHU_APP_SECRET'));

  const storageProvider = (
    env.DOCUMENT_RENDER_STORAGE_PROVIDER ||
    env.DOCUMENT_RENDER_OBJECT_STORAGE_PROVIDER ||
    ''
  )
    .trim()
    .toLowerCase();
  let storageOk = false;
  if (storageProvider === 'tos') {
    storageOk = has('TOS_ACCESS_KEY') && has('TOS_SECRET_KEY') && has('TOS_BUCKET');
  } else if (storageProvider === 'oss') {
    storageOk =
      has('DOCUMENT_RENDER_OSS_ACCESS_KEY_ID') &&
      has('DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET') &&
      has('DOCUMENT_RENDER_OSS_BUCKET');
  }

  const items: ConfigCheckItem[] = [
    {
      key: 'DOCUMENT_RENDER_API_KEY',
      ok: has('DOCUMENT_RENDER_API_KEY'),
      severity: sev,
      message: '服务端到服务端 API Key；生产缺失会导致业务系统 / 多维表格工作流全部 401。',
    },
    {
      key: 'FEISHU_FBIF_APP_ID/SECRET',
      ok: hasFeishuCredential,
      severity: sev,
      message: '飞书应用凭证（或 FEISHU_APP_ID/SECRET 兼容别名）；缺失则云文档模板与登录不可用。',
    },
    {
      key: 'FEISHU_ALLOWED_TENANT_KEYS',
      ok: has('FEISHU_ALLOWED_TENANT_KEYS'),
      severity: sev,
      message: '飞书租户白名单；生产为空会拒绝所有租户登录。',
    },
    {
      key: 'DATABASE_URL',
      ok: has('DATABASE_URL'),
      severity: sev,
      message: '会话 / 模板配置 / 异步任务持久化；缺失则侧边栏状态无法保存。',
    },
    {
      key: 'DOCUMENT_RENDER_STORAGE_PROVIDER(+凭据)',
      ok: storageOk,
      severity: sev,
      message: '生产必须配置 TOS 或 OSS 对象存储；否则模板资产 / 生成文件落本地临时目录，重启即丢。',
    },
  ];

  const missing = items.filter((item) => !item.ok);
  const hasError = missing.some((item) => item.severity === 'error');
  return { ok: !hasError, isProduction, items, missing };
}

export function assertConfigOrExit(
  result: ConfigSelfCheckResult,
  logger: Pick<Console, 'log' | 'error'> = console,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const envLabel = result.isProduction ? 'production' : 'non-production';
  if (result.missing.length === 0) {
    logger.log(`[config-self-check] ✅ 配置自检通过（${envLabel}）`);
  } else {
    const lines = result.missing
      .map((item) => `  - [${item.severity.toUpperCase()}] ${item.key}：${item.message}`)
      .join('\n');
    logger.error(`[config-self-check] ⚠️ 配置自检发现 ${result.missing.length} 项缺失（${envLabel}）：\n${lines}`);
  }

  const strict = (env.DOCUMENT_RENDER_STRICT_CONFIG || '').trim() === 'true';
  if (strict && !result.ok) {
    throw new Error(
      '[config-self-check] DOCUMENT_RENDER_STRICT_CONFIG=true 且存在 error 级配置缺失，拒绝启动。',
    );
  }
}
