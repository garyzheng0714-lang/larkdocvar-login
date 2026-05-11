import assert from 'node:assert/strict';
import test from 'node:test';

import { __test__ } from './feishu';

test('replaceElements replaces placeholders split across text runs', () => {
  const input = [
    { text_run: { content: '你好 {{姓', text_element_style: { bold: true } } },
    { text_run: { content: '名}}，欢迎' } },
  ];

  const result = __test__.replaceElements(input, { 姓名: '张三' });

  assert.equal(result.changed, true);
  assert.deepEqual(
    result.elements.map((element) => (element as any).text_run?.content),
    ['你好 ', '张三', '，欢迎'],
  );
});

test('replaceElements keeps unknown placeholders unchanged', () => {
  const input = [
    { text_run: { content: '你好 {{姓名}}' } },
    { text_run: { content: '，{{未知}}' } },
  ];

  const result = __test__.replaceElements(input, { 姓名: '张三' });

  assert.equal(result.changed, true);
  assert.deepEqual(
    result.elements.map((element) => (element as any).text_run?.content),
    ['你好 ', '张三', '，{{未知}}'],
  );
});

test('image URL safety helpers block private IPs and allow Feishu domains', () => {
  assert.equal(__test__.isBlockedIpAddress('127.0.0.1'), true);
  assert.equal(__test__.isBlockedIpAddress('169.254.169.254'), true);
  assert.equal(__test__.isBlockedIpAddress('10.0.0.1'), true);
  assert.equal(__test__.isBlockedIpAddress('192.168.1.1'), true);
  assert.equal(__test__.isBlockedIpAddress('::ffff:10.0.0.1'), true);
  assert.equal(__test__.isBlockedIpAddress('::ffff:a00:1'), true);
  assert.equal(__test__.isBlockedIpAddress('::ffff:7f00:1'), true);
  assert.equal(__test__.isBlockedIpAddress('::1'), true);
  assert.equal(__test__.isBlockedIpAddress('fc00::1'), true);
  assert.equal(__test__.isBlockedIpAddress('fe90::1'), true);
  assert.equal(__test__.isBlockedIpAddress('ff02::1'), true);
  assert.equal(__test__.isBlockedIpAddress('8.8.8.8'), false);
  assert.equal(__test__.isBlockedIpAddress('2001:4860:4860::8888'), false);
  assert.equal(__test__.isAllowedImageHost('open.feishu.cn'), true);
});
