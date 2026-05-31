import type express from 'express';
import { checkDatabaseReady } from '../storage';

interface HealthRouteOptions {
  hasCredential: boolean;
  hasDatabaseUrl: boolean;
}

export function registerHealthRoutes(app: express.Express, options: HealthRouteOptions): void {
  app.get('/api/health', async (_request, response) => {
    let databaseReady = false;
    let missingTables: string[] = [];

    if (options.hasDatabaseUrl) {
      try {
        const readiness = await checkDatabaseReady();
        databaseReady = readiness.ready;
        missingTables = readiness.missingTables;
      } catch (error) {
        console.error('[health] database readiness check failed:', error instanceof Error ? error.message : String(error));
      }
    }

    if (options.hasDatabaseUrl && !databaseReady) {
      response.status(500).json({
        ok: false,
        configured: options.hasCredential,
        databaseConfigured: options.hasDatabaseUrl,
        databaseReady,
        missingTables,
      });
      return;
    }

    response.json({
      ok: true,
      configured: options.hasCredential,
      databaseConfigured: options.hasDatabaseUrl,
      databaseReady,
    });
  });
}
