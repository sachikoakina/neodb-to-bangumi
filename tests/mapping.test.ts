import { describe, expect, it } from 'vitest';
import {
  mapShelfType,
  mergeComment,
  mergeRating,
  neodbCategoryToBangumiSubjectTypes,
  planBangumiPrivate,
} from '../src/rules/neodb-bangumi-mapping';

describe('状态映射', () => {
  it.each([
    ['wishlist', 1],
    ['progress', 3],
    ['complete', 2],
    ['dropped', 5],
  ])('%s → %i', (shelf, type) => {
    expect(mapShelfType(shelf, 0, 'off')).toEqual({ kind: 'map', type });
  });

  it('目标搁置(4)一律跳过', () => {
    expect(mapShelfType('complete', 4, 'off').kind).toBe('skip-on-hold');
    expect(mapShelfType('dropped', 4, 'off').kind).toBe('skip-on-hold');
  });

  it('no-downgrade 保护「看过」不被降级，guard=off 不保护', () => {
    expect(mapShelfType('wishlist', 2, 'no-downgrade').kind).toBe('no-downgrade');
    expect(mapShelfType('progress', 2, 'no-downgrade').kind).toBe('no-downgrade');
    expect(mapShelfType('wishlist', 2, 'off')).toEqual({ kind: 'map', type: 1 });
    expect(mapShelfType('complete', 2, 'no-downgrade')).toEqual({
      kind: 'map',
      type: 2,
    });
  });

  it('未知状态失败在关闭一侧', () => {
    expect(mapShelfType('nonsense', 0, 'off').kind).toBe('unknown-shelf-type');
  });
});

describe('分类映射', () => {
  it('四类支持分类各归其位', () => {
    expect(neodbCategoryToBangumiSubjectTypes('book')).toEqual([1]);
    expect(neodbCategoryToBangumiSubjectTypes('movie')).toEqual([2, 6]);
    expect(neodbCategoryToBangumiSubjectTypes('tv')).toEqual([2, 6]);
    expect(neodbCategoryToBangumiSubjectTypes('music')).toEqual([3]);
    expect(neodbCategoryToBangumiSubjectTypes('game')).toEqual([4]);
  });

  it('podcast/performance 无对应类型', () => {
    expect(neodbCategoryToBangumiSubjectTypes('podcast')).toEqual([]);
    expect(neodbCategoryToBangumiSubjectTypes('performance')).toEqual([]);
  });
});

describe('评分合并（0–10 同分制）', () => {
  it('bangumi_prefer 保留目标非 0 分', () => {
    expect(mergeRating(7, 9, 'bangumi_prefer')).toBe(9);
    expect(mergeRating(7, 0, 'bangumi_prefer')).toBe(7);
    expect(mergeRating(null, 8, 'bangumi_prefer')).toBe(8);
    expect(mergeRating(null, 0, 'bangumi_prefer')).toBe(0);
  });

  it('overwrite 始终用源分', () => {
    expect(mergeRating(6, 8, 'overwrite')).toBe(6);
    expect(mergeRating(null, 8, 'overwrite')).toBe(0);
  });
});

describe('短评合并（纯文本透传）', () => {
  it('bangumi_prefer 保留目标非空短评，只补空缺', () => {
    expect(mergeComment('新的', '旧的', 'bangumi_prefer')).toBe('旧的');
    expect(mergeComment('新的', '', 'bangumi_prefer')).toBe('新的');
    expect(mergeComment('', '旧的', 'bangumi_prefer')).toBe('旧的');
  });

  it('overwrite 始终用源短评，空值清空目标', () => {
    expect(mergeComment('新的', '旧的', 'overwrite')).toBe('新的');
    expect(mergeComment('', '旧的', 'overwrite')).toBe('');
  });
});

describe('隐私：target / source 双模式', () => {
  it('target 模式统一使用配置值', () => {
    expect(
      planBangumiPrivate({ mode: 'target', targetPrivate: true, sourceVisibility: 0 }),
    ).toEqual({ private: true, reason: 'target' });
    expect(
      planBangumiPrivate({
        mode: 'target',
        targetPrivate: false,
        sourceVisibility: 2,
        existingPrivate: true,
      }),
    ).toEqual({ private: false, reason: 'target' });
  });

  it('source 模式：私密 → true，公开/仅关注者 → false', () => {
    expect(
      planBangumiPrivate({ mode: 'source', targetPrivate: false, sourceVisibility: 2 }),
    ).toEqual({ private: true, reason: 'source-private' });
    expect(
      planBangumiPrivate({ mode: 'source', targetPrivate: true, sourceVisibility: 0 }),
    ).toEqual({ private: false, reason: 'source-public' });
    expect(
      planBangumiPrivate({ mode: 'source', targetPrivate: true, sourceVisibility: 1 }),
    ).toEqual({ private: false, reason: 'source-public' });
  });

  it('source 缺失：保留目标现值；无目标才用配置兜底', () => {
    expect(
      planBangumiPrivate({
        mode: 'source',
        targetPrivate: false,
        sourceVisibility: undefined,
        existingPrivate: true,
      }),
    ).toEqual({ private: true, reason: 'source-missing' });
    expect(
      planBangumiPrivate({
        mode: 'source',
        targetPrivate: true,
        sourceVisibility: null,
      }),
    ).toEqual({ private: true, reason: 'source-missing' });
  });
});
