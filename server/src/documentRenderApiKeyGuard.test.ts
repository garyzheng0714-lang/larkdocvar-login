import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import test from 'node:test';
import { requireDocumentRenderApiKey } from './documentRenderApiKeyGuard';

async function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(requireDocumentRenderApiKey);
  app.options('/protected', (_request, response) => response.sendStatus(200));
  app.get('/protected', (_request, response) => response.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('Docx API Key 未配置时不拦截请求', async () => {
  const previous = process.env.DOCUMENT_RENDER_API_KEY;
  delete process.env.DOCUMENT_RENDER_API_KEY;
  const api = await startServer();
  try {
    const response = await fetch(`${api.baseUrl}/protected`);
    assert.equal(response.status, 200);
  } finally {
    if (previous !== undefined) process.env.DOCUMENT_RENDER_API_KEY = previous;
    await api.close();
  }
});

test('Docx API Key 配置后要求 Authorization Bearer 或 x-api-key', async () => {
  const previous = process.env.DOCUMENT_RENDER_API_KEY;
  process.env.DOCUMENT_RENDER_API_KEY = 'secret-key';
  const api = await startServer();
  try {
    assert.equal((await fetch(`${api.baseUrl}/protected`)).status, 401);
    assert.equal((await fetch(`${api.baseUrl}/protected`, { method: 'OPTIONS' })).status, 200);
    assert.equal((await fetch(`${api.baseUrl}/protected`, { headers: { authorization: 'Bearer secret-key' } })).status, 200);
    assert.equal((await fetch(`${api.baseUrl}/protected`, { headers: { 'x-api-key': 'secret-key' } })).status, 200);
  } finally {
    if (previous === undefined) delete process.env.DOCUMENT_RENDER_API_KEY;
    else process.env.DOCUMENT_RENDER_API_KEY = previous;
    await api.close();
  }
});
