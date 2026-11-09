/**
 * 单轮时间预算 —— 把「跑到被 CI 超时杀掉」换成「到点主动收尾」。
 *
 * 为什么需要：`SYNC_MAX_ITEMS` 是条目计数，而条目成本差两个数量级
 * （一条未变化的外链条目 0.65s，一条 50 集全缺的番 34.7s）。只按条数封顶，
 * 轻条目时提前收工、重条目时撞超时；被 SIGKILL 时 state 只在书架级落盘，
 * 一轮白跑。
 *
 * 与条目预算并列而非替代：先到者停。**全量运行不适用**——它有自己的
 * 180 分钟窗口，中途停下反而要重走。
 */

/** 预算是否已用尽。`budgetMs <= 0` 表示不限。 */
export function timeBudgetExhausted(elapsedMs: number, budgetMs: number): boolean {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return false;
  if (!Number.isFinite(elapsedMs)) return false;
  return elapsedMs >= budgetMs;
}

/** 停止原因：用于摘要与 JSON 报告区分「配额」与「时间」。 */
export type StopReason = 'max-items' | 'time-budget' | null;
