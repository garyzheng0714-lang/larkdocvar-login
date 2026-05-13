import assert from 'node:assert/strict';
import test from 'node:test';

import { __test__ } from './documentRenderApi';

const OSS_ENV_NAMES = [
  'DOCUMENT_RENDER_OSS_ACCESS_KEY_ID',
  'DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET',
  'DOCUMENT_RENDER_OSS_BUCKET',
  'DOCUMENT_RENDER_OSS_REGION',
  'ALIYUN_OSS_ACCESS_KEY_ID',
  'ALIYUN_OSS_ACCESS_KEY_SECRET',
  'ALIYUN_OSS_BUCKET',
  'ALIYUN_OSS_REGION',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'OSS_BUCKET',
  'OSS_REGION',
  'OSS_REGION_ID',
  'DOCUMENT_RENDER_OSS_PREFIX',
  'TOS_ACCESS_KEY',
  'TOS_SECRET_KEY',
  'TOS_BUCKET',
  'TOS_REGION',
  'TOS_ENDPOINT',
  'DOCUMENT_TOS_ROOT_PREFIX',
];

function withOssEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const name of OSS_ENV_NAMES) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(values)) {
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test('Docx API OSS 配置读取支持常见环境变量别名', () => {
  const restore = withOssEnv({
    ALIYUN_OSS_ACCESS_KEY_ID: 'alias-ak',
    OSS_ACCESS_KEY_SECRET: 'alias-secret',
    OSS_BUCKET: 'alias-bucket',
    OSS_REGION_ID: 'cn-beijing',
    DOCUMENT_RENDER_OSS_PREFIX: '../合同\\2026',
  });

  try {
    const config = __test__.readOssConfig();
    assert.ok(config && !(config instanceof Error));
    assert.equal(config.accessKeyId, 'alias-ak');
    assert.equal(config.accessKeySecret, 'alias-secret');
    assert.equal(config.bucket, 'alias-bucket');
    assert.equal(config.region, 'oss-cn-beijing');
    assert.equal(config.prefix, '合同/2026/');
  } finally {
    restore();
  }
});

test('Docx API OSS 配置读取遇到部分配置时返回可读错误', () => {
  const restore = withOssEnv({
    OSS_BUCKET: 'only-bucket',
  });

  try {
    const config = __test__.readOssConfig();
    assert.ok(config instanceof Error);
    assert.equal(config.message, 'OSS 配置不完整，请检查 AccessKey、Bucket 和 Region。');
  } finally {
    restore();
  }
});

test('Docx API TOS 配置读取支持生产对象存储链路', () => {
  const restore = withOssEnv({
    TOS_ACCESS_KEY: 'tos-ak',
    TOS_SECRET_KEY: 'tos-secret',
    TOS_BUCKET: 'tos-bucket',
    TOS_REGION: 'cn-beijing',
    TOS_ENDPOINT: 'https://tos-cn-beijing.volces.com/',
    DOCUMENT_TOS_ROOT_PREFIX: 'fbif-sidebar-docgen/prod',
    DOCUMENT_RENDER_TOS_PREFIX: 'renders',
  });

  try {
    const config = __test__.readTosConfig();
    assert.ok(config && !(config instanceof Error));
    assert.equal(config.accessKeyId, 'tos-ak');
    assert.equal(config.accessKeySecret, 'tos-secret');
    assert.equal(config.bucket, 'tos-bucket');
    assert.equal(config.region, 'cn-beijing');
    assert.equal(config.endpoint, 'tos-cn-beijing.volces.com');
    assert.equal(config.prefix, 'fbif-sidebar-docgen/prod/renders/');
  } finally {
    restore();
  }
});
