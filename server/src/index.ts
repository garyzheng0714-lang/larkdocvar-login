import './env';
import cors, { CorsOptions } from 'cors';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMutationOriginGuard } from './browserOriginGuard';
import { createCloudDocAccessGuard } from './cloudDocAccessGuard';
import { createDocumentRenderRouter } from './documentRenderApi';
import { requireDocumentRenderApiKey } from './documentRenderApiKeyGuard';
import { createDocumentRenderBatchRouter } from './documentRenderBatchApi';
import { createDocumentRenderJobRouter } from './documentRenderJobApi';
import { createDocumentTemplateRouter, type DocumentTemplateApiService } from './documentTemplateApi';
import { DocumentTemplateService } from './documentTemplateService';
import { FeishuTemplateService } from './feishu';
import { getFeishuAppCredentials } from './auth';
import { initDatabase, closeDatabase } from './storage';
import { runConfigSelfCheck, assertConfigOrExit } from './configSelfCheck';
import { registerCloudDocRoutes } from './routes/cloudDocRoutes';
import { registerAuthSessionRoutes } from './routes/authSessionRoutes';
import { registerHealthRoutes } from './routes/healthRoutes';
import { registerSavedConfigRoutes } from './routes/savedConfigRoutes';

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const fbifCredentials = getFeishuAppCredentials('fbif');
const appId = fbifCredentials.appId;
const appSecret = fbifCredentials.appSecret;

const hasCredential = Boolean(appId && appSecret);
const hasDatabaseUrl = Boolean((process.env.DATABASE_URL || '').trim());

let documentTemplateServiceInstance: DocumentTemplateService | null = null;
function getDocumentTemplateService(): DocumentTemplateService {
  if (!documentTemplateServiceInstance) {
    documentTemplateServiceInstance = new DocumentTemplateService();
  }
  return documentTemplateServiceInstance;
}

const documentTemplateService = {
  listTemplates: (...args: Parameters<DocumentTemplateService['listTemplates']>) => getDocumentTemplateService().listTemplates(...args),
  createTemplate: (...args: Parameters<DocumentTemplateService['createTemplate']>) => getDocumentTemplateService().createTemplate(...args),
  addVersion: (...args: Parameters<DocumentTemplateService['addVersion']>) => getDocumentTemplateService().addVersion(...args),
  updateTemplateMetadata: (...args: Parameters<DocumentTemplateService['updateTemplateMetadata']>) => getDocumentTemplateService().updateTemplateMetadata(...args),
  getTemplate: (...args: Parameters<DocumentTemplateService['getTemplate']>) => getDocumentTemplateService().getTemplate(...args),
  loadTemplate: (...args: Parameters<DocumentTemplateService['loadTemplate']>) => getDocumentTemplateService().loadTemplate(...args),
  deleteTemplate: (...args: Parameters<DocumentTemplateService['deleteTemplate']>) => getDocumentTemplateService().deleteTemplate(...args),
} satisfies DocumentTemplateApiService;

const feishuService = hasCredential
  ? new FeishuTemplateService({
      appId,
      appSecret,
    })
  : null;

function buildAllowedCorsOrigins(): Set<string> {
  const origins = new Set(
    (process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  const postLoginUrl = process.env.FRONTEND_POST_LOGIN_URL || '';
  try {
    if (postLoginUrl.startsWith('http://') || postLoginUrl.startsWith('https://')) {
      origins.add(new URL(postLoginUrl).origin);
    }
  } catch {
    // Ignore invalid optional frontend URLs; same-origin requests do not need CORS.
  }

  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
  }

  return origins;
}

const corsAllowedOrigins = buildAllowedCorsOrigins();
const corsOptions: CorsOptions = {
  credentials: true,
  exposedHeaders: ['X-Session-Token'],
  origin(origin, callback) {
    if (!origin || corsAllowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
};

const enforceMutationOrigin = createMutationOriginGuard({
  allowedOrigins: corsAllowedOrigins,
});
const enforceDocumentRenderBrowserOrigin = createMutationOriginGuard({
  allowedOrigins: corsAllowedOrigins,
  requireOriginOrReferer: false,
});
const requireCloudDocAccess = createCloudDocAccessGuard();

if (feishuService) {
  // Prewarm the user directory cache asynchronously so the search works fast on first attempt.
  setTimeout(() => {
    feishuService.prewarmDirectoryCache();
  }, 1000);
}

app.use(cors(corsOptions));
registerAuthSessionRoutes(app);
app.use('/api/v1/document-templates', enforceDocumentRenderBrowserOrigin, requireDocumentRenderApiKey, createDocumentTemplateRouter(documentTemplateService, { enforceOwnership: true }));
app.use('/api/v1/document-render-jobs', enforceDocumentRenderBrowserOrigin, requireDocumentRenderApiKey, createDocumentRenderJobRouter({ templateResolver: documentTemplateService }));
app.use('/api/v1/document-renders', enforceDocumentRenderBrowserOrigin, requireDocumentRenderApiKey, createDocumentRenderBatchRouter({ templateResolver: documentTemplateService }));
app.use('/api/v1/document-renders', enforceDocumentRenderBrowserOrigin, requireDocumentRenderApiKey, createDocumentRenderRouter({ templateResolver: documentTemplateService }));
app.use(enforceMutationOrigin);
app.use(express.json({ limit: '2mb' }));

registerSavedConfigRoutes(app);
registerHealthRoutes(app, { hasCredential, hasDatabaseUrl });
registerCloudDocRoutes(app, { feishuService, requireCloudDocAccess });

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(serverDir, '../../dist');
const indexHtml = path.join(distDir, 'index.html');

if (existsSync(indexHtml)) {
  const assetsDir = path.join(distDir, 'assets');
  app.use(express.static(distDir, {
    setHeaders(response, filePath) {
      if (path.basename(filePath) === 'index.html') {
        response.setHeader('Cache-Control', 'no-cache');
        return;
      }
      if (filePath.startsWith(`${assetsDir}${path.sep}`)) {
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return;
      }
      response.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get(/^\/(?!api(?:\/|$)).*/, (_request, response) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile(indexHtml);
  });
}

// 全局错误兜底（必须挂在所有路由之后）：请求管线里任何未被路由自身接住的错误——尤其是全局
// express.json 对坏 JSON 抛的 SyntaxError、handler 里漏 catch 的 TypeError——都在此收敛成稳定 JSON。
// 绝不把 Express 默认 HTML 错误页或堆栈暴露给调用方（会破坏"业务系统调用"的 JSON 契约、开发模式还泄漏堆栈）。
const globalErrorHandler: express.ErrorRequestHandler = (error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  const headerRequestId = request.headers['x-request-id'];
  const rawRequestId = Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId;
  const requestId = typeof rawRequestId === 'string' && rawRequestId.trim() ? rawRequestId.trim().slice(0, 128) : randomUUID();
  const status = typeof error?.status === 'number' ? error.status : (typeof error?.statusCode === 'number' ? error.statusCode : 0);
  if (status === 413 || error?.type === 'entity.too.large') {
    response.status(413).json({ ok: false, requestId, error: '请求体过大，请减少请求内容后重试。' });
    return;
  }
  if (status === 400 || error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    response.status(400).json({ ok: false, requestId, error: '请求参数不合法。' });
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[unhandled-route-error]', error instanceof Error ? (error.stack || error.message) : String(error));
  response.status(500).json({ ok: false, requestId, error: '服务暂时不可用，请稍后重试。' });
};
app.use(globalErrorHandler);

// 进程级最后防线：请求路径外的漏网错误（第三方库 emit、fire-and-forget 忘 catch）不能无声无息。
// uncaughtException 后进程状态已不可信，记录完整堆栈后退出，交给容器编排（restart: unless-stopped）拉起干净实例。
// unhandledRejection 多为可恢复的边缘遗漏，记录堆栈但不退出，避免单个漏 catch 拖垮整个服务。
process.on('uncaughtException', (error) => {
  // eslint-disable-next-line no-console
  console.error('[fatal] uncaughtException，进程即将退出：', error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[warn] unhandledRejection（已记录，进程继续）：', reason instanceof Error ? reason.stack || reason.message : String(reason));
});

async function bootstrap(): Promise<void> {
  assertConfigOrExit(runConfigSelfCheck());
  if (process.env.NODE_ENV === 'production' || hasDatabaseUrl) {
    await initDatabase();
  }
  const server = app.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`Feishu template service started on http://${host}:${port}`);
  });
  // 显式设置连接层超时：keepAliveTimeout 略大于常见 nginx/SLB 的 60s idle，避免 keep-alive 竞态偶发 502；
  // headersTimeout 必须 > keepAliveTimeout；requestTimeout 挡住慢客户端长期占连接（沿用 Node 默认 5 分钟）。
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 300_000;

  // 优雅关闭：docker stop / 部署会发 SIGTERM。停止接新连接、放行在途请求、关闭 DB 池后再退出；
  // 若在途请求 25s 内没排空则强制退出，避免卡死编排。
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[shutdown] 收到 ${signal}，开始优雅关闭…`);
    const forceExit = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('[shutdown] 在途请求未在 25s 内排空，强制退出');
      process.exit(1);
    }, 25_000);
    if (typeof forceExit.unref === 'function') forceExit.unref();
    server.close(() => {
      void closeDatabase().finally(() => {
        // eslint-disable-next-line no-console
        console.log('[shutdown] 已排空并关闭，正常退出');
        process.exit(0);
      });
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Server bootstrap failed:', error);
  process.exit(1);
});
