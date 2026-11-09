import { describe, expect, it, vi } from 'vitest';
import { fillEpisodeProgress } from '../src/paths/neodb-to-bangumi';
import type { BangumiEpisode, BangumiEpisodeState, ReadResult } from '../src/types';

function episodesOf(ids: number[], type = 0): BangumiEpisode[] {
  return ids.map((id, index) => ({ id, type, sort: index + 1 }));
}

function found<T>(value: T): ReadResult<T> {
  return { status: 'found', value };
}

const baseDeps = {
  getEpisodes: async (): Promise<ReadResult<BangumiEpisode[]>> =>
    found(episodesOf([1, 2, 3])),
  getStates: async (): Promise<ReadResult<Map<number, BangumiEpisodeState>>> =>
    found(new Map()),
  markWatched: async (): Promise<boolean> => true,
};

describe('分集拉满', () => {
  it('全部缺失 → 写入全部并返回 added 数', async () => {
    const markWatched = vi.fn(async (_subjectId: number, _episodeId: number) => true);
    const result = await fillEpisodeProgress(42, false, false, false, {
      ...baseDeps,
      markWatched,
    });

    expect(result).toEqual({ kind: 'written', added: 3, failed: 0 });
    expect(markWatched).toHaveBeenCalledTimes(3);
  });

  it('已看过的集不发请求 → unchanged', async () => {
    const markWatched = vi.fn(async (_subjectId: number, _episodeId: number) => true);
    const states = new Map<number, BangumiEpisodeState>([
      [1, { type: 2 }],
      [2, { type: 2 }],
      [3, { type: 2 }],
    ]);
    const result = await fillEpisodeProgress(42, false, false, false, {
      ...baseDeps,
      getStates: async () => found(states),
      markWatched,
    });

    expect(result).toEqual({ kind: 'unchanged' });
    expect(markWatched).not.toHaveBeenCalled();
  });

  it('单集写入失败 → 立即短路，不再打剩余集（已成功的集不回滚）', async () => {
    const markWatched = vi.fn(async (_subjectId: number, episodeId: number) => {
      return episodeId !== 2;
    });
    const result = await fillEpisodeProgress(42, false, false, false, {
      ...baseDeps,
      markWatched,
    });

    // 行为变更说明：旧实现失败后仍会打完 3 集，白付 (n−k)·650ms；
    // 现在首次失败即停，下一轮 missing 只剩失败集，天然重试。
    expect(result).toEqual({
      kind: 'failed',
      reason: 'episode-write-failed',
      message: '1/3 集写入失败（首次失败即停止，剩余 1 集未尝试）',
    });
    expect(markWatched).toHaveBeenCalledTimes(2);
  });

  it('分集列表读取失败 → failed，不伪装成无分集', async () => {
    const result = await fillEpisodeProgress(42, false, false, false, {
      ...baseDeps,
      getEpisodes: async () => ({
        status: 'error',
        scope: 'item',
        message: 'episodes 42 returned 500',
      }),
    });

    expect(result).toEqual({
      kind: 'failed',
      reason: 'episodes-read-failed',
      message: 'episodes 42 returned 500',
    });
  });

  it('分集状态读取失败 → failed', async () => {
    const result = await fillEpisodeProgress(42, false, false, false, {
      ...baseDeps,
      getStates: async () => ({
        status: 'error',
        scope: 'item',
        message: 'episode states 42 returned 502',
      }),
    });

    expect(result).toEqual({
      kind: 'failed',
      reason: 'episode-states-read-failed',
      message: 'episode states 42 returned 502',
    });
  });

  it('认证失败 → 抛出以中止整轮，而不是记单条失败', async () => {
    await expect(
      fillEpisodeProgress(42, false, false, false, {
        ...baseDeps,
        getEpisodes: async () => ({
          status: 'error',
          scope: 'auth',
          message: '401 Unauthorized',
        }),
      }),
    ).rejects.toThrow('401 Unauthorized');
  });

  it('没有正片 → not-applicable，不写入', async () => {
    const markWatched = vi.fn(async (_subjectId: number, _episodeId: number) => true);
    const result = await fillEpisodeProgress(42, false, false, false, {
      ...baseDeps,
      getEpisodes: async () => found(episodesOf([7], 1)),
      markWatched,
    });

    expect(result).toEqual({ kind: 'not-applicable', reason: 'no-episodes' });
    expect(markWatched).not.toHaveBeenCalled();
  });

  it('电影只补第一个正片集', async () => {
    const markWatched = vi.fn(async (_subjectId: number, _episodeId: number) => true);
    const result = await fillEpisodeProgress(42, true, false, false, {
      ...baseDeps,
      markWatched,
    });

    expect(result).toEqual({ kind: 'written', added: 1, failed: 0 });
    expect(markWatched).toHaveBeenCalledTimes(1);
    expect(markWatched.mock.calls[0]?.[1]).toBe(1);
  });
});

describe('分集单条上限', () => {
  it('截断时返回 partial 与剩余集数，只为截断内的集发请求', async () => {
    const markWatched = vi.fn(async (_subjectId: number, _episodeId: number) => true);
    const result = await fillEpisodeProgress(
      42,
      false,
      false,
      false,
      { ...baseDeps, markWatched },
      { maxEpisodes: 2 },
    );

    expect(result).toEqual({
      kind: 'written',
      added: 2,
      failed: 0,
      partial: true,
      remaining: 1,
    });
    expect(markWatched).toHaveBeenCalledTimes(2);
  });

  it('未截断时不出现 partial / remaining 键（保持既有断言语义）', async () => {
    const result = await fillEpisodeProgress(42, false, false, false, { ...baseDeps });
    expect(result).toEqual({ kind: 'written', added: 3, failed: 0 });
    expect('partial' in result).toBe(false);
  });

  it('上限大于缺口时视为未截断', async () => {
    const result = await fillEpisodeProgress(
      42,
      false,
      false,
      false,
      { ...baseDeps },
      { maxEpisodes: 10 },
    );
    expect(result).toEqual({ kind: 'written', added: 3, failed: 0 });
  });

  it('上限为 0 或负数一律表示不限', async () => {
    const zero = await fillEpisodeProgress(
      42,
      false,
      false,
      false,
      { ...baseDeps },
      { maxEpisodes: 0 },
    );
    expect(zero).toEqual({ kind: 'written', added: 3, failed: 0 });

    const negative = await fillEpisodeProgress(
      42,
      false,
      false,
      false,
      { ...baseDeps },
      { maxEpisodes: -5 },
    );
    expect(negative).toEqual({ kind: 'written', added: 3, failed: 0 });
  });

  it('上限为 1 时只写第一集，剩余数正确', async () => {
    const markWatched = vi.fn(async (_subjectId: number, _episodeId: number) => true);
    const result = await fillEpisodeProgress(
      42,
      false,
      false,
      false,
      { ...baseDeps, markWatched },
      { maxEpisodes: 1 },
    );

    expect(result).toEqual({
      kind: 'written',
      added: 1,
      failed: 0,
      partial: true,
      remaining: 2,
    });
    expect(markWatched.mock.calls[0]?.[1]).toBe(1);
  });
});
