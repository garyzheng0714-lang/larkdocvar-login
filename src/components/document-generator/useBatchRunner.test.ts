import assert from 'node:assert/strict';
import test from 'node:test';
import { runBatchSlices } from './useBatchRunner';

// runBatchSlices 是"开始生成"和"重试"共用的分批执行核心，承载中断/暂停语义。
// 这些是用户直接感知的交互（点停止要在批次边界精确停下、暂停不能丢批次），必须钉死意图。

test('正常分批：按 batchSize 切片、顺序消费、不漏不重，返回 completed', async () => {
  const slices: number[][] = [];
  const result = await runBatchSlices<number>({
    records: [1, 2, 3, 4, 5],
    batchSize: 2,
    isInterrupted: () => false,
    isPaused: () => false,
    runSlice: async (slice) => { slices.push(slice); },
  });
  assert.equal(result, 'completed');
  assert.deepEqual(slices, [[1, 2], [3, 4], [5]], '5 条按 2 切成 3 批，覆盖全部记录');
});

test('开始前已中断：一批都不跑，立即返回 interrupted', async () => {
  let calls = 0;
  const result = await runBatchSlices<number>({
    records: [1, 2, 3],
    batchSize: 1,
    isInterrupted: () => true,
    isPaused: () => false,
    runSlice: async () => { calls += 1; },
  });
  assert.equal(result, 'interrupted');
  assert.equal(calls, 0, '已中断时不应消费任何批次');
});

test('运行中途中断：在批次边界精确停止，已开始的批次跑完、后续批次不再消费', async () => {
  const ran: number[][] = [];
  let interrupted = false;
  const result = await runBatchSlices<number>({
    records: [1, 2, 3, 4],
    batchSize: 1,
    isInterrupted: () => interrupted,
    isPaused: () => false,
    runSlice: async (slice) => {
      ran.push(slice);
      interrupted = true; // 跑完这一批后请求中断
    },
  });
  assert.equal(result, 'interrupted');
  assert.deepEqual(ran, [[1]], '中断后应停在批次边界，不消费后续批次');
});

test('暂停期间不消费下一批，恢复后继续把剩余批次跑完', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) };
  try {
    const ran: number[][] = [];
    let paused = true;
    const promise = runBatchSlices<number>({
      records: [1],
      batchSize: 1,
      isInterrupted: () => false,
      isPaused: () => paused,
      runSlice: async (slice) => { ran.push(slice); },
      pausePollMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(ran, [], '暂停期间不应消费任何批次');
    paused = false; // 恢复
    const result = await promise;
    assert.equal(result, 'completed');
    assert.deepEqual(ran, [[1]], '恢复后应继续把剩余批次跑完');
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});
