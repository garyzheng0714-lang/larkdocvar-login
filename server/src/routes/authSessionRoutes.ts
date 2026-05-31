import type express from 'express';
import {
  peekSessionForRequest,
  resolveSessionTokenFromRequest,
} from '../auth';
import { deleteSessionByToken } from '../storage';
import { sendInternalError } from './routeErrors';

interface AuthSessionRouteOptions {
  cookieName: string;
  cookieSecure: boolean;
  cookieSameSite: express.CookieOptions['sameSite'];
  maxAgeSeconds: number;
}

export function registerAuthSessionRoutes(app: express.Express, options: AuthSessionRouteOptions): void {
  app.get('/api/auth/session', async (request, response) => {
    try {
      const peek = await peekSessionForRequest(request);
      if (!peek) {
        response.json({ ok: true, loggedIn: false });
        return;
      }

      response.cookie(options.cookieName, peek.sessionToken, {
        httpOnly: true,
        secure: options.cookieSecure,
        sameSite: options.cookieSameSite,
        maxAge: options.maxAgeSeconds * 1000,
        path: '/',
      });

      response.json({ ok: true, loggedIn: true, user: peek.profile });
    } catch (error) {
      sendInternalError(response, 'auth-session', error);
    }
  });

  app.post('/api/auth/logout', async (request, response) => {
    const sessionToken = resolveSessionTokenFromRequest(request);
    if (sessionToken) {
      await deleteSessionByToken(sessionToken).catch(() => undefined);
    }
    response.clearCookie(options.cookieName, {
      httpOnly: true,
      secure: options.cookieSecure,
      sameSite: options.cookieSameSite,
      path: '/',
    });
    response.json({ ok: true });
  });
}
