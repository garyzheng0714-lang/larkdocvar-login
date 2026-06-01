import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBitableSidebarFallbackUser } from './pluginLoginRoutes';

test('侧边栏 SDK 用户无法反查通讯录时生成稳定的本地会话身份', () => {
  const first = buildBitableSidebarFallbackUser({
    sdkUserId: 'sdk_user_demo',
    baseUserId: 'base_user_demo',
    baseId: 'bascn_demo',
  });
  const second = buildBitableSidebarFallbackUser({
    sdkUserId: 'sdk_user_changed',
    baseUserId: 'base_user_demo',
    baseId: 'bascn_demo',
  });

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.open_id, second.open_id);
  assert.match(first.open_id, /^bitable:[a-f0-9]{32}$/);
  assert.equal(first.name, '飞书侧边栏用户');
  assert.equal(first.open_id.includes('base_user_demo'), false);
});

test('侧边栏本地身份按 Base 隔离，避免不同 Base 的同一 SDK ID 混用', () => {
  const first = buildBitableSidebarFallbackUser({
    sdkUserId: 'sdk_user_demo',
    baseId: 'bascn_a',
  });
  const second = buildBitableSidebarFallbackUser({
    sdkUserId: 'sdk_user_demo',
    baseId: 'bascn_b',
  });

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.open_id, second.open_id);
});
