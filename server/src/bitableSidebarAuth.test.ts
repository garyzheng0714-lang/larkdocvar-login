import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import test from 'node:test';
import { createBitableSidebarAuthGuard } from './bitableSidebarAuth';
import type { BitableSidebarCredential } from './bitableSidebarAuth';

async function startServer(validate: (credential: BitableSidebarCredential) => boolean | Promise<boolean>): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(createBitableSidebarAuthGuard(validate));
  app.post('/protected', (_request, response) => response.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('飞书云文档生成接口要求真实侧边栏 Base 凭据', async () => {
  const api = await startServer(async () => true);
  try {
    const response = await fetch(`${api.baseUrl}/protected`, { method: 'POST' });
    const body = await response.json() as { error?: string };
    assert.equal(response.status, 401);
    assert.match(body.error || '', /飞书多维表格侧边栏/);
  } finally {
    await api.close();
  }
});

test('侧边栏 Base 凭据会交给服务端验证', async () => {
  const seen: BitableSidebarCredential[] = [];
  const api = await startServer(async (credential) => {
    seen.push(credential);
    return credential.baseId === 'bascn_demo' && credential.tableId === 'tbl_demo';
  });
  try {
    const denied = await fetch(`${api.baseUrl}/protected`, {
      method: 'POST',
      headers: {
        'x-bitable-base-id': 'bascn_demo',
        'x-bitable-table-id': 'tbl_bad',
      },
    });
    assert.equal(denied.status, 403);

    const allowed = await fetch(`${api.baseUrl}/protected`, {
      method: 'POST',
      headers: {
        'x-bitable-base-id': 'bascn_demo',
        'x-bitable-table-id': 'tbl_demo',
        'x-bitable-base-user-id': 'u_demo',
        'x-bitable-tenant-key': 'tenant_demo',
      },
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(seen[1], {
      baseId: 'bascn_demo',
      tableId: 'tbl_demo',
      baseUserId: 'u_demo',
      tenantKey: 'tenant_demo',
    });
  } finally {
    await api.close();
  }
});
