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

/**
 * 停止原因：用于摘要与 JSON 报告区分三类中断。
 *
 * - `max-items`：至少一个书架触顶 `SYNC_MAX_ITEMS`。**其余书架仍会执行**——
 *   配额按书架独立，不是整轮预算；没有顺延机制，因此不得声称「下一轮继续」。
 * - `time-budget`：整轮时间预算用尽，剩余书架不再开始。
 * - `partial-read`：某书架未走到自然结束（分页失败 / 响应畸形 / 页数上限）。
 *   它比 `max-items` 更严重：配置上限知道自己漏了什么，截断则不知道。
 *
 * 对齐 Audiovisual-Transporter 的 `capped` / `truncated` 双标志语义。
 */
export type StopReason = 'max-items' | 'time-budget' | 'partial-read' | null;

/** 多个停止原因并存时取更严重的那个：截断 > 时间 > 配额。 */
export function mergeStopReason(current: StopReason, next: StopReason): StopReason {
  const rank: Record<NonNullable<StopReason>, number> = {
    'partial-read': 3,
    'time-budget': 2,
    'max-items': 1,
  };
  if (next == null) return current;
  if (current == null) return next;
  return rank[next] > rank[current] ? next : current;
}
