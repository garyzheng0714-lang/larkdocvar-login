import type express from 'express';
import { z } from 'zod';
import {
  getSavedConfig,
  getSavedConfigByName,
  listSavedConfigs,
  saveOrUpdateConfig,
  upsertUser,
} from '../storage';
import type { SavedConfigRow } from '../storage';
import { sendInternalError } from './routeErrors';

const ANONYMOUS_OPEN_ID = 'anonymous_sidebar_user';

const saveConfigSchema = z.object({
  configName: z.string().trim().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
});

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

async function getConfigOpenId(): Promise<string> {
  await upsertUser({
    openId: ANONYMOUS_OPEN_ID,
    name: '免登录侧边栏用户',
    enName: null,
    email: null,
    avatarUrl: null,
  });
  return ANONYMOUS_OPEN_ID;
}

export function registerSavedConfigRoutes(app: express.Express): void {
  app.get('/api/configs', async (request, response) => {
    try {
      const openId = await getConfigOpenId();
      const rows = await listSavedConfigs(openId);
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
      sendInternalError(response, 'list-configs', error);
    }
  });

  app.get('/api/templates/saved', async (request, response) => {
    try {
      const openId = await getConfigOpenId();
      const tableId = String(request.query.tableId || '').trim();
      const rows = await listSavedConfigs(openId);

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
      sendInternalError(response, 'list-saved-templates', error);
    }
  });

  app.get('/api/configs/auto', async (request, response) => {
    const templateUrl = String(request.query.templateUrl || '').trim();
    const tableId = String(request.query.tableId || '').trim();
    const docId = extractDocumentIdFromUrl(templateUrl);
    if (!docId) {
      response.status(400).json({ ok: false, error: '无效的模板链接。' });
      return;
    }

    try {
      const openId = await getConfigOpenId();
      const configName = buildTemplateConfigName(docId, tableId);
      const row = await getSavedConfigByName(openId, configName);
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
      sendInternalError(response, 'get-auto-config', error);
    }
  });

  app.post('/api/configs/auto', async (request, response) => {
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
      const openId = await getConfigOpenId();
      const row = await saveOrUpdateConfig({
        openId,
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
      sendInternalError(response, 'save-auto-config', error);
    }
  });

  app.get('/api/configs/:id', async (request, response) => {
    const configId = String(request.params.id || '').trim();
    if (!/^\d+$/.test(configId)) {
      response.status(400).json({ ok: false, error: '无效的配置 ID。' });
      return;
    }

    try {
      const openId = await getConfigOpenId();
      const row = await getSavedConfig(openId, configId);
      if (!row) {
        response.status(404).json({ ok: false, error: '配置不存在。' });
        return;
      }
      response.json({ ok: true, config: toApiConfig(row) });
    } catch (error) {
      sendInternalError(response, 'get-config', error);
    }
  });

  app.post('/api/configs', async (request, response) => {
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
      const openId = await getConfigOpenId();
      const row = await saveOrUpdateConfig({
        openId,
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
      sendInternalError(response, 'save-config', error);
    }
  });
}
