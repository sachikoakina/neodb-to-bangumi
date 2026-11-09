/**
 * 未匹配条目的指数退避。
 *
 * 背景：`unresolved` 不写增量指纹（刻意的——补上外链后下一轮就能命中），
 * 代价是这类条目**每一轮**都要重做一遍完整匹配：NeoDB 详情 + 最多 3 次搜索
 * + N 次候选详情。真人影视覆盖率低的账号，这部分是每日固定浪费。
 *
 * 退避只降低重试频率，不改变结论：条目始终留在待核对名单里，
 * 人工补外链的条目**永不退避**（判定在调用侧：有外链就跳过退避）。
 */

/** 1 / 2 / 4 / 7 天阶梯，之后按上限封顶。 */
export const RECHECK_LADDER_DAYS: readonly number[] = [1, 2, 4, 7];

/**
 * 第 `attempts` 次失败后应等多少天再试。
 *
 * - `attempts <= 1` → 1 天；超出阶梯长度 → 用最后一档；
 * - `maxDays <= 0` → 0（关闭退避）；
 * - 阶梯值超过 `maxDays` 时按 `maxDays` 封顶。
 */
export function recheckDelayDays(attempts: number, maxDays: number): number {
  if (!Number.isFinite(maxDays) || maxDays <= 0) return 0;
  const step = Math.max(1, Math.floor(attempts));
  const base = RECHECK_LADDER_DAYS[Math.min(step, RECHECK_LADDER_DAYS.length) - 1]!;
  return Math.min(base, Math.floor(maxDays));
}

/** 计算下次允许复查的时间（ISO 字符串）。 */
export function nextCheckAt(
  attempts: number,
  now: Date,
  maxDays: number,
): string | undefined {
  const days = recheckDelayDays(attempts, maxDays);
  if (days <= 0) return undefined;
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

/**
 * 现在是否应该复查该条目。
 *
 * 保守优先：缺失或非法的时间戳一律视为「该查了」，宁可多打一次请求，
 * 也不能因为脏数据把真实缺口永久跳过。
 */
export function shouldRecheck(
  entry: { attempts?: number; nextCheckAt?: string } | undefined,
  now: Date,
  maxDays: number,
): boolean {
  if (!entry) return true;
  if (!Number.isFinite(maxDays) || maxDays <= 0) return true;
  const next = entry.nextCheckAt;
  if (!next) return true;
  const timestamp = Date.parse(next);
  if (Number.isNaN(timestamp)) return true;
  return timestamp <= now.getTime();
}
