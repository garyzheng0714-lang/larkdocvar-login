import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';

import {
  getFeishuAppCredentials,
  normalizeFeishuOAuthAppKey,
} from './auth';
import {
  buildFeishuOAuthRedirectUri,
  buildFrontendLoginErrorRedirectUrl,
  createSignedOAuthState,
  registerOAuthRoutes,
  verifySignedOAuthState,
} from './oauthRoutes';

const ENV_KEYS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_FBIF_APP_ID',
  'FEISHU_FBIF_APP_SECRET',
  'FEISHU_FUDE_APP_ID',
  'FEISHU_FUDE_APP_SECRET',
  'FEISHU_REDIRECT_BASE',
  'FEISHU_FBIF_OAUTH_REDIRECT_URI',
  'FEISHU_FBIF_QR_REDIRECT_URI',
  'FEISHU_FUDE_OAUTH_REDIRECT_URI',
  'FEISHU_FUDE_QR_REDIRECT_URI',
  'FRONTEND_POST_LOGIN_URL',
  'OAUTH_STATE_SIGNING_SECRET',
] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withEnvAsync<T>(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withTestServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    assert.ok(address);
    return await run(`http://127.0.0.1:${(address as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('飞书 OAuth 应用配置按入口选择凭证，FBIF 保留旧变量兼容', () => {
  withEnv({
    FEISHU_APP_ID: 'legacy_fbif_id',
    FEISHU_APP_SECRET: 'legacy_fbif_secret',
    FEISHU_FUDE_APP_ID: 'fude_id',
    FEISHU_FUDE_APP_SECRET: 'fude_secret',
  }, () => {
    assert.equal(normalizeFeishuOAuthAppKey('fbif'), 'fbif');
    assert.equal(normalizeFeishuOAuthAppKey('fude'), 'fude');
    assert.equal(normalizeFeishuOAuthAppKey('other'), null);
    assert.deepEqual(getFeishuAppCredentials('fbif'), {
      appKey: 'fbif',
      appId: 'legacy_fbif_id',
      appSecret: 'legacy_fbif_secret',
    });
    assert.deepEqual(getFeishuAppCredentials('fude'), {
      appKey: 'fude',
      appId: 'fude_id',
      appSecret: 'fude_secret',
    });
  });
});

test('飞书 OAuth 回调地址使用新域名路径生成并支持单应用覆盖', () => {
  withEnv({
    FEISHU_REDIRECT_BASE: 'https://fbif-sidebar-docgen.fbif.com/',
    FEISHU_FUDE_QR_REDIRECT_URI: 'https://custom.example.com/fude/qr',
  }, () => {
    assert.equal(
      buildFeishuOAuthRedirectUri('fbif', 'button'),
      'https://fbif-sidebar-docgen.fbif.com/auth/feishu/fbif/callback',
    );
    assert.equal(
      buildFeishuOAuthRedirectUri('fbif', 'qr'),
      'https://fbif-sidebar-docgen.fbif.com/auth/feishu/fbif/qr-callback',
    );
    assert.equal(
      buildFeishuOAuthRedirectUri('fude', 'button'),
      'https://fbif-sidebar-docgen.fbif.com/auth/feishu/fude/callback',
    );
    assert.equal(
      buildFeishuOAuthRedirectUri('fude', 'qr'),
      'https://custom.example.com/fude/qr',
    );
  });
});

test('登录失败回跳前端登录页并携带可读错误，不暴露 JSON 回调响应', () => {
  withEnv({
    FRONTEND_POST_LOGIN_URL: 'https://fbif-sidebar-docgen.fbif.com/?from=sidebar',
  }, () => {
    const redirectUrl = buildFrontendLoginErrorRedirectUrl('登录状态已失效，请重新点击登录。', 'fbif');
    const url = new URL(redirectUrl);

    assert.equal(url.origin, 'https://fbif-sidebar-docgen.fbif.com');
    assert.equal(url.searchParams.get('from'), 'sidebar');
    assert.equal(url.searchParams.get('auth_error'), '登录状态已失效，请重新点击登录。');
    assert.equal(url.searchParams.get('auth_org'), 'fbif');
  });
});

test('OAuth 回调 state 失效时返回 302 到前端，不把错误文本留在 iframe', async () => {
  await withEnvAsync({
    FRONTEND_POST_LOGIN_URL: 'https://fbif-sidebar-docgen.fbif.com/',
  }, async () => {
    const app = express();
    registerOAuthRoutes(app);

    await withTestServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/feishu/fbif/callback?code=fake&state=missing`, {
        redirect: 'manual',
      });
      const location = response.headers.get('location') || '';
      const redirectUrl = new URL(location);

      assert.equal(response.status, 302);
      assert.equal(redirectUrl.origin, 'https://fbif-sidebar-docgen.fbif.com');
      assert.equal(redirectUrl.searchParams.get('auth_error'), '登录状态已失效，请重新点击登录。');
      assert.notEqual(response.headers.get('content-type'), 'application/json; charset=utf-8');
    });
  });
});

test('OAuth state 不依赖浏览器 cookie，签名 state 可独立通过校验', () => {
  withEnv({
    OAUTH_STATE_SIGNING_SECRET: 'test-state-secret',
  }, () => {
    const config = {
      appKey: 'fbif' as const,
      appId: 'cli_test',
      appSecret: 'app_secret',
      redirectUri: 'https://fbif-sidebar-docgen.fbif.com/auth/feishu/fbif/callback',
      qrRedirectUri: 'https://fbif-sidebar-docgen.fbif.com/auth/feishu/fbif/qr-callback',
      scope: 'contact:user.base:readonly',
    };
    const state = createSignedOAuthState(config, 'button');

    assert.equal(verifySignedOAuthState(state, config, 'button'), true);
    assert.equal(verifySignedOAuthState(state, config, 'qr'), false);
    assert.equal(
      verifySignedOAuthState(state.replace(/\.[^.]+$/, '.tampered'), config, 'button'),
      false,
    );
  });
});
