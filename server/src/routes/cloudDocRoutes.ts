import type express from 'express';
import { z } from 'zod';
import type { FeishuTemplateService, GenerateInput } from '../feishu';
import { sendFeishuTemplateError, sendInternalError } from './routeErrors';

const GENERATE_RECORD_BATCH_LIMIT = 10;
const GENERATE_IMAGE_URL_LIMIT_PER_VARIABLE = 5;

const extractVariablesSchema = z.object({
  templateUrl: z.string().trim().min(1),
});

const searchUsersSchema = z.object({
  q: z.string().trim().default(''),
  limit: z.coerce.number().int().min(1).max(200).default(200),
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
            urls: z.array(z.string().min(1)).min(1).max(GENERATE_IMAGE_URL_LIMIT_PER_VARIABLE),
            width: z.number().int().min(0).max(2000).default(400),
          }),
        ).optional(),
        title: z.string().max(255).optional(),
      }),
    )
    .min(1)
    .max(GENERATE_RECORD_BATCH_LIMIT),
  options: z
    .object({
      permissionMode: z.enum(['tenant_readable', 'tenant_editable', 'closed']).optional(),
      ownerTransfer: z
        .object({
          memberType: z.enum(['userid', 'openid', 'email']),
          memberId: z.string().trim().min(1),
          needNotification: z.boolean().optional(),
          removeOldOwner: z.boolean().optional(),
          stayPut: z.boolean().optional(),
          oldOwnerPerm: z.enum(['view', 'edit', 'full_access']).optional(),
        })
        .optional(),
      ownerTransferEnabled: z.boolean().optional(),
      collaborators: z.array(
        z.object({
          memberType: z.enum(['openid', 'email', 'userid']),
          memberId: z.string().trim().min(1),
          perm: z.enum(['view', 'edit', 'full_access']),
        }),
      ).max(50).optional(),
    })
    .optional(),
});

interface CloudDocRouteOptions {
  feishuService: FeishuTemplateService | null;
  requireCloudDocAccess: express.RequestHandler;
}

export function registerCloudDocRoutes(app: express.Express, options: CloudDocRouteOptions): void {
  app.post('/api/template/variables', options.requireCloudDocAccess, async (request, response) => {
    try {
      if (!options.feishuService) {
        response.status(500).json({
          ok: false,
          error: '服务未配置 FEISHU_APP_ID / FEISHU_APP_SECRET。',
        });
        return;
      }
      const parsed = extractVariablesSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({
          ok: false,
          error: parsed.error.issues[0]?.message || '请求参数不合法。',
        });
        return;
      }
      const result = await options.feishuService.extractTemplateVariables(parsed.data.templateUrl);
      response.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      sendFeishuTemplateError(response, 'extract-template-variables', error);
    }
  });

  app.get('/api/users/search', options.requireCloudDocAccess, async (request, response) => {
    try {
      if (!options.feishuService) {
        response.status(500).json({
          ok: false,
          error: '服务未配置 FEISHU_APP_ID / FEISHU_APP_SECRET。',
        });
        return;
      }
      const parsed = searchUsersSchema.safeParse({
        q: request.query.q,
        limit: request.query.limit,
      });
      if (!parsed.success) {
        response.status(400).json({
          ok: false,
          error: parsed.error.issues[0]?.message || '请求参数不合法。',
        });
        return;
      }
      const users = parsed.data.q
        ? await options.feishuService.searchUsers(parsed.data.q, parsed.data.limit)
        : await options.feishuService.getAllUsers(parsed.data.limit);
      response.json({
        ok: true,
        users,
      });
    } catch (error) {
      sendInternalError(response, 'search-users', error);
    }
  });

  app.post('/api/documents/generate', options.requireCloudDocAccess, async (request, response) => {
    try {
      if (!options.feishuService) {
        response.status(500).json({
          ok: false,
          error: '服务未配置 FEISHU_APP_ID / FEISHU_APP_SECRET。',
        });
        return;
      }
      const parsed = generateSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({
          ok: false,
          error: parsed.error.issues[0]?.message || '请求参数不合法。',
        });
        return;
      }

      const payload: GenerateInput = {
        templateUrl: parsed.data.templateUrl,
        records: parsed.data.records,
        permissionMode: parsed.data.options?.permissionMode ?? 'tenant_readable',
        ownerTransfer: parsed.data.options?.ownerTransferEnabled ? parsed.data.options.ownerTransfer : undefined,
        collaborators: parsed.data.options?.collaborators,
      };
      const results = await options.feishuService.generateDocuments(payload);
      response.json({
        ok: true,
        results,
      });
    } catch (error) {
      sendFeishuTemplateError(response, 'generate-documents', error);
    }
  });
}
