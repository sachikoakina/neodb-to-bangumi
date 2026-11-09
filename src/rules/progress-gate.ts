/**
 * 增量跳过判定 —— 让「已同步」与「进度未拉满」成为两件事。
 *
 * 背景：指纹只覆盖收藏字段（状态/评分/短评/可见性），而跳过发生在
 * `processMark` **之前**。结果是一条被记成「已同步」的 complete 影视，
 * 即使之后打开 `SYNC_PROGRESS=1` 也永远不会再被检查分集，只能靠
 * `FULL_SYNC=1` 全量重跑——这正是「越跑越慢」的主要来源。
 *
 * 这里只做纯判定，不读写文件、不发请求，便于离线穷举四象限。
 */
import type { NeodbShelfMark } from '../types';

/**
 * 进度是否**适用于**该条目。
 *
 * 必须显式判定「不适用」：wishlist/dropped、音乐、游戏永远没有可拉满的进度，
 * 若把它们也算作 pending，开启进度后每轮都会重新处理一遍，优化立刻变成退化。
 */
export function progressApplicable(
  mark: NeodbShelfMark,
  progressEnabled: boolean,
): boolean {
  if (!progressEnabled) return false;
  if (mark.shelf_type !== 'complete') return false;
  const category = mark.item.category;
  return category === 'book' || category === 'movie' || category === 'tv';
}

export type ProgressGateInput = {
  mark: NeodbShelfMark;
  /** 本轮已算好的指纹，避免重复 SHA1。 */
  fingerprint: string;
  marks: Record<string, string>;
  progress: Record<string, 'done'>;
  progressEnabled: boolean;
};

/**
 * 是否可以整条跳过。
 *
 * 规则：
 * 1. 指纹不一致 → 必须处理；
 * 2. 进度未启用 → 指纹一致即可跳过（跳过条件退化为只看指纹）；
 * 3. 进度启用但该条不适用 → 指纹一致即可跳过；
 * 4. 进度启用且适用 → 还要该条已标记 `done`。
 */
export function isUpToDate(input: ProgressGateInput): boolean {
  const { mark, fingerprint, marks, progress, progressEnabled } = input;
  const uuid = mark.item.uuid;
  if (marks[uuid] !== fingerprint) return false;
  if (!progressApplicable(mark, progressEnabled)) return true;
  return progress[uuid] === 'done';
}
