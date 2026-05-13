import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getFeishuAppCredentials,
  normalizeFeishuOAuthAppKey,
} from './auth';
import { buildFeishuOAuthRedirectUri } from './oauthRoutes';

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
