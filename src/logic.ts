// 纯函数：阈值解析 / 周期 key / 触发判断，可单元测试

/** 解析 "1,5,10" -> [1,5,10]（去重、过滤非法值、升序） */
export function parseThresholds(
  raw: string | undefined | null,
  fallback: number[] = [1, 5, 10],
): number[] {
  if (!raw || !raw.trim()) return [...fallback];
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const v = Number(part.trim());
    if (Number.isFinite(v) && v > 0) out.add(v);
  }
  const list = [...out].sort((a, b) => a - b);
  return list.length > 0 ? list : [...fallback];
}

/** 账单周期 key，默认按自然月（UTC）： "2026-10" */
export function periodKey(d: Date = new Date()): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}`;
}

/** 本周期内新突破的阈值（已通知的不重复） */
export function newlyCrossed(
  amount: number,
  thresholds: number[],
  alerted: Set<number>,
): number[] {
  return thresholds.filter((t) => amount >= t && !alerted.has(t));
}

/** 是否到了周期推送时间 */
export function shouldReport(
  lastAtMs: number | null,
  nowMs: number,
  intervalHours: number,
): boolean {
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) return false;
  if (lastAtMs === null) return true;
  return nowMs - lastAtMs >= intervalHours * 3600_000;
}

/** 解析推送间隔（小时），非法值回退默认 */
export function parseIntervalHours(
  raw: string | undefined | null,
  fallback = 24,
): number {
  const v = Number((raw ?? "").trim());
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
