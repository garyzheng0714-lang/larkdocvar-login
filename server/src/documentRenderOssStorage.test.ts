import assert from 'node:assert/strict';
import test from 'node:test';

import { __test__ } from './documentRenderApi';

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type PutCall = {
  objectName: string;
  buffer: Buffer;
  options: {
    mime?: string;
    headers?: Record<string, string>;
  };
};

type SignatureCall = {
  objectName: string;
  options: {
    expires?: number;
    method?: string;
    response?: Record<string, string>;
  };
};

class FakeAliOssClient {
  putCalls: PutCall[] = [];
  signatureCalls: SignatureCall[] = [];

  async put(objectName: string, buffer: Buffer, options: PutCall['options']): Promise<void> {
    this.putCalls.push({ objectName, buffer, options });
  }

  signatureUrl(objectName: string, options: SignatureCall['options']): string {
    this.signatureCalls.push({ objectName, options });
    return `https://oss.example.test/${encodeURIComponent(objectName)}?expires=${options.expires}`;
  }
}

test('内置 OSS 存储上传 Docx 并生成带 TTL 的签名下载链接', async () => {
  const client = new FakeAliOssClient();
  const storage = new __test__.OssDocumentRenderStorage(client as any, 'document-renders/');
  const buffer = Buffer.from('docx-content');

  const saved = await storage.saveDocx({
    buffer,
    fileName: '../报价:单?.docx',
    requestId: 'request-123',
    ttlMs: 3600 * 1000,
    ttlSeconds: 3600,
  });

  assert.equal(saved.storage, 'oss');
  assert.equal(saved.fileName, '报价-单-.docx');
  assert.equal(saved.contentType, DOCX_CONTENT_TYPE);
  assert.equal(saved.size, buffer.length);
  // 验证意图：对象 key 末段必须是友好文件名（requestId 仅作目录保唯一），这样下载链接
  // URL 末段就是合同名，飞书「链接转附件」按 URL 路径取名时拿到的才是合同名而非 UUID。
  assert.match(saved.path, /^document-renders\/\d{4}-\d{2}-\d{2}\/request-123\/报价-单-\.docx$/);
  assert.equal(saved.url, `https://oss.example.test/${encodeURIComponent(saved.path)}?expires=3600`);
  assert.equal(client.putCalls.length, 1);
  assert.equal(client.signatureCalls.length, 1);
  assert.equal(client.putCalls[0]?.objectName, saved.path);
  assert.equal(client.putCalls[0]?.buffer, buffer);
  assert.deepEqual(client.putCalls[0]?.options, {
    mime: DOCX_CONTENT_TYPE,
    headers: {
      'Content-Type': DOCX_CONTENT_TYPE,
      'Content-Disposition': "attachment; filename=\"document.docx\"; filename*=UTF-8''%E6%8A%A5%E4%BB%B7-%E5%8D%95-.docx",
      'Cache-Control': 'private, max-age=0, no-cache',
    },
  });
  assert.deepEqual(client.signatureCalls[0], {
    objectName: saved.path,
    options: {
      expires: 3600,
      method: 'GET',
      response: {
        'content-type': DOCX_CONTENT_TYPE,
        'content-disposition': "attachment; filename=\"document.docx\"; filename*=UTF-8''%E6%8A%A5%E4%BB%B7-%E5%8D%95-.docx",
      },
    },
  });
});

test('内置 OSS 存储会清洗 requestId 中的路径片段', async () => {
  const client = new FakeAliOssClient();
  const storage = new __test__.OssDocumentRenderStorage(client as any, 'document-renders/');

  const saved = await storage.saveDocx({
    buffer: Buffer.from('docx-content'),
    fileName: '合同.docx',
    requestId: '../evil\\nested:request?',
    ttlMs: 3600 * 1000,
    ttlSeconds: 3600,
  });

  assert.match(saved.path, /^document-renders\/\d{4}-\d{2}-\d{2}\/evil-nested-request\/合同\.docx$/);
  assert.equal(saved.path.includes('..'), false);
  assert.equal(saved.path.includes('\\'), false);
  assert.equal(client.putCalls[0]?.objectName, saved.path);
  assert.equal(client.signatureCalls[0]?.objectName, saved.path);
});

test('内置 OSS 存储上传或签名失败时返回用户可理解错误', async () => {
  const putFailureClient = new FakeAliOssClient();
  putFailureClient.put = async () => {
    throw new Error('internal put failure');
  };
  await assert.rejects(
    () => new __test__.OssDocumentRenderStorage(putFailureClient as any, '').saveDocx({
      buffer: Buffer.from('x'),
      fileName: '合同.docx',
      requestId: 'put-failure',
      ttlMs: 1000,
      ttlSeconds: 1,
    }),
    /生成文件上传 OSS 失败，请检查 OSS 配置和权限。/,
  );

  const signatureFailureClient = new FakeAliOssClient();
  signatureFailureClient.signatureUrl = () => {
    throw new Error('internal signature failure');
  };
  await assert.rejects(
    () => new __test__.OssDocumentRenderStorage(signatureFailureClient as any, '').saveDocx({
      buffer: Buffer.from('x'),
      fileName: '合同.docx',
      requestId: 'signature-failure',
      ttlMs: 1000,
      ttlSeconds: 1,
    }),
    /OSS 下载链接生成失败，请检查 OSS 配置。/,
  );
});
