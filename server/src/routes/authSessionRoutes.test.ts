import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { registerAuthSessionRoutes } from './authSessionRoutes';

async function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  registerAuthSessionRoutes(app);
  app.use((_request, response) => {
    response.status(200).type('html').send('<!doctype html><title>SPA</title>');
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('/api/auth/session 未登录时返回稳定 JSON，不退化成 404 或静态页', async () => {
  const api = await startServer();
  try {
    const response = await fetch(`${api.baseUrl}/api/auth/session`);
    const body = await response.json() as { ok?: boolean; loggedIn?: boolean };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.loggedIn, false);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
  } finally {
    await api.close();
  }
});

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return run().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('有接管风险的 OAuth handoff 入口必须显式 410，不能被 SPA 静态兜底成 200', async () => {
  const api = await startServer();
  try {
    for (const path of [
      '/auth/feishu/fbif/anything/new',
      '/api/auth/feishu/fbif/start',
      '/api/auth/feishu/fbif/login-status',
    ]) {
      const response = await fetch(`${api.baseUrl}${path}`);
      const body = await response.json() as { ok?: boolean; error?: string };
      assert.equal(response.status, 410);
      assert.equal(body.ok, false);
      assert.match(body.error || '', /登录接力入口已停用/);
    }
  } finally {
    await api.close();
  }
});

test('旧 OAuth 未知 POST 子路径也必须显式 410', async () => {
  const api = await startServer();
  try {
    for (const path of [
      '/api/auth/feishu/fbif/unknown',
    ]) {
      const response = await fetch(`${api.baseUrl}${path}`, { method: 'POST' });
      const body = await response.json() as { ok?: boolean; error?: string };
      assert.equal(response.status, 410);
      assert.equal(body.ok, false);
      assert.match(body.error || '', /登录接力入口已停用/);
    }
  } finally {
    await api.close();
  }
});

test('飞书按钮登录入口是主路径，会跳转飞书 OAuth 并写入 state cookie', async () => {
  await withEnv({
    FEISHU_FBIF_APP_ID: 'cli_fbif',
    FEISHU_FBIF_APP_SECRET: 'fbif_secret',
    APP_PUBLIC_BASE_URL: 'https://fbif-sidebar-docgen.fbif.com',
    SESSION_COOKIE_SECURE: 'true',
  }, async () => {
    const api = await startServer();
    try {
      const response = await fetch(`${api.baseUrl}/auth/feishu/fbif/login`, { redirect: 'manual' });
      const location = response.headers.get('location') || '';
      const setCookie = response.headers.get('set-cookie') || '';

      assert.equal(response.status, 302);
      assert.match(location, /^https:\/\/accounts\.feishu\.cn\/open-apis\/authen\/v1\/authorize\?/);
      assert.match(location, /client_id=cli_fbif/);
      assert.match(location, /redirect_uri=https%3A%2F%2Ffbif-sidebar-docgen\.fbif\.com%2Fauth%2Ffeishu%2Ffbif%2Fcallback/);
      assert.doesNotMatch(location, /fbif_secret/);
      assert.match(setCookie, /feishu_state_fbif_oauth=/);
      assert.match(setCookie, /SameSite=None/i);
      assert.match(setCookie, /Secure/i);
    } finally {
      await api.close();
    }
  });
});

test('按钮回调用签名 state 校验，坏 state 只回前端可读错误，不落到静态页', async () => {
  await withEnv({
    FEISHU_FBIF_APP_ID: 'cli_fbif',
    FEISHU_FBIF_APP_SECRET: 'fbif_secret',
    APP_PUBLIC_BASE_URL: 'https://fbif-sidebar-docgen.fbif.com',
  }, async () => {
    const api = await startServer();
    try {
      const response = await fetch(
        `${api.baseUrl}/auth/feishu/fbif/callback?code=code&state=bad`,
        { redirect: 'manual' },
      );
      assert.equal(response.status, 302);
      assert.match(response.headers.get('location') || '', /auth_error=/);
    } finally {
      await api.close();
    }
  });
});

test('飞书客户端内免登配置只返回 app_id，不返回 app_secret 或 session token', async () => {
  await withEnv({
    FEISHU_FBIF_APP_ID: 'cli_fbif',
    FEISHU_FBIF_APP_SECRET: 'fbif_secret',
  }, async () => {
    const api = await startServer();
    try {
      const response = await fetch(`${api.baseUrl}/api/auth/feishu/fbif/client-config`);
      const body = await response.json() as {
        ok?: boolean;
        app_id?: string;
        app_secret?: string;
        session_token?: string;
      };

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.app_id, 'cli_fbif');
      assert.equal(body.app_secret, undefined);
      assert.equal(body.session_token, undefined);
      assert.match(response.headers.get('cache-control') || '', /no-store/);
    } finally {
      await api.close();
    }
  });
});

test('飞书客户端内免登 code 为空时直接拒绝', async () => {
  await withEnv({
    FEISHU_FBIF_APP_ID: 'cli_fbif',
    FEISHU_FBIF_APP_SECRET: 'fbif_secret',
  }, async () => {
    const api = await startServer();
    try {
      const response = await fetch(`${api.baseUrl}/api/auth/feishu/fbif/client-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '' }),
      });
      const body = await response.json() as { ok?: boolean; session_token?: string; error?: string };

      assert.equal(response.status, 400);
      assert.equal(body.ok, false);
      assert.equal(body.session_token, undefined);
      assert.match(body.error || '', /授权码无效/);
    } finally {
      await api.close();
    }
  });
});

test('飞书二维码配置返回 goto，不返回 session token', async () => {
  await withEnv({
    FEISHU_FBIF_APP_ID: 'cli_fbif',
    FEISHU_FBIF_APP_SECRET: 'fbif_secret',
    APP_PUBLIC_BASE_URL: 'https://fbif-sidebar-docgen.fbif.com',
  }, async () => {
    const api = await startServer();
    try {
      const response = await fetch(`${api.baseUrl}/auth/feishu/fbif/qr-config`);
      const body = await response.json() as { ok?: boolean; goto?: string; session_token?: string };

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.match(body.goto || '', /^https:\/\/passport\.feishu\.cn\/suite\/passport\/oauth\/authorize\?/);
      assert.match(body.goto || '', /redirect_uri=/);
      assert.equal(body.session_token, undefined);
    } finally {
      await api.close();
    }
  });
});

test('登录接口不会把用户 access token 暴露给前端', async () => {
  const source = await readFile(new URL('./authSessionRoutes.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('user_access_token'), false);
  const profileStart = source.indexOf('profile: {');
  const profileEnd = source.indexOf('},', profileStart);
  assert.notEqual(profileStart, -1);
  assert.notEqual(profileEnd, -1);
  const profileBlock = source.slice(profileStart, profileEnd);
  assert.doesNotMatch(profileBlock, /accessToken|refreshToken|user_access_token/);
});
