import assert from 'node:assert/strict';
import test from 'node:test';
import { computeEtaSeconds } from './progressEta';

test('还没处理完任何一条时返回 null（UI 显示"正在估算…"，不臆造预估）', () => {
  assert.equal(computeEtaSeconds(0, 10, 5), null);
});

test('耗时为 0（刚开始那一刻）时返回 null，避免除零造出假速率', () => {
  assert.equal(computeEtaSeconds(2, 10, 0), null);
});

test('有真实样本后按实测速率估算剩余秒数', () => {
  // 4 秒处理 2 条 → 0.5 条/秒；剩 8 条 → 16 秒
  assert.equal(computeEtaSeconds(2, 10, 4), 16);
});

test('剩余时间向上取整，不少报（10 秒处理 3 条，剩 7 条 → 23.33s 取整 24）', () => {
  assert.equal(computeEtaSeconds(3, 10, 10), 24);
});

test('全部处理完时剩余为 0', () => {
  assert.equal(computeEtaSeconds(10, 10, 20), 0);
});
