import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

import { createDocumentRenderRouter } from './documentRenderApi';

async function startApiServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/api/v1/document-renders', createDocumentRenderRouter());

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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function postDocxUrl(baseUrl: string, url: string): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/document-renders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: {
        format: 'docx',
        url,
      },
      variables: {
        客户名称: '上海测试科技有限公司',
      },
    }),
  });
}

test('公开 API 默认阻止 Docx 模板链接访问本机地址', async () => {
  const api = await startApiServer();
  try {
    const response = await postDocxUrl(api.baseUrl, 'https://127.0.0.1/template.docx');

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.equal(body.error, '模板链接不能指向内网或本机地址。');
  } finally {
    await api.close();
  }
});

test('公开 API 默认阻止 Docx 模板链接访问云元数据地址', async () => {
  const api = await startApiServer();
  try {
    const response = await postDocxUrl(api.baseUrl, 'https://169.254.169.254/latest/meta-data');

    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.equal(body.error, '模板链接不能指向内网或本机地址。');
  } finally {
    await api.close();
  }
});
