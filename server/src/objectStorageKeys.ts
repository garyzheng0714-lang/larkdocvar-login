import { randomUUID } from 'node:crypto';

// 对象存储 key 的中性工具：OSS 与 TOS 共用同一套前缀归一和 requestId 清理规则。
// 此前两套实现（documentRenderApi.ts 的 normalizeOssPrefix/sanitizeRequestId 与
// documentRenderTosStorage.ts 的 normalizeTosPrefix/sanitizeTosRequestId）逐字符重复，
// 收敛到这里以消除重复并集中安全相关的路径清理逻辑。

/** 归一对象前缀：清掉路径穿越段（. / ..）、合并分隔符，非空时补单个尾斜杠。 */
export function normalizeObjectPrefix(prefix: string): string {
  const cleaned = prefix
    .split(/[\\/]+/)
    .map((item) => item.trim())
    .filter((item) => item && item !== '.' && item !== '..')
    .join('/');
  return cleaned ? `${cleaned}/` : '';
}

/** 清理 requestId 为安全的对象名片段；清空后回退随机 UUID，避免对象名碰撞或穿越。 */
export function sanitizeObjectRequestId(input: string): string {
  const cleaned = input
    .trim()
    .slice(0, 256)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 128);
  return cleaned || randomUUID();
}
