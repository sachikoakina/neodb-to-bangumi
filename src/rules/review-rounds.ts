/**
 * 待核对名单的轮次合并 —— 纯函数。
 *
 * 名单不再按「多少天没出现」淘汰，而按「这一轮是否真的检查过它」判断：
 * 只有本轮完整走完的书架，才允许把「没再上报」记成缺席；没走到的书架整体冻结，
 * 因为「我没看」和「它没了」是两件事。
 *
 * 观察窗：`failed` 多等一轮（多数 failed 是网络抖动，一条超时就让名单多一条，
 * 这份名单就没人读了）；`unresolved` / `skipped` 一轮即入。
 */
import type { RemovedEntry, UnmatchedEntry, UnmatchedKind } from '../sync-report';

/** 进入名单正文前需要连续被上报的轮数。 */
export const MIN_ROUNDS: Readonly<Record<UnmatchedKind, number>> = {
  unresolved: 1,
  skipped: 1,
  failed: 2,
};

/** 连续缺席多少轮才移出名单。 */
export const MISSES_BEFORE_REMOVAL = 2;

export type RoundMergeInput = {
  /** 上一轮的名单（含观察期条目）。 */
  previous: readonly UnmatchedEntry[];
  /** 本轮实际上报的条目。 */
  observed: readonly UnmatchedEntry[];
  /** 本轮完整遍历完毕的书架。 */
  coveredShelves: ReadonlySet<string>;
  /** 本轮因导入成功而移出的 uuid。 */
  importedUuids: ReadonlySet<string>;
  /** 本轮时间戳，写入 `lastSeenAt`。 */
  now: string;
};

export type RoundMergeResult = {
  /** 合并后的全量名单（含仍在观察期的条目）。 */
  entries: UnmatchedEntry[];
  /** 名单正文：已越过观察窗。 */
  live: UnmatchedEntry[];
  /** 本轮首次越过观察窗的条目。 */
  added: UnmatchedEntry[];
  /** 本轮移出名单的条目与原因。 */
  removed: RemovedEntry[];
  /** 仍在观察窗内，尚未进入正文。 */
  observing: UnmatchedEntry[];
  /** 本轮没进入扫描集合、因此冻结的条目（不计缺席）。 */
  frozen: UnmatchedEntry[];
};

function thresholdOf(kind: UnmatchedKind): number {
  return MIN_ROUNDS[kind] ?? 1;
}

export function mergeRounds(input: RoundMergeInput): RoundMergeResult {
  const observed = new Map(input.observed.map((entry) => [entry.neodbUuid, entry]));
  const previousByUuid = new Map(
    input.previous.map((entry) => [entry.neodbUuid, entry]),
  );
  const entries: UnmatchedEntry[] = [];
  const removed: RemovedEntry[] = [];
  const frozen: UnmatchedEntry[] = [];

  for (const before of input.previous) {
    const seen = observed.get(before.neodbUuid);
    if (seen) {
      observed.delete(before.neodbUuid);
    }

    // 导入成功是确定事件：不等两轮，直接移出并留痕。
    if (input.importedUuids.has(before.neodbUuid)) {
      removed.push({ entry: seen ?? before, cause: 'imported' });
      continue;
    }

    if (seen) {
      entries.push({
        ...before,
        ...seen,
        firstSeenAt: before.firstSeenAt,
        lastSeenAt: input.now,
        seenRounds: before.seenRounds + 1,
        missedRounds: 0,
      });
      continue;
    }

    // 本轮没再报到：只有「书架确实走完」才算缺席。
    if (input.coveredShelves.has(before.shelf)) {
      const missedRounds = before.missedRounds + 1;
      if (missedRounds >= MISSES_BEFORE_REMOVAL) {
        removed.push({ entry: before, cause: 'absent' });
        continue;
      }
      entries.push({ ...before, missedRounds });
      continue;
    }

    // 书架没走完：冻结，连续缺席计数清零——「没看」不能累积成「没了」。
    frozen.push(before);
    entries.push({ ...before, missedRounds: 0 });
  }

  for (const fresh of observed.values()) {
    if (input.importedUuids.has(fresh.neodbUuid)) continue;
    entries.push({
      ...fresh,
      firstSeenAt: input.now,
      lastSeenAt: input.now,
      seenRounds: 1,
      missedRounds: 0,
    });
  }

  const live: UnmatchedEntry[] = [];
  const observing: UnmatchedEntry[] = [];
  for (const entry of entries) {
    if (entry.seenRounds >= thresholdOf(entry.kind)) {
      live.push(entry);
    } else {
      observing.push(entry);
    }
  }

  const added = live.filter((entry) => {
    const before = previousByUuid.get(entry.neodbUuid);
    return before == null || before.seenRounds < thresholdOf(before.kind);
  });

  return { entries, live, added, removed, observing, frozen };
}
