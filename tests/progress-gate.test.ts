import { describe, expect, it } from 'vitest';
import { isUpToDate, progressApplicable } from '../src/rules/progress-gate';
import type { NeodbShelfMark } from '../src/types';

function mark(shelf: string, category: string, uuid = 'uuid-1'): NeodbShelfMark {
  return {
    shelf_type: shelf,
    item: {
      id: 'item-1',
      type: 'catalog',
      uuid,
      url: 'https://neodb.social/item/1',
      api_url: 'https://neodb.social/api/catalog/item/1',
      category,
      parent_uuid: null,
      display_title: 'Title',
      title: 'Title',
      brief: '',
      description: '',
      cover_image_url: '',
      rating: 0,
      rating_count: 0,
      external_resources: [],
    },
  };
}

describe('进度适用性', () => {
  it('complete 的 book / movie / tv 适用', () => {
    for (const category of ['book', 'movie', 'tv']) {
      expect(progressApplicable(mark('complete', category), true)).toBe(true);
    }
  });

  it('音乐 / 游戏永远不适用（无进度字段）', () => {
    expect(progressApplicable(mark('complete', 'music'), true)).toBe(false);
    expect(progressApplicable(mark('complete', 'game'), true)).toBe(false);
  });

  it('非 complete 不适用', () => {
    expect(progressApplicable(mark('wishlist', 'tv'), true)).toBe(false);
    expect(progressApplicable(mark('progress', 'tv'), true)).toBe(false);
    expect(progressApplicable(mark('dropped', 'tv'), true)).toBe(false);
  });

  it('进度总开关关闭时一律不适用', () => {
    expect(progressApplicable(mark('complete', 'tv'), false)).toBe(false);
  });
});

describe('增量跳过判定', () => {
  const fingerprinted = { 'uuid-1': 'h1' };

  it('指纹不一致 → 必须处理', () => {
    expect(
      isUpToDate({
        mark: mark('complete', 'tv'),
        fingerprint: 'h2',
        marks: fingerprinted,
        progress: { 'uuid-1': 'done' },
        progressEnabled: true,
      }),
    ).toBe(false);
  });

  it('指纹一致且进度未启用 → 跳过（与旧行为一致）', () => {
    expect(
      isUpToDate({
        mark: mark('complete', 'tv'),
        fingerprint: 'h1',
        marks: fingerprinted,
        progress: {},
        progressEnabled: false,
      }),
    ).toBe(true);
  });

  it('指纹一致、进度启用、适用但未 done → 不跳过（补分集）', () => {
    expect(
      isUpToDate({
        mark: mark('complete', 'tv'),
        fingerprint: 'h1',
        marks: fingerprinted,
        progress: {},
        progressEnabled: true,
      }),
    ).toBe(false);
  });

  it('指纹一致、进度启用、已 done → 跳过', () => {
    expect(
      isUpToDate({
        mark: mark('complete', 'tv'),
        fingerprint: 'h1',
        marks: fingerprinted,
        progress: { 'uuid-1': 'done' },
        progressEnabled: true,
      }),
    ).toBe(true);
  });

  it('进度启用但不适用（音乐）→ 不因进度而反复重跑', () => {
    expect(
      isUpToDate({
        mark: mark('complete', 'music'),
        fingerprint: 'h1',
        marks: fingerprinted,
        progress: {},
        progressEnabled: true,
      }),
    ).toBe(true);
  });

  it('未记录过指纹的条目 → 不跳过', () => {
    expect(
      isUpToDate({
        mark: mark('complete', 'tv', 'uuid-new'),
        fingerprint: 'h1',
        marks: fingerprinted,
        progress: {},
        progressEnabled: true,
      }),
    ).toBe(false);
  });
});
