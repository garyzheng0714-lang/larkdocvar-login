import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from './documentRenderJobApi';

// 测试目标：render job 的租约与归属语义——服务重启的 markStale 不能误杀仍被活进程持有
// （租约未过期）的任务，且任务结果只对提交者本人可见。这两条是"批量任务可靠且不串号"的核心意图。
const { createMemoryJobStore } = __test__;

function insertJob(store: ReturnType<typeof createMemoryJobStore>, overrides: {
  jobId: string;
  ownerKey: string;
  status: string;
  leaseExpiresAt: string;
}) {
  return store.insert({
    jobId: overrides.jobId,
    ownerKey: overrides.ownerKey,
    leaseOwner: 'process:test',
    leaseExpiresAt: overrides.leaseExpiresAt,
    status: overrides.status,
    templateJson: '{}',
    total: 1,
    recordsJson: '[]',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

describe('Render Job 租约与归属语义', () => {
  it('markStale 只失败租约已过期的 pending/running job，绝不误杀租约仍新鲜的运行中任务', async () => {
    const store = createMemoryJobStore();
    // 租约已过期的运行中任务：进程已失联，应被标失败
    await insertJob(store, { jobId: 'expired', ownerKey: 'u1', status: 'running', leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() });
    // 租约仍新鲜的运行中任务：活进程正在跑（靠心跳续租），绝不能误杀——这是"markStale 不误杀"的关键意图
    await insertJob(store, { jobId: 'fresh', ownerKey: 'u1', status: 'running', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    // 已完成的任务：不在 pending/running，不受影响
    await insertJob(store, { jobId: 'done', ownerKey: 'u1', status: 'completed', leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() });

    const count = await store.markStaleAsFailed();

    assert.equal(count, 1, '只应失败 1 个（租约过期的运行中任务）');
    assert.equal((await store.get('expired', 'u1'))?.status, 'failed', '租约过期的运行中任务应被标失败');
    assert.equal((await store.get('fresh', 'u1'))?.status, 'running', '租约新鲜的运行中任务必须保持 running，不能被误杀');
    assert.equal((await store.get('done', 'u1'))?.status, 'completed', '已完成任务不受 markStale 影响');
  });

  it('任务结果只对提交者本人（owner_key 匹配）可见，他人凭 jobId 也查不到', async () => {
    const store = createMemoryJobStore();
    await insertJob(store, { jobId: 'job_a', ownerKey: 'feishu:userA', status: 'completed', leaseExpiresAt: new Date().toISOString() });

    assert.ok(await store.get('job_a', 'feishu:userA'), '本人应能查到自己的任务');
    assert.equal(await store.get('job_a', 'feishu:userB'), undefined, '他人即便拿到 jobId 也查不到——避免跨用户串号');
  });
});
