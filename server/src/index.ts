import './env';
import cors, { CorsOptions } from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBitableSidebarAuthGuard } from './bitableSidebarAuth';
import { createMutationOriginGuard } from './browserOriginGuard';
import { createDocumentRenderRouter } from './documentRenderApi';
import { requireDocumentRenderApiKey } from './documentRenderApiKeyGuard';
import { createDocumentRenderBatchRouter } from './documentRenderBatchApi';
import { createDocumentRenderJobRouter } from './documentRenderJobApi';
import { createDocumentTemplateRouter } from './documentTemplateApi';
import { DocumentTemplateService } from './documentTemplateService';
import { FeishuTemplateService } from './feishu';
import { getFeishuAppCredentials, peekSessionForRequest } from './auth';
import { registerOAuthRoutes } from './oauthRoutes';
import { initDatabase } from './storage';
import { registerAuthSessionRoutes } from './routes/authSessionRoutes';
import { registerCloudDocRoutes } from './routes/cloudDocRoutes';
import { registerHealthRoutes } from './routes/healthRoutes';
import { registerPluginLoginRoutes } from './routes/pluginLoginRoutes';
import { registerSavedConfigRoutes } from './routes/savedConfigRoutes';

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const fbifCredentials = getFeishuAppCredentials('fbif');
const appId = fbifCredentials.appId;
const appSecret = fbifCredentials.appSecret;

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'larkdocvar_session';
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === 'true';
const SESSION_MAX_AGE_SECONDS = Number(process.env.SESSION_MAX_AGE_SECONDS || 604800);
const SESSION_COOKIE_SAMESITE_RAW = (process.env.SESSION_COOKIE_SAMESITE || (SESSION_COOKIE_SECURE ? 'none' : 'lax')).toLowerCase();
const SESSION_COOKIE_SAMESITE: express.CookieOptions['sameSite'] =
  SESSION_COOKIE_SAMESITE_RAW === 'strict' || SESSION_COOKIE_SAMESITE_RAW === 'none'
    ? SESSION_COOKIE_SAMESITE_RAW
    : 'lax';

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
  getTemplate: (...args: Parameters<DocumentTemplateService['getTemplate']>) => getDocumentTemplateService().getTemplate(...args),
  loadTemplate: (...args: Parameters<DocumentTemplateService['loadTemplate']>) => getDocumentTemplateService().loadTemplate(...args),
  deleteTemplate: (...args: Parameters<DocumentTemplateService['deleteTemplate']>) => getDocumentTemplateService().deleteTemplate(...args),
} as DocumentTemplateService;

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
const requireBitableSidebarAuth = createBitableSidebarAuthGuard();
const requireBitableSidebarLogin = createBitableSidebarAuthGuard();
const requireCloudDocAccess: express.RequestHandler = async (request, response, next) => {
  try {
    const session = await peekSessionForRequest(request);
    if (session) {
      next();
      return;
    }
  } catch {
    // Fall through to the sidebar credential path. A broken cookie must not
    // block the no-manual-login path in the Feishu sidebar.
  }
  return requireBitableSidebarAuth(request, response, next);
};

if (feishuService) {
  // Prewarm the user directory cache asynchronously so the search works fast on first attempt.
  setTimeout(() => {
    feishuService.prewarmDirectoryCache();
  }, 1000);
}

app.use(cors(corsOptions));
app.use('/api/v1/document-templates', enforceDocumentRenderBrowserOrigin, requireDocumentRenderApiKey, createDocumentTemplateRouter(documentTemplateService, { enforceOwnership: true }));
app.use('/api/v1/document-render-jobs', enforceDocumentRenderBrowserOrigin, requireDocumentRenderApiKey, createDocumentRenderJobRouter({ templateResolver: documentTemplateService }));
app.use('/api/v1/document-renders', enforceDocumentRenderBrowserOrigin, requireDocumentRenderApiKey, createDocumentRenderBatchRouter({ templateResolver: documentTemplateService }));
app.use('/api/v1/document-renders', enforceDocumentRenderBrowserOrigin, requireDocumentRenderApiKey, createDocumentRenderRouter({ templateResolver: documentTemplateService }));
app.use(enforceMutationOrigin);
app.use(express.json({ limit: '2mb' }));

registerOAuthRoutes(app);
registerAuthSessionRoutes(app, {
  cookieName: SESSION_COOKIE_NAME,
  cookieSecure: SESSION_COOKIE_SECURE,
  cookieSameSite: SESSION_COOKIE_SAMESITE,
  maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
});
registerPluginLoginRoutes(app, {
  cookieName: SESSION_COOKIE_NAME,
  cookieSecure: SESSION_COOKIE_SECURE,
  cookieSameSite: SESSION_COOKIE_SAMESITE,
  maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
  requireBitableSidebarAuth: requireBitableSidebarLogin,
});
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

async function bootstrap(): Promise<void> {
  if (process.env.NODE_ENV === 'production' || hasDatabaseUrl) {
    await initDatabase();
  }
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
