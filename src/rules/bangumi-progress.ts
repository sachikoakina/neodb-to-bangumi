/**
 * Bangumi 进度拉满的纯规划逻辑。
 *
 * 收藏状态（type=2）不等于分集格子：条目可以标「看过」但仍有半集没点。
 * 因此分集层面始终以**分集 `type=2`** 判断，绝不用 `ep_status`；
 * `ep_status` / `vol_status` 只用于书籍维度。
 */
import type {
  BangumiCollection,
  BangumiEpisode,
  BangumiEpisodeState,
  BangumiSubject,
} from '../types';

export type EpisodeProgressPlan = {
  target: number[];
  missing: number[];
  reason?: 'no-episodes' | 'not-collected';
};

/**
 * 分集拉满计划。
 *
 * - 电影：只补第一个正片集（ movies 只有一「集」正片可点）；
 * - TV/动画/真人：补全部正片；`includeSp` 时纳入 SP；电影永不处理 SP；
 * - `missing` 里是尚需发 PUT 的集 id；已是 `type=2` 的集不在其中，保证幂等
 *   （第二轮运行 missing 为空 → 零请求，`updated_at` 不变）。
 */
export function planEpisodeProgress(
  episodes: BangumiEpisode[],
  states: Map<number, BangumiEpisodeState>,
  options: {
    isMovie: boolean;
    includeSp: boolean;
    /** 是否把 OP/ED（type 2/3）也纳入拉满；默认关闭。 */
    includeOpEd?: boolean;
    collected: boolean;
  },
): EpisodeProgressPlan {
  if (!options.collected) {
    return { target: [], missing: [], reason: 'not-collected' };
  }

  const main = episodes
    .filter((episode) => episode.type === 0)
    .sort((a, b) => a.sort - b.sort || a.id - b.id);
  const sp = options.includeSp
    ? episodes
        .filter((episode) => episode.type === 1)
        .sort((a, b) => a.sort - b.sort || a.id - b.id)
    : [];
  // OP/ED 不是剧情进度：看完本篇不代表看过主题曲，因此默认不纳入，且电影永不纳入。
  const themes = options.includeOpEd
    ? episodes
        .filter((episode) => episode.type === 2 || episode.type === 3)
        .sort((a, b) => a.sort - b.sort || a.id - b.id)
    : [];
  const targetEpisodes = options.isMovie
    ? main.slice(0, 1)
    : [...main, ...sp, ...themes];
  const target = targetEpisodes.map((episode) => episode.id);
  const missing = target.filter((id) => states.get(id)?.type !== 2);

  return {
    target,
    missing,
    reason: target.length === 0 ? 'no-episodes' : undefined,
  };
}

export type BookProgressPlan = {
  epStatus?: number;
  volStatus?: number;
  skip: boolean;
  reason?: 'no-totals' | 'nothing-to-write';
};

/**
 * 书籍进度拉满计划（写入随收藏 upsert 同一请求提交）。
 *
 * 语义只有一种：**源端已确认 complete，因此要拉满**。只要 `subject.eps` /
 * `subject.volumes` 总量已知，就把对应维度推到上限；总量缺失的维度跳过
 * （无总量不瞎填）；已达上限的维度不重写，保证幂等。
 *
 * 目标端现有进度为 0 不算「未知维度」——那是源端状态，不是目标端猜测的依据。
 */
export function planBookProgress(
  existing: Pick<BangumiCollection, 'ep_status' | 'vol_status'>,
  subject: Pick<BangumiSubject, 'eps' | 'volumes'>,
): BookProgressPlan {
  const epTotal = positiveOrUndefined(subject.eps);
  const volTotal = positiveOrUndefined(subject.volumes);
  if (epTotal == null && volTotal == null) {
    return { skip: true, reason: 'no-totals' };
  }

  const epStatus = reached(existing.ep_status, epTotal) ? undefined : epTotal;
  const volStatus = reached(existing.vol_status, volTotal) ? undefined : volTotal;
  if (epStatus == null && volStatus == null) {
    return { skip: true, reason: 'nothing-to-write' };
  }

  return { epStatus, volStatus, skip: false };
}

/** 总量只在正数时算「已知」，0 与缺失等价。 */
function positiveOrUndefined(total: number | undefined): number | undefined {
  return total != null && total > 0 ? total : undefined;
}

/** 目标已达上限（或该维度没有总量）时不重写。 */
function reached(current: number | undefined, total: number | undefined): boolean {
  if (total == null) return true;
  return (current ?? 0) >= total;
}
