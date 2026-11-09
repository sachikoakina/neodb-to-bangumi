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

  it('部分集写入失败 → failed，已成功的集不回滚', async () => {
    const markWatched = vi.fn(async (_subjectId: number, episodeId: number) => {
      return episodeId !== 2;
    });
    const result = await fillEpisodeProgress(42, false, false, false, {
      ...baseDeps,
      markWatched,
    });

    expect(result).toEqual({
      kind: 'failed',
      reason: 'episode-write-failed',
      message: '1/3 集写入失败',
    });
    expect(markWatched).toHaveBeenCalledTimes(3);
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
