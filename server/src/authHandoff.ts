import crypto from 'node:crypto';

// 内存 handoff 存储（device-flow 风格）。单实例够用：系统浏览器跑完 OAuth 后，
// 会话 token 暂存这里，Base iframe 轮询取回。不落库、不建 migration。
//
// 安全约束（与签名 state 绑定，见 authSessionRoutes.ts）：
// - code = crypto 随机 32 字节 hex，不可猜。
// - 单次消费：done 后 consumeHandoff 返回 sessionToken 即从 Map 删除。
// - 5 分钟过期：每次 create/complete/consume 顺带 prune，无全局 setInterval（测试/进程友好）。
//
// 会话接管加固（open_id 绑定）：
// - createHandoff 绑定发起者的 Base open_id（expectedOpenId）。
// - completeHandoff 只在 OAuth 完成者 open_id 与 expectedOpenId 严格相等时才写 token；
//   否则置 rejected，并把实际 open_id（actualOpenId）留存供诊断。
// - 防止「攻击者建 code → 钓鱼受害者完成 OAuth → token 落进攻击者 code」的接管。

export type HandoffRecord = {
  status: 'pending' | 'done' | 'rejected';
  sessionToken?: string;
  expectedOpenId: string;
  // 仅 rejected 时填：OAuth 实际完成者的 open_id（与 expectedOpenId 不匹配）。
  actualOpenId?: string;
  createdAt: number;
};

export type HandoffConsumeResult = {
  status: 'pending' | 'done' | 'rejected' | 'expired' | 'unknown';
  sessionToken?: string;
  expectedOpenId?: string;
  actualOpenId?: string;
};

export const HANDOFF_TTL_MS = 5 * 60 * 1000;

const store = new Map<string, HandoffRecord>();

// 接受可选 now 参数：测试可传未来时间触发过期，无需弄脏生产调用方。
function pruneExpired(now: number = Date.now()): void {
  for (const [code, record] of store) {
    if (now - record.createdAt > HANDOFF_TTL_MS) {
      store.delete(code);
    }
  }
}

// expectedOpenId = 发起登录的 Base 身份 open_id。空字符串也允许存（start 路由会拦空，
// 这里不二次硬校验，保持存储层纯粹），但空绑定意味着任何登录者都不会匹配 → 永远 rejected。
export function createHandoff(expectedOpenId: string): string {
  pruneExpired();
  const code = crypto.randomBytes(32).toString('hex');
  store.set(code, { status: 'pending', expectedOpenId, createdAt: Date.now() });
  return code;
}

// 返回 { matched }：matched=true 表示 open_id 校验通过、token 已写入、status=done；
// matched=false 表示记录不存在/过期/非 pending，或 open_id 不匹配（此时置 rejected 并留存 actualOpenId）。
export function completeHandoff(
  code: string,
  sessionToken: string,
  actualOpenId: string,
): { matched: boolean } {
  pruneExpired();
  const record = store.get(code);
  if (!record) return { matched: false };
  if (record.status !== 'pending') return { matched: false };
  if (Date.now() - record.createdAt > HANDOFF_TTL_MS) return { matched: false };
  if (record.expectedOpenId !== actualOpenId) {
    // open_id 不匹配：可能防住接管攻击，也可能是 Base open_id 与 OAuth open_id 应用隔离误伤。
    // 不静默——置 rejected 并留存 actualOpenId，让 consume/前端能暴露两个 id 供真机区分。
    record.status = 'rejected';
    record.actualOpenId = actualOpenId;
    return { matched: false };
  }
  record.status = 'done';
  record.sessionToken = sessionToken;
  return { matched: true };
}

export function consumeHandoff(code: string): HandoffConsumeResult {
  // 先单独判定目标 code（必须在 prune 之前，否则过期项会被 prune 删掉而退化成 unknown，
  // 拿不到 expired 这个更有信息量的状态——前端据此区分"已失效"与"从未存在"）。
  const record = store.get(code);
  if (!record) {
    pruneExpired();
    return { status: 'unknown' };
  }
  if (Date.now() - record.createdAt > HANDOFF_TTL_MS) {
    store.delete(code);
    pruneExpired();
    return { status: 'expired' };
  }
  if (record.status === 'pending') {
    pruneExpired();
    return { status: 'pending' };
  }
  if (record.status === 'rejected') {
    // rejected 单次消费——返回两个 open_id 供真机诊断（区分"防住攻击"vs"误伤自己"）后即删除。
    store.delete(code);
    pruneExpired();
    return {
      status: 'rejected',
      expectedOpenId: record.expectedOpenId,
      actualOpenId: record.actualOpenId,
    };
  }
  // done：单次消费——返回 sessionToken 后立即删除。
  store.delete(code);
  pruneExpired();
  return { status: 'done', sessionToken: record.sessionToken };
}

// 仅测试用：清空内存存储。
export function __resetHandoffStoreForTest(): void {
  store.clear();
}

// 仅测试用：把记录的 createdAt 往回拨，模拟过期，无需真等 5 分钟。
// 不脏化生产 API（生产代码一律用真实 Date.now()）。
export function __backdateHandoffForTest(code: string, ageMs: number): void {
  const record = store.get(code);
  if (record) {
    record.createdAt = Date.now() - ageMs;
  }
}

// 仅测试用：读取记录的 expectedOpenId，断言绑定写入正确。
export function __peekHandoffExpectedOpenIdForTest(code: string): string | undefined {
  return store.get(code)?.expectedOpenId;
}
