import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HANDOFF_TTL_MS,
  __backdateHandoffForTest,
  __peekHandoffExpectedOpenIdForTest,
  __resetHandoffStoreForTest,
  completeHandoff,
  consumeHandoff,
  createHandoff,
} from './authHandoff';

const OPEN_ID = 'ou_initiator';

test.beforeEach(() => {
  __resetHandoffStoreForTest();
});

test('createHandoff 返回不可猜的 hex code，初始状态 pending，并绑定发起者 open_id', () => {
  // 安全意图：code 必须 crypto 随机、足够长（32 字节 = 64 hex），否则可被枚举接管会话；
  // 同时必须把发起者 Base open_id 绑进记录，作为后续 OAuth 完成者身份比对的基准。
  const code = createHandoff(OPEN_ID);
  assert.match(code, /^[0-9a-f]{64}$/);
  assert.equal(__peekHandoffExpectedOpenIdForTest(code), OPEN_ID);

  const result = consumeHandoff(code);
  assert.equal(result.status, 'pending');
  assert.equal(result.sessionToken, undefined);
});

test('completeHandoff 用匹配 open_id → done + matched，consume 取回 sessionToken', () => {
  // 意图：OAuth 在系统浏览器完成、且登录者 open_id 与发起者一致时回写 token，
  // iframe 轮询必须能取回来才算登录成功。
  const code = createHandoff(OPEN_ID);
  const outcome = completeHandoff(code, 'session-token-xyz', OPEN_ID);
  assert.equal(outcome.matched, true);

  const result = consumeHandoff(code);
  assert.equal(result.status, 'done');
  assert.equal(result.sessionToken, 'session-token-xyz');
});

test('completeHandoff 用不匹配 open_id → rejected，consume 返回两个 open_id 且无 token', () => {
  // 安全意图（防会话接管）：攻击者建 code、钓鱼受害者完成 OAuth 时，受害者 open_id 与
  // 攻击者发起的 expectedOpenId 不一致 → 不发 token，置 rejected，并暴露两个 open_id 供诊断。
  const code = createHandoff(OPEN_ID);
  const outcome = completeHandoff(code, 'victim-session-token', 'ou_victim');
  assert.equal(outcome.matched, false);

  const result = consumeHandoff(code);
  assert.equal(result.status, 'rejected');
  assert.equal(result.sessionToken, undefined);
  assert.equal(result.expectedOpenId, OPEN_ID);
  assert.equal(result.actualOpenId, 'ou_victim');
});

test('rejected 的 handoff 单次消费：第二次取变 unknown', () => {
  // 安全意图：rejected 诊断信息（两个 open_id）也只暴露一次，取走即删，避免被反复探测。
  const code = createHandoff(OPEN_ID);
  completeHandoff(code, 'victim-session-token', 'ou_victim');

  const first = consumeHandoff(code);
  assert.equal(first.status, 'rejected');
  assert.equal(first.expectedOpenId, OPEN_ID);
  assert.equal(first.actualOpenId, 'ou_victim');

  const second = consumeHandoff(code);
  assert.equal(second.status, 'unknown');
  assert.equal(second.expectedOpenId, undefined);
  assert.equal(second.actualOpenId, undefined);
});

test('done 的 handoff 单次消费：第二次取变 unknown', () => {
  // 安全意图：sessionToken 是敏感值，只能被取走一次，防止重放/二次窃取。
  const code = createHandoff(OPEN_ID);
  completeHandoff(code, 'session-token-once', OPEN_ID);

  const first = consumeHandoff(code);
  assert.equal(first.status, 'done');
  assert.equal(first.sessionToken, 'session-token-once');

  const second = consumeHandoff(code);
  assert.equal(second.status, 'unknown');
  assert.equal(second.sessionToken, undefined);
});

test('open_id 不匹配后不会被后续匹配 complete 翻盘成 done', () => {
  // 安全意图：一旦判定 rejected（非 pending），即便随后来一个 open_id 匹配的 complete，
  // 也不应把这个已被污染的 handoff 激活成可用会话。
  const code = createHandoff(OPEN_ID);
  completeHandoff(code, 'victim-token', 'ou_victim');
  const retry = completeHandoff(code, 'good-token', OPEN_ID);
  assert.equal(retry.matched, false);

  const result = consumeHandoff(code);
  assert.equal(result.status, 'rejected');
  assert.equal(result.sessionToken, undefined);
});

test('过期的 handoff consume 返回 expired 并被删除', () => {
  // 意图：5 分钟硬过期，过期 code 不能再被换成会话；过期后立即从存储移除。
  const code = createHandoff(OPEN_ID);
  __backdateHandoffForTest(code, HANDOFF_TTL_MS + 1000);

  const result = consumeHandoff(code);
  assert.equal(result.status, 'expired');
  assert.equal(result.sessionToken, undefined);

  // 已删除：再次 consume 变 unknown。
  assert.equal(consumeHandoff(code).status, 'unknown');
});

test('过期的 handoff 不能再被 completeHandoff 置为 done', () => {
  // 安全意图：即使 OAuth 回调姗姗来迟，过期的 handoff 也不应被激活成可用会话。
  const code = createHandoff(OPEN_ID);
  __backdateHandoffForTest(code, HANDOFF_TTL_MS + 1000);

  const outcome = completeHandoff(code, 'too-late-token', OPEN_ID);
  assert.equal(outcome.matched, false);

  // consume 仍按过期处理（先 prune 删掉），不会泄露 token。
  const result = consumeHandoff(code);
  assert.notEqual(result.status, 'done');
  assert.equal(result.sessionToken, undefined);
});

test('未知 code consume 返回 unknown', () => {
  // 意图：伪造/猜测的 code 必须被安全拒绝，不返回任何会话信息。
  const result = consumeHandoff('deadbeef'.repeat(8));
  assert.equal(result.status, 'unknown');
  assert.equal(result.sessionToken, undefined);
});

test('completeHandoff 对未知 code 安全忽略，不抛错且 matched=false', () => {
  // 意图：恶意/陈旧的回调不应让进程崩溃，也不应凭空创建会话。
  const outcome = completeHandoff('f'.repeat(64), 'ghost-token', OPEN_ID);
  assert.equal(outcome.matched, false);
  assert.equal(consumeHandoff('f'.repeat(64)).status, 'unknown');
});
