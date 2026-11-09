/**
 * 写入判定 —— 把「收藏字段差异 / 书籍进度 / 分集进度」三路信号合成一个结论。
 *
 * 为什么独立成纯函数：分集进度曾被挂在收藏 diff 之后，导致「收藏字段完全一致、
 * 但分集还没点满」的条目直接走 `unchanged`，永远到不了拉满分支；而分集又不会
 * 进入增量指纹，失败一次就被永久跳过。判定抽出来之后，这三个信号的关系可以被
 * 离线断言钉住，主链路只负责 IO。
 *
 * 三路信号的性质不同：
 * - `differs` / `bookProgress` 走收藏 upsert（书籍进度随同一请求提交）；
 * - 分集进度是独立请求，写了算一次写入，失败也不该吞掉已经算好的字段更新。
 */

/** 分集进度执行结果。 */
export type ProgressSignal =
  | { kind: 'not-applicable' }
  | { kind: 'unchanged' }
  | { kind: 'written'; added: number }
  | { kind: 'failed'; reason: string; message: string };

export type WriteDecision = {
  outcome: 'written' | 'unchanged' | 'failed';
  /**
   * 审计原因。仅在收藏字段无差异时给值：
   * - `progress`：只有分集进度产生写入；
   * - 失败时为具体原因（如 `episode-read-failed`）。
   */
  reason: string | null;
  /**
   * 是否需要发收藏 upsert。
   *
   * 分集进度不计入：它走独立的分集接口。分集失败时字段更新仍应提交，
   * 因此这里只看 `differs || bookProgress`。
   */
  needsWrite: boolean;
};

/**
 * 判定本轮该记什么。
 *
 * - 分集失败 → `failed`（部分成功也要可见），但 `needsWrite` 仍按字段差异决定；
 * - 任何一路产生写入 → `written`；
 * - 三者都没有 → `unchanged`。
 */
export function decideWriteOutcome(input: {
  differs: boolean;
  /** `ep_status` / `vol_status` 中是否有需要随 upsert 提交的值。 */
  bookProgress: boolean;
  progress: ProgressSignal;
}): WriteDecision {
  const { differs, bookProgress, progress } = input;
  const needsWrite = differs || bookProgress;

  if (progress.kind === 'failed') {
    return { outcome: 'failed', reason: progress.reason, needsWrite };
  }

  if (differs || bookProgress || progress.kind === 'written') {
    return {
      outcome: 'written',
      reason: differs || bookProgress ? null : 'progress',
      needsWrite,
    };
  }

  return { outcome: 'unchanged', reason: null, needsWrite: false };
}
