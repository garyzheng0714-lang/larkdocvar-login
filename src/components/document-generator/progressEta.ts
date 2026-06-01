// 批量生成进度的"预计剩余时间"（秒）纯函数。
// 关键意图：没有真实样本（还没处理完任何一条、或耗时为 0）前绝不臆造速率，返回 null，
// UI 据此显示"正在估算…"而非误导性的秒数——旧版写死 0.8 速率魔法值会一开始就给假预估。
export function computeEtaSeconds(processedCount: number, total: number, elapsedSec: number): number | null {
  const rate = processedCount > 0 && elapsedSec > 0 ? processedCount / elapsedSec : 0;
  if (rate <= 0) return null;
  return Math.ceil((total - processedCount) / rate);
}
