import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBitablePluginLoginRequest,
  getBitableSidebarLoginDiagnostics,
  loginWithBitableSidebar,
} from './bitableSidebarLogin';

test('侧边栏直登请求必须带 Base 和表格凭据，避免普通网页伪装登录', () => {
  const request = buildBitablePluginLoginRequest({
    openId: 'ou_user',
    selection: { baseId: 'bascn_demo', tableId: 'tbl_demo' },
    baseUserId: 'u_demo',
    tenantKey: 'tenant_demo',
  });

  assert.equal(request.headers['X-Bitable-Base-Id'], 'bascn_demo');
  assert.equal(request.headers['X-Bitable-Table-Id'], 'tbl_demo');
  assert.equal(request.headers['X-Bitable-Base-User-Id'], 'u_demo');
  assert.equal(request.headers['X-Bitable-Tenant-Key'], 'tenant_demo');
  assert.equal(request.body, JSON.stringify({ open_id: 'ou_user' }));
});

test('缺少真实侧边栏上下文时不发起 plugin-login', () => {
  assert.throws(
    () => buildBitablePluginLoginRequest({
      openId: 'ou_user',
      selection: { baseId: 'bascn_demo' },
    }),
    /飞书多维表格侧边栏/,
  );
});

test('选区缺少 tableId 时使用当前活动表兜底，避免侧边栏初始化时误入扫码', async () => {
  const calls: RequestInit[] = [];
  await loginWithBitableSidebar({
    timeoutMs: 1000,
    sdk: {
      bridge: {
        async getUserId() { return 'ou_user'; },
        async getBaseUserId() { return 'u_demo'; },
        async getTenantKey() { return 'tenant_demo'; },
      },
      base: {
        async getSelection() { return { baseId: 'bascn_demo', tableId: null }; },
        async getActiveTable() { return { id: 'tbl_active' }; },
      },
    },
    fetchImpl: (async (_url, init) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({
        ok: true,
        session_token: 'session_demo',
        user: { open_id: 'ou_user', name: '测试用户', avatar_url: null },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  });

  const headers = calls[0]?.headers as Record<string, string>;
  assert.equal(headers['X-Bitable-Table-Id'], 'tbl_active');
});

test('侧边栏直登成功后返回 session token 和用户资料', async () => {
  const calls: unknown[] = [];
  const result = await loginWithBitableSidebar({
    timeoutMs: 1000,
    sdk: {
      bridge: {
        async getUserId() { return 'ou_user'; },
        async getBaseUserId() { return 'u_demo'; },
        async getTenantKey() { return 'tenant_demo'; },
      },
      base: {
        async getSelection() { return { baseId: 'bascn_demo', tableId: 'tbl_demo' }; },
      },
    },
    fetchImpl: (async (_url, init) => {
      calls.push(init);
      return new Response(JSON.stringify({
        ok: true,
        session_token: 'session_demo',
        user: { open_id: 'ou_user', name: '测试用户', avatar_url: null },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  });

  assert.equal(result.sessionToken, 'session_demo');
  assert.equal(result.user.name, '测试用户');
  assert.equal(calls.length, 1);
});

test('侧边栏直登失败时暴露阶段诊断，避免继续静默退回扫码', async () => {
  await assert.rejects(
    () => loginWithBitableSidebar({
      timeoutMs: 1000,
      sdk: {
        bridge: {
          async getUserId() { return 'ou_user'; },
          async getBaseUserId() { return 'u_demo'; },
          async getTenantKey() { return 'tenant_demo'; },
        },
        base: {
          async getSelection() { return { baseId: 'bascn_demo', tableId: 'tbl_demo' }; },
        },
      },
      fetchImpl: (async () => new Response(JSON.stringify({
        ok: false,
        error: 'user_not_found_in_tenant',
      }), { status: 403, headers: { 'Content-Type': 'application/json' } })) as typeof fetch,
    }),
    (error) => {
      const diagnostics = getBitableSidebarLoginDiagnostics(error);
      assert.equal(diagnostics.stage, 'plugin_login_rejected');
      assert.equal(diagnostics.responseStatus, 403);
      assert.equal(diagnostics.responseError, 'user_not_found_in_tenant');
      return true;
    },
  );
});
