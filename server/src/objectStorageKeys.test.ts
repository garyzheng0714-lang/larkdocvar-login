import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeObjectPrefix, sanitizeObjectRequestId } from './objectStorageKeys';

// 这些行为此前散在 documentRenderApi.ts 的 sanitizeRequestId / normalizeOssPrefix
// 和 documentRenderTosStorage.ts 的 sanitizeTosRequestId / normalizeTosPrefix，
// 两份逐字符重复。测试锁住语义，再把两处副本收敛到一个中性模块。

test('normalizeObjectPrefix 清掉路径穿越段并补尾斜杠', () => {
  // 与 documentRenderSecurity.test.ts 既有断言一致，防止迁移改变安全行为
  assert.equal(normalizeObjectPrefix('../合同\\2026/./../报价'), '合同/2026/报价/');
  assert.equal(normalizeObjectPrefix('/.././'), '');
});

test('normalizeObjectPrefix 空输入返回空串（不加斜杠）', () => {
  assert.equal(normalizeObjectPrefix(''), '');
  assert.equal(normalizeObjectPrefix('   '), '');
});

test('normalizeObjectPrefix 普通前缀补一个尾斜杠且只补一个', () => {
  assert.equal(normalizeObjectPrefix('poster/outputs'), 'poster/outputs/');
  assert.equal(normalizeObjectPrefix('poster//outputs//'), 'poster/outputs/');
});

test('sanitizeObjectRequestId 把非法字符替换为连字符', () => {
  assert.equal(sanitizeObjectRequestId('a b/c?d'), 'a-b-c-d');
});

test('sanitizeObjectRequestId 折叠连续点、去首尾点和连字符', () => {
  assert.equal(sanitizeObjectRequestId('..foo..bar..'), 'foo.bar');
  assert.equal(sanitizeObjectRequestId('--x--'), 'x');
});

test('sanitizeObjectRequestId 截断到 128 字符', () => {
  const long = 'a'.repeat(300);
  assert.equal(sanitizeObjectRequestId(long).length, 128);
});

test('sanitizeObjectRequestId 清空后回退到随机 UUID', () => {
  const out = sanitizeObjectRequestId('???');
  assert.match(out, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
