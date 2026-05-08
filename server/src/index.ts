import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { FeishuTemplateService, GenerateInput } from './feishu';
import {
  initDatabase,
  deleteSessionByToken,
  listSavedConfigs,
  getSavedConfig,
  getSavedConfigByName,
  saveOrUpdateConfig,
} from './storage';
import type { SavedConfigRow } from './storage';
import {
  requireAuth,
  peekSessionForRequest,
  resolveSessionTokenFromRequest,
} from './auth';
import { registerOAuthRoutes } from './oauthRoutes';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const appId = process.env.FEISHU_APP_ID || '';
const appSecret = process.env.FEISHU_APP_SECRET || '';

// ---------------------------------------------------------------------------
// Feishu OAuth2 configuration
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'larkdocvar_session';
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === 'true';
const SESSION_MAX_AGE_SECONDS = Number(process.env.SESSION_MAX_AGE_SECONDS || 604800);
const SESSION_COOKIE_SAMESITE_RAW = (process.env.SESSION_COOKIE_SAMESITE || (SESSION_COOKIE_SECURE ? 'none' : 'lax')).toLowerCase();
const SESSION_COOKIE_SAMESITE =
  SESSION_COOKIE_SAMESITE_RAW === 'strict' || SESSION_COOKIE_SAMESITE_RAW === 'none'
    ? SESSION_COOKIE_SAMESITE_RAW
    : 'lax';

const hasCredential = Boolean(appId && appSecret);
const feishuService = hasCredential
  ? new FeishuTemplateService({
      appId,
      appSecret
    })
  : null;

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function toApiConfig(record: SavedConfigRow) {
  return {
    id: record.id,
    configName: record.config_name,
    payload: parsePayload(record.payload_json),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function buildTemplateConfigName(templateId: string, tableId?: string): string {
  const normalizedTableId = (tableId || '').trim();
  if (normalizedTableId) {
    return `template::${normalizedTableId}::${templateId}`;
  }
  return `template::${templateId}`;
}

function parseTemplateConfigName(configName: string): { tableId: string; templateId: string } {
  if (!configName.startsWith('template::')) {
    return { tableId: '', templateId: '' };
  }
  const raw = configName.replace(/^template::/, '');
  const parts = raw.split('::');
  if (parts.length >= 2) {
    return {
      tableId: parts[0] || '',
      templateId: parts.slice(1).join('::') || '',
    };
  }
  return { tableId: '', templateId: raw };
}

function getConfigRichnessScore(payloadJson: string): number {
  const payload = parsePayload(payloadJson);
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
}

if (feishuService) {
  // Prewarm the user directory cache asynchronously so the search works fast on first attempt
  setTimeout(() => {
    feishuService.prewarmDirectoryCache();
  }, 1000);
}

const extractVariablesSchema = z.object({
  templateUrl: z.string().trim().min(1)
});

const searchUsersSchema = z.object({
  q: z.string().trim().default(''),
  limit: z.coerce.number().int().min(1).max(200).default(200)
});

const generateSchema = z.object({
  templateUrl: z.string().trim().min(1),
  records: z
    .array(
      z.object({
        recordId: z.string().trim().min(1),
        variables: z.record(z.string(), z.string()),
        imageVariables: z.record(
          z.string(),
          z.object({
            urls: z.array(z.string().min(1)).min(1),
            width: z.number().int().min(0).max(2000).default(400)
          })
        ).optional(),
        title: z.string().max(255).optional()
      })
    )
    .min(1)
    .max(200),
  options: z
    .object({
      permissionMode: z.enum(['internet_readable', 'internet_editable', 'tenant_readable', 'tenant_editable', 'closed']).optional(),
      ownerTransfer: z
        .object({
          memberType: z.enum(['userid', 'openid', 'email']),
          memberId: z.string().trim().min(1),
          needNotification: z.boolean().optional(),
          removeOldOwner: z.boolean().optional(),
          stayPut: z.boolean().optional(),
          oldOwnerPerm: z.enum(['view', 'edit', 'full_access']).optional()
        })
        .optional(),
      collaborators: z.array(
        z.object({
          memberType: z.enum(['openid', 'email', 'userid']),
          memberId: z.string().trim().min(1),
          perm: z.enum(['view', 'edit', 'full_access'])
        })
      ).max(50).optional(),
    })
    .optional()
});

const saveConfigSchema = z.object({
  configName: z.string().trim().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));

function extractDocumentIdFromUrl(input: string): string {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/(?:docx|docs)\/([a-zA-Z0-9_]+)/);
    if (match?.[1]) return match[1];
  } catch {
    const match = trimmed.match(/\/(?:docx|docs)\/([a-zA-Z0-9_]+)/);
    if (match?.[1]) return match[1];
  }
  return '';
}

async function extractTemplateVariablesByUserToken(templateUrl: string, userAccessToken: string): Promise<{ documentId: string; templateTitle: string; variables: string[]; }> {
  const documentId = extractDocumentIdFromUrl(templateUrl);
  if (!documentId) {
    throw new Error('无法从模板链接中解析 document_id，请确认链接格式。');
  }

  const [docInfoResp, rawResp] = await Promise.all([
    axios.get(`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}`, {
      headers: { Authorization: `Bearer ${userAccessToken}` },
    }),
    axios.get(`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/raw_content`, {
      headers: { Authorization: `Bearer ${userAccessToken}` },
    }),
  ]);

  const docInfoBody = docInfoResp.data as { code?: number; msg?: string; data?: { document?: { title?: string } } };
  if (typeof docInfoBody.code === 'number' && docInfoBody.code !== 0) {
    throw new Error(`读取文档标题失败：[code=${docInfoBody.code}] ${docInfoBody.msg || '未知错误'}`);
  }

  const rawBody = rawResp.data as { code?: number; msg?: string; data?: { content?: string } };
  if (typeof rawBody.code === 'number' && rawBody.code !== 0) {
    throw new Error(`读取文档内容失败：[code=${rawBody.code}] ${rawBody.msg || '未知错误'}`);
  }

  const content = rawBody.data?.content ?? '';
  const matches = content.match(/\{\{\s*([^{}]+?)\s*\}\}/g) || [];
  const variables = Array.from(new Set(matches.map((m) => m.replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').trim()).filter(Boolean)));

  return {
    documentId,
    templateTitle: docInfoBody.data?.document?.title?.trim() || '模板文档',
    variables,
  };
}

// ---------------------------------------------------------------------------
// Feishu OAuth2 routes (button mode + QR mode)
// ---------------------------------------------------------------------------

registerOAuthRoutes(app);

/**
 * GET /api/auth/session
 * Returns the current login state and user profile from the persisted session.
 */
app.get('/api/auth/session', async (request, response) => {
  const peek = await peekSessionForRequest(request);
  if (!peek) {
    response.json({ ok: true, loggedIn: false });
    return;
  }

  response.cookie(SESSION_COOKIE_NAME, peek.sessionToken, {
    httpOnly: true,
    secure: SESSION_COOKIE_SECURE,
    sameSite: SESSION_COOKIE_SAMESITE,
    maxAge: SESSION_MAX_AGE_SECONDS * 1000,
    path: '/',
  });

  response.json({ ok: true, loggedIn: true, user: peek.profile });
});

/**
 * POST /api/auth/logout
 * Clears the session cookie.
 */
app.post('/api/auth/logout', async (request, response) => {
  const sessionToken = resolveSessionTokenFromRequest(request);
  if (sessionToken) {
    await deleteSessionByToken(sessionToken).catch(() => undefined);
  }
  response.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: SESSION_COOKIE_SECURE,
    sameSite: SESSION_COOKIE_SAMESITE,
    path: '/',
  });
  response.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Saved config CRUD routes
// ---------------------------------------------------------------------------

function buildSavedTemplateRecord(config: SavedConfigRow): {
  id: string;
  tableId: string;
  templateId: string;
  templateTitle: string;
  templateUrl: string;
  payloadJson: string;
  createdAt: string;
  updatedAt: string;
} | null {
  if (!config.config_name.startsWith('template::')) {
    return null;
  }

  const payload = parsePayload(config.payload_json);
  const parsedName = parseTemplateConfigName(config.config_name);
  const payloadTableId = typeof payload.tableId === 'string' ? payload.tableId.trim() : '';
  const payloadTemplateId = typeof payload.templateId === 'string' ? payload.templateId.trim() : '';
  const payloadTemplateUrl = typeof payload.templateUrl === 'string' ? payload.templateUrl.trim() : '';
  const payloadTemplateTitle = typeof payload.templateTitle === 'string' ? payload.templateTitle.trim() : '';

  const templateId = payloadTemplateId || parsedName.templateId || extractDocumentIdFromUrl(payloadTemplateUrl);
  if (!templateId) {
    return null;
  }

  return {
    id: config.id,
    tableId: payloadTableId || parsedName.tableId,
    templateId,
    templateTitle: payloadTemplateTitle || `模板 ${templateId.slice(0, 8)}`,
    templateUrl: payloadTemplateUrl,
    payloadJson: config.payload_json,
    createdAt: config.created_at,
    updatedAt: config.updated_at,
  };
}

type SavedTemplateRecord = NonNullable<ReturnType<typeof buildSavedTemplateRecord>>;

/**
 * GET /api/configs
 * List all saved configs for the current user.
 */
app.get('/api/configs', async (request, response) => {
  const ctx = await requireAuth(request, response);
  if (!ctx) return;

  try {
    const rows = await listSavedConfigs(ctx.openId);
    response.json({
      ok: true,
      configs: rows.map((r) => ({
        id: r.id,
        configName: r.config_name,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (error) {
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/templates/saved', async (request, response) => {
  const ctx = await requireAuth(request, response);
  if (!ctx) return;

  try {
    const tableId = String(request.query.tableId || '').trim();
    const rows = await listSavedConfigs(ctx.openId);

    const byTemplateKey = new Map<string, SavedTemplateRecord>();
    for (const row of rows) {
      const normalized = buildSavedTemplateRecord(row);
      if (!normalized) continue;
      if (tableId && normalized.tableId !== tableId) continue;
      const key = `${normalized.tableId}::${normalized.templateId}`;
      const existing = byTemplateKey.get(key);
      if (!existing) {
        byTemplateKey.set(key, normalized);
        continue;
      }

      const rowScore = getConfigRichnessScore(normalized.payloadJson);
      const existingScore = getConfigRichnessScore(existing.payloadJson);
      const shouldReplace = rowScore > existingScore || (rowScore === existingScore && normalized.updatedAt > existing.updatedAt);

      if (shouldReplace) {
        byTemplateKey.set(key, normalized);
      }
    }

    const templates = [...byTemplateKey.values()].map((row) => ({
      id: row.id,
      templateId: row.templateId,
      templateTitle: row.templateTitle,
      templateUrl: row.templateUrl,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
    response.json({ ok: true, templates });
  } catch (error) {
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * GET /api/configs/:id
 * Fetch one saved config by id (with parsed payload).
 */
app.get('/api/configs/:id', async (request, response) => {
  const ctx = await requireAuth(request, response);
  if (!ctx) return;

  const configId = String(request.params.id || '').trim();
  if (!/^\d+$/.test(configId)) {
    response.status(400).json({ ok: false, error: '无效的配置 ID。' });
    return;
  }

  try {
    const row = await getSavedConfig(ctx.openId, configId);
    if (!row) {
      response.status(404).json({ ok: false, error: '配置不存在。' });
      return;
    }
    response.json({ ok: true, config: toApiConfig(row) });
  } catch (error) {
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * POST /api/configs
 * Save or update a config by configName (upsert).
 */
app.post('/api/configs', async (request, response) => {
  const ctx = await requireAuth(request, response);
  if (!ctx) return;

  const parsed = saveConfigSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      ok: false,
      error: parsed.error.issues[0]?.message || '请求参数不合法。',
    });
    return;
  }

  const payloadJson = JSON.stringify(parsed.data.payload);

  try {
    const row = await saveOrUpdateConfig({
      openId: ctx.openId,
      configName: parsed.data.configName,
      payloadJson,
    });
    response.json({
      ok: true,
      config: {
        id: row.id,
        configName: row.config_name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (error) {
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/configs/auto', async (request, response) => {
  const ctx = await requireAuth(request, response);
  if (!ctx) return;

  const templateUrl = String(request.query.templateUrl || '').trim();
  const tableId = String(request.query.tableId || '').trim();
  const docId = extractDocumentIdFromUrl(templateUrl);
  if (!docId) {
    response.status(400).json({ ok: false, error: '无效的模板链接。' });
    return;
  }

  try {
    const configName = buildTemplateConfigName(docId, tableId);
    const row = await getSavedConfigByName(ctx.openId, configName);
    if (!row) {
      response.json({ ok: true, found: false });
      return;
    }
    response.json({
      ok: true,
      found: true,
      config: toApiConfig(row),
    });
  } catch (error) {
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/configs/auto', async (request, response) => {
  const ctx = await requireAuth(request, response);
  if (!ctx) return;

  const body = request.body as { templateUrl?: string; tableId?: string; payload?: Record<string, unknown> };
  const templateUrl = String(body.templateUrl || '').trim();
  const tableId = String(body.tableId || '').trim();
  const docId = extractDocumentIdFromUrl(templateUrl);
  if (!docId) {
    response.status(400).json({ ok: false, error: '无效的模板链接。' });
    return;
  }

  const payload = body.payload || {};
  const payloadJson = JSON.stringify(payload);

  try {
    const row = await saveOrUpdateConfig({
      openId: ctx.openId,
      configName: buildTemplateConfigName(docId, tableId),
      payloadJson,
    });
    response.json({
      ok: true,
      config: {
        id: row.id,
        configName: row.config_name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (error) {
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    configured: hasCredential
  });
});

app.post('/api/template/variables', async (request, response) => {
  try {
    if (!feishuService) {
      response.status(500).json({
        ok: false,
        error: '服务未配置 FEISHU_APP_ID / FEISHU_APP_SECRET。'
      });
      return;
    }
    const ctx = await requireAuth(request, response);
    if (!ctx) return;

    const parsed = extractVariablesSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        ok: false,
        error: parsed.error.issues[0]?.message || '请求参数不合法。'
      });
      return;
    }
    const result = await extractTemplateVariablesByUserToken(parsed.data.templateUrl, ctx.accessToken);
    response.json({
      ok: true,
      ...result
    });
  } catch (error) {
    response.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get('/api/users/search', async (request, response) => {
  try {
    if (!feishuService) {
      response.status(500).json({
        ok: false,
        error: '服务未配置 FEISHU_APP_ID / FEISHU_APP_SECRET。'
      });
      return;
    }
    const parsed = searchUsersSchema.safeParse({
      q: request.query.q,
      limit: request.query.limit
    });
    if (!parsed.success) {
      response.status(400).json({
        ok: false,
        error: parsed.error.issues[0]?.message || '请求参数不合法。'
      });
      return;
    }
    const users = parsed.data.q
      ? await feishuService.searchUsers(parsed.data.q, parsed.data.limit)
      : await feishuService.getAllUsers(parsed.data.limit);
    response.json({
      ok: true,
      users
    });
  } catch (error) {
    response.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/api/documents/generate', async (request, response) => {
  try {
    if (!feishuService) {
      response.status(500).json({
        ok: false,
        error: '服务未配置 FEISHU_APP_ID / FEISHU_APP_SECRET。'
      });
      return;
    }
    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        ok: false,
        error: parsed.error.issues[0]?.message || '请求参数不合法。'
      });
      return;
    }

    const ctx = await requireAuth(request, response);
    if (!ctx) return;

    const payload: GenerateInput = {
      templateUrl: parsed.data.templateUrl,
      records: parsed.data.records,
      permissionMode: parsed.data.options?.permissionMode ?? 'internet_readable',
      ownerTransfer: parsed.data.options?.ownerTransfer ?? {
        memberType: 'openid',
        memberId: ctx.openId,
        needNotification: false,
        removeOldOwner: false,
        stayPut: false,
        oldOwnerPerm: 'full_access'
      },
      collaborators: parsed.data.options?.collaborators
    };
    const results = await feishuService.generateDocuments(payload);
    response.json({
      ok: true,
      results
    });
  } catch (error) {
    response.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(serverDir, '../../dist');
const indexHtml = path.join(distDir, 'index.html');

if (existsSync(indexHtml)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api(?:\/|$)).*/, (_request, response) => {
    response.sendFile(indexHtml);
  });
}

async function bootstrap(): Promise<void> {
  await initDatabase();
  app.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`Feishu template service started on http://${host}:${port}`);
  });
}

void bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Server bootstrap failed:', error);
  process.exit(1);
});
