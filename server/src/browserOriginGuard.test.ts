import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

import { createMutationOriginGuard } from './browserOriginGuard';

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function startGuardedServer(options: { requireOriginOrReferer?: boolean } = {}): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(createMutationOriginGuard({
    allowedOrigins: new Set(['http://allowed.example.test']),
    requireOriginOrReferer: options.requireOriginOrReferer,
  }));
  app.use(express.json());
  app.post('/mutate', (_request, response) => {
    response.json({ ok: true });
  });
  app.get('/mutate', (_request, response) => {
    response.json({ ok: true });
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

test('浏览器来源校验允许服务端 API 调用不带 Origin 或 Referer', async () => {
  const api = await startGuardedServer({ requireOriginOrReferer: false });
  try {
    const response = await fetch(`${api.baseUrl}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await api.close();
  }
});

test('浏览器来源校验拒绝不在白名单里的 Origin', async () => {
  const api = await startGuardedServer({ requireOriginOrReferer: false });
  try {
    const response = await fetch(`${api.baseUrl}/mutate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://evil.example.test',
        'x-request-id': 'blocked-origin-request',
      },
      body: '{}',
    });
    const body = await response.json() as any;
    assert.equal(response.status, 403);
    assert.deepEqual(body, {
      ok: false,
      requestId: 'blocked-origin-request',
      error: '请求来源不被允许。',
    });
  } finally {
    await api.close();
  }
});

test('浏览器来源校验允许白名单 Origin', async () => {
  const api = await startGuardedServer({ requireOriginOrReferer: false });
  try {
    const response = await fetch(`${api.baseUrl}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://allowed.example.test' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await api.close();
  }
});

test('浏览器来源校验拒绝不在白名单里的 Referer', async () => {
  const api = await startGuardedServer({ requireOriginOrReferer: false });
  try {
    const response = await fetch(`${api.baseUrl}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'http://evil.example.test/page' },
      body: '{}',
    });
    const body = await response.json() as any;
    assert.equal(response.status, 403);
    assert.equal(body.ok, false);
    assert.equal(body.error, '请求来源不被允许。');
    assert.equal(typeof body.requestId, 'string');
    assert.ok(body.requestId);
  } finally {
    await api.close();
  }
});

test('严格模式下缺少 Origin 和 Referer 会被拒绝', async () => {
  const api = await startGuardedServer();
  try {
    const response = await fetch(`${api.baseUrl}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = await response.json() as any;
    assert.equal(response.status, 403);
    assert.equal(body.ok, false);
    assert.equal(body.error, '请求来源不被允许。');
    assert.equal(typeof body.requestId, 'string');
    assert.ok(body.requestId);
  } finally {
    await api.close();
  }
});

test('浏览器来源校验不拦截 GET 下载类请求', async () => {
  const api = await startGuardedServer();
  try {
    const response = await fetch(`${api.baseUrl}/mutate`, {
      headers: { Origin: 'http://evil.example.test' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await api.close();
  }
});
