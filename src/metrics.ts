/**
 * 运行时观测 —— 阶段耗时、请求等待与条目耗时分布。
 *
 * 只服务诊断，**不参与任何业务判断**：删掉本模块不应改变任何写入结果。
 * 之所以用模块级累加器而不是依赖注入：调用点在 8 处客户端与主链路内外，
 * 改签名会波及全部请求路径；这里的代价是「同一进程内多次运行需要 reset」，
 * 由 `runNeodbToBangumi` 在遍历开始前显式调用 `resetMetrics()` 解决。
 */

/** 阶段划分互不重叠：shelf = 书架分页等待，其余为条目内三段 IO。 */
export type StageName = 'shelf' | 'match' | 'read' | 'write' | 'episode';

export type HostName = 'bangumi' | 'neodb';

export type DurationStats = {
  count: number;
  totalMs: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
};

export type RunMetricsSnapshot = {
  wallMs: number;
  sleeps: Record<HostName, number>;
  sleepMs: Record<HostName, number>;
  stages: Record<StageName, DurationStats>;
  items: DurationStats;
};

const STAGE_NAMES: readonly StageName[] = [
  'shelf',
  'match',
  'read',
  'write',
  'episode',
];

const HOST_NAMES: readonly HostName[] = ['bangumi', 'neodb'];

/** 最近秩分位数（nearest-rank）：空数组返回 0，单元素返回自身。 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

function summarize(values: readonly number[]): DurationStats {
  if (values.length === 0) {
    return { count: 0, totalMs: 0, p50Ms: 0, p90Ms: 0, maxMs: 0 };
  }
  let total = 0;
  let max = 0;
  for (const value of values) {
    total += value;
    if (value > max) max = value;
  }
  return {
    count: values.length,
    totalMs: Math.round(total),
    p50Ms: Math.round(percentile(values, 0.5)),
    p90Ms: Math.round(percentile(values, 0.9)),
    maxMs: Math.round(max),
  };
}

const stageSamples = new Map<StageName, number[]>();
const itemSamples: number[] = [];
const sleepTotals: Record<HostName, number> = { bangumi: 0, neodb: 0 };
const sleepCounts: Record<HostName, number> = { bangumi: 0, neodb: 0 };
let startedAt = performance.now();

/** 清空全部累加器；每次运行开始时调用，避免同进程多轮互相污染。 */
export function resetMetrics(): void {
  stageSamples.clear();
  itemSamples.length = 0;
  for (const host of HOST_NAMES) {
    sleepTotals[host] = 0;
    sleepCounts[host] = 0;
  }
  startedAt = performance.now();
}

export function addStageTime(stage: StageName, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const bucket = stageSamples.get(stage);
  if (bucket) {
    bucket.push(ms);
  } else {
    stageSamples.set(stage, [ms]);
  }
}

export function addItemTime(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  itemSamples.push(ms);
}

/** 记录一次节流等待。次数与毫秒分开记：delay=0 时仍需计入次数。 */
export function recordSleep(host: HostName, ms: number): void {
  sleepCounts[host] += 1;
  if (Number.isFinite(ms) && ms > 0) {
    sleepTotals[host] += ms;
  }
}

export function sleepCount(host: HostName): number {
  return sleepCounts[host];
}

export function sleepMs(host: HostName): number {
  return sleepTotals[host];
}

export function metricsSnapshot(): RunMetricsSnapshot {
  const stages = {} as Record<StageName, DurationStats>;
  for (const stage of STAGE_NAMES) {
    stages[stage] = summarize(stageSamples.get(stage) ?? []);
  }
  return {
    wallMs: Math.round(performance.now() - startedAt),
    sleeps: { ...sleepCounts },
    sleepMs: {
      bangumi: Math.round(sleepTotals.bangumi),
      neodb: Math.round(sleepTotals.neodb),
    },
    stages,
    items: summarize(itemSamples),
  };
}

/** 计时小工具：把一次异步调用记到某个阶段，异常也照样计时。 */
export async function timeStage<T>(
  stage: StageName,
  run: () => Promise<T>,
): Promise<T> {
  const begin = performance.now();
  try {
    return await run();
  } finally {
    addStageTime(stage, performance.now() - begin);
  }
}
