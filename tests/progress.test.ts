import { describe, expect, it } from 'vitest';
import { planBookProgress, planEpisodeProgress } from '../src/rules/bangumi-progress';
import type { BangumiEpisode, BangumiEpisodeState } from '../src/types';

function episodes(
  ...specs: Array<[id: number, type: number, sort: number]>
): BangumiEpisode[] {
  return specs.map(([id, type, sort]) => ({ id, type, sort }));
}

function states(
  ...specs: Array<[id: number, type: number]>
): Map<number, BangumiEpisodeState> {
  return new Map(specs.map(([id, type]) => [id, { type }]));
}

describe('分集拉满', () => {
  it('TV：补全部缺失正片，已看过的集不重复发请求', () => {
    const plan = planEpisodeProgress(
      episodes([1, 0, 1], [2, 0, 2], [3, 1, 3], [4, 2, 4]),
      states([1, 2]),
      { isMovie: false, includeSp: false, collected: true },
    );
    expect(plan.target).toEqual([1, 2]);
    expect(plan.missing).toEqual([2]);
  });

  it('TV：includeSp 才纳入 SP，OP/ED 永不纳入', () => {
    const eps = episodes([1, 0, 1], [2, 1, 2], [3, 2, 3]);
    expect(
      planEpisodeProgress(eps, states(), {
        isMovie: false,
        includeSp: false,
        collected: true,
      }).target,
    ).toEqual([1]);
    expect(
      planEpisodeProgress(eps, states(), {
        isMovie: false,
        includeSp: true,
        collected: true,
      }).target,
    ).toEqual([1, 2]);
  });

  it('电影：只补第一个正片；无正片记 no-episodes', () => {
    const plan = planEpisodeProgress(episodes([1, 0, 1], [2, 0, 2]), states(), {
      isMovie: true,
      includeSp: true,
      collected: true,
    });
    expect(plan.target).toEqual([1]);
    expect(plan.missing).toEqual([1]);

    expect(
      planEpisodeProgress([], states(), {
        isMovie: true,
        includeSp: true,
        collected: true,
      }).reason,
    ).toBe('no-episodes');
  });

  it('未收藏时不发任何请求', () => {
    const plan = planEpisodeProgress(episodes([1, 0, 1]), states(), {
      isMovie: false,
      includeSp: false,
      collected: false,
    });
    expect(plan.reason).toBe('not-collected');
    expect(plan.missing).toEqual([]);
  });
});

describe('书籍进度：迁移语义（sourceComplete=true）', () => {
  it('总量已知的维度全部拉满', () => {
    expect(
      planBookProgress(
        { ep_status: 0, vol_status: 0 },
        { eps: 12, volumes: 3 },
        { sourceComplete: true },
      ),
    ).toEqual({ epStatus: 12, volStatus: 3, skip: false });
  });

  it('总量缺失的维度跳过', () => {
    expect(
      planBookProgress(
        { ep_status: 0, vol_status: 0 },
        { eps: 12 },
        { sourceComplete: true },
      ),
    ).toEqual({ epStatus: 12, volStatus: undefined, skip: false });
    expect(
      planBookProgress(
        { ep_status: 0, vol_status: 0 },
        { volumes: 2 },
        { sourceComplete: true },
      ),
    ).toEqual({ epStatus: undefined, volStatus: 2, skip: false });
  });

  it('两维度都无总量 → no-totals（无总量不瞎填）', () => {
    expect(
      planBookProgress({ ep_status: 0, vol_status: 0 }, {}, { sourceComplete: true }),
    ).toEqual({
      skip: true,
      reason: 'no-totals',
    });
  });

  it('已达上限不重写（幂等）', () => {
    expect(
      planBookProgress(
        { ep_status: 12, vol_status: 3 },
        { eps: 12, volumes: 3 },
        { sourceComplete: true },
      ),
    ).toEqual({ skip: true, reason: 'nothing-to-write' });
  });
});

describe('书籍进度：原保守语义（缺省）', () => {
  it('0 视为未知维度不触碰', () => {
    expect(
      planBookProgress({ ep_status: 0, vol_status: 0 }, { eps: 12, volumes: 3 }),
    ).toEqual({
      skip: true,
      reason: 'both-unknown',
    });
  });

  it('只拉满已有进度的维度', () => {
    expect(
      planBookProgress({ ep_status: 5, vol_status: 0 }, { eps: 12, volumes: 3 }),
    ).toEqual({
      epStatus: 12,
      volStatus: undefined,
      skip: false,
    });
  });
});
