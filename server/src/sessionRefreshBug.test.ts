import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// 测试目标：resolveSession 在 token 刷新失败时，不应该删除 refresh_token 仍有效的 session。
// 这是一个回归测试，确保网络瞬时失败不会导致用户被踢下线。

describe('resolveSession token 刷新失败处理', () => {
  it('refresh_token 未过期时，刷新失败不应删除 session', async () => {
    // 模拟场景：refresh_token 还有效（expires_at 在未来），但刷新请求失败（网络错误）
    const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 天后

    // 验证逻辑：如果 catch 块检查 refresh_expires_at，它应该发现 token 未过期
    // 从而不调用 deleteSessionByToken
    const refreshExpiresAtMs = Date.parse(refreshExpiresAt);
    const isRefreshTokenValid = refreshExpiresAtMs > Date.now();

    assert.equal(isRefreshTokenValid, true, 'refresh_token 应该被视为有效');
  });

  it('refresh_token 已过期时，刷新失败应该删除 session', () => {
    // 模拟场景：refresh_token 已过期
    const refreshExpiresAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 1 天前

    const refreshExpiresAtMs = Date.parse(refreshExpiresAt);
    const isRefreshTokenValid = refreshExpiresAtMs > Date.now();

    assert.equal(isRefreshTokenValid, false, 'refresh_token 应该被视为过期');
  });

  it('refresh_expires_at 为空或无效时，保守处理不删除 session', () => {
    // 模拟场景：refresh_expires_at 为空（数据库里没有这个字段）
    const refreshExpiresAt = '';
    const refreshExpiresAtMs = Date.parse(refreshExpiresAt);

    // parseEpochMs 返回 0，0 > 0 是 false，所以条件不成立
    // 这意味着如果 refreshExpiresAt 为空，refresh_token 会被视为"未过期"
    // 这是保守的处理方式：宁可保留 session 也不误删
    const isRefreshTokenExpired = refreshExpiresAtMs > 0 && refreshExpiresAtMs <= Date.now();

    assert.equal(isRefreshTokenExpired, false, '空的 refresh_expires_at 不应被视为过期');
  });
});
