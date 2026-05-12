import dotenv from 'dotenv';

export const PROJECT_ENV_PATHS = ['.env.local', '.env'];

export function loadProjectEnv(options: {
  paths?: string[];
  processEnv?: NodeJS.ProcessEnv;
} = {}): void {
  dotenv.config({
    path: options.paths || PROJECT_ENV_PATHS,
    processEnv: options.processEnv || process.env,
    quiet: true,
  });
}

if (process.env.DOCUMENT_RENDER_SKIP_PROJECT_ENV !== 'true') {
  loadProjectEnv();
}
