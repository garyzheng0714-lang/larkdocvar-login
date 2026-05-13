import assert from 'node:assert/strict';
import test from 'node:test';

import { readTemplateTosConfig } from './documentTemplateStorage';

const TEMPLATE_TOS_ENV_NAMES = [
  'TOS_ACCESS_KEY',
  'TOS_SECRET_KEY',
  'TOS_BUCKET',
  'TOS_REGION',
  'TOS_ENDPOINT',
  'DOCUMENT_TOS_ROOT_PREFIX',
  'DOCUMENT_TEMPLATE_TOS_PREFIX',
  'DOCUMENT_RENDER_TOS_PREFIX',
];

function withTemplateTosEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const name of TEMPLATE_TOS_ENV_NAMES) {
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

test('模板 TOS 存储支持统一项目根目录', () => {
  const restore = withTemplateTosEnv({
    TOS_ACCESS_KEY: 'tos-ak',
    TOS_SECRET_KEY: 'tos-secret',
    TOS_BUCKET: 'tos-bucket',
    TOS_REGION: 'cn-beijing',
    TOS_ENDPOINT: 'https://tos-cn-beijing.volces.com/',
    DOCUMENT_TOS_ROOT_PREFIX: '../fbif-sidebar-docgen\\prod',
    DOCUMENT_TEMPLATE_TOS_PREFIX: '../templates',
  });

  try {
    const config = readTemplateTosConfig();
    assert.ok(config && !(config instanceof Error));
    assert.equal(config.endpoint, 'tos-cn-beijing.volces.com');
    assert.equal(config.prefix, 'fbif-sidebar-docgen/prod/templates/');
  } finally {
    restore();
  }
});
