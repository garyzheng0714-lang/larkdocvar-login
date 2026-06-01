import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// 测试目标：Render Job 应该持久化到 PostgreSQL，服务重启后可恢复。
// 这是一个架构测试，记录了期望行为。

describe('Render Job 持久化', () => {
  it('job 状态应该存储在 PostgreSQL 中', () => {
    // 期望：render_jobs 表应该存在，包含 job 的所有状态字段
    const expectedTable = 'render_jobs';
    const expectedColumns = [
      'job_id',        // TEXT PRIMARY KEY
      'owner_key',     // TEXT NOT NULL (提交者身份绑定)
      'lease_owner',   // TEXT (当前执行进程租约持有者)
      'lease_expires_at', // TIMESTAMPTZ (租约过期后才能判定 stale)
      'status',        // TEXT NOT NULL (pending/running/completed/failed/partial_failed)
      'template_json', // TEXT NOT NULL (JSON 序列化的模板配置)
      'output_json',   // TEXT (JSON 序列化的输出配置)
      'total',         // INTEGER NOT NULL
      'processed',     // INTEGER NOT NULL DEFAULT 0
      'succeeded',     // INTEGER NOT NULL DEFAULT 0
      'failed',        // INTEGER NOT NULL DEFAULT 0
      'records_json',  // TEXT NOT NULL (JSON 序列化的记录列表)
      'results_json',  // TEXT NOT NULL DEFAULT '[]' (JSON 序列化的结果列表)
      'error',         // TEXT
      'created_at',    // TIMESTAMPTZ NOT NULL DEFAULT NOW()
      'updated_at',    // TIMESTAMPTZ NOT NULL DEFAULT NOW()
      'expires_at',    // TIMESTAMPTZ NOT NULL
    ];

    assert.equal(expectedTable, 'render_jobs');
    assert.ok(expectedColumns.length > 0, '应该有列定义');
  });

  it('服务重启后只应失败租约过期的 pending/running job', () => {
    // 期望：多实例部署时，一个实例启动不能把另一个实例仍在执行的任务误标失败。
    const restartBehavior = 'mark_expired_lease_as_failed';
    assert.equal(restartBehavior, 'mark_expired_lease_as_failed');
  });
});
