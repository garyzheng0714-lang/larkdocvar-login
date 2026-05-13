import assert from 'node:assert/strict';
import test from 'node:test';

import {
  consumeOAuthStateCookie,
  getOAuthStateCookieOptions,
  setOAuthStateCookie,
} from './auth';

const ENV_KEYS = [
  'SESSION_COOKIE_SECURE',
  'SESSION_COOKIE_SAMESITE',
  'OAUTH_STATE_COOKIE_SAMESITE',
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

test('正式环境 OAuth state cookie 使用嵌入式侧边栏可回传的 SameSite=None', () => {
  withEnv({ SESSION_COOKIE_SECURE: 'true', SESSION_COOKIE_SAMESITE: 'lax' }, () => {
    assert.deepEqual(getOAuthStateCookieOptions(), {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
      maxAge: 600000,
    });
  });
});

test('非 HTTPS 本地环境不会写出浏览器会拒收的 SameSite=None cookie', () => {
  withEnv({ SESSION_COOKIE_SECURE: 'false', SESSION_COOKIE_SAMESITE: 'none' }, () => {
    assert.equal(getOAuthStateCookieOptions().sameSite, 'lax');
    assert.equal(getOAuthStateCookieOptions().secure, false);
  });
});

test('OAuth state cookie 设置和清理使用同一组关键属性', () => {
  withEnv({ SESSION_COOKIE_SECURE: 'true' }, () => {
    const cookieCalls: Array<{ name: string; value: string; options: unknown }> = [];
    const clearCalls: Array<{ name: string; options: unknown }> = [];
    const response = {
      cookie(name: string, value: string, options: unknown) {
        cookieCalls.push({ name, value, options });
      },
      clearCookie(name: string, options: unknown) {
        clearCalls.push({ name, options });
      },
    };

    setOAuthStateCookie(response as never, 'feishu_qr_state_fbif', 'abc');
    const ok = consumeOAuthStateCookie(
      { headers: { cookie: 'feishu_qr_state_fbif=abc' } } as never,
      response as never,
      'feishu_qr_state_fbif',
      'abc',
    );

    assert.equal(ok, true);
    assert.deepEqual(cookieCalls[0], {
      name: 'feishu_qr_state_fbif',
      value: 'abc',
      options: {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
        maxAge: 600000,
      },
    });
    assert.deepEqual(clearCalls[0], {
      name: 'feishu_qr_state_fbif',
      options: {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
      },
    });
  });
});
