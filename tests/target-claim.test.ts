import { describe, expect, it } from 'vitest';
import {
  claimRank,
  shelfStatusRank,
  shouldSkipClaim,
  type TargetClaim,
} from '../src/rules/target-claim';

function claim(partial: Partial<TargetClaim>): TargetClaim {
  return {
    subjectId: 1,
    neodbUuid: 'uuid-a',
    shelfType: 'progress',
    via: 'title',
    ...partial,
  };
}

describe('状态强度', () => {
  it('complete > progress/wishlist > dropped > 未知', () => {
    expect(shelfStatusRank('complete')).toBe(3);
    expect(shelfStatusRank('progress')).toBe(2);
    expect(shelfStatusRank('wishlist')).toBe(2);
    expect(shelfStatusRank('dropped')).toBe(1);
    expect(shelfStatusRank('nonsense')).toBe(0);
  });

  it('排序键由置信度与状态组成', () => {
    expect(claimRank(claim({ via: 'link', shelfType: 'wishlist' }))).toEqual([2, 2]);
    expect(claimRank(claim({ via: 'title', shelfType: 'complete' }))).toEqual([1, 3]);
  });
});

describe('认领裁决', () => {
  it('外链认领强于标题认领，即使状态更弱', () => {
    const incumbent = claim({
      via: 'link',
      shelfType: 'wishlist',
      neodbUuid: 'uuid-a',
    });
    const incoming = claim({
      via: 'title',
      shelfType: 'complete',
      neodbUuid: 'uuid-b',
    });
    expect(shouldSkipClaim(incumbent, incoming)).toBe(true);
  });

  it('同置信度下 complete 强于 progress/wishlist', () => {
    const incumbent = claim({
      via: 'title',
      shelfType: 'complete',
      neodbUuid: 'uuid-a',
    });
    const incoming = claim({
      via: 'title',
      shelfType: 'progress',
      neodbUuid: 'uuid-b',
    });
    expect(shouldSkipClaim(incumbent, incoming)).toBe(true);
    expect(shouldSkipClaim(incoming, incumbent)).toBe(false);
  });

  it('progress 与 wishlist 同档，按 uuid 决胜负', () => {
    const incumbent = claim({
      via: 'title',
      shelfType: 'progress',
      neodbUuid: 'uuid-a',
    });
    const incoming = claim({
      via: 'title',
      shelfType: 'wishlist',
      neodbUuid: 'uuid-b',
    });
    expect(shouldSkipClaim(incumbent, incoming)).toBe(true);
    const smaller = claim({ via: 'title', shelfType: 'wishlist', neodbUuid: 'uuid-0' });
    expect(shouldSkipClaim(incumbent, smaller)).toBe(false);
  });

  it('全部打平时 uuid 较大者被跳过，结果确定', () => {
    const a = claim({ neodbUuid: 'uuid-a' });
    const b = claim({ neodbUuid: 'uuid-b' });
    expect(shouldSkipClaim(a, b)).toBe(true);
    expect(shouldSkipClaim(b, a)).toBe(false);
  });

  it('更强认领可以替换已有认领', () => {
    const weak = claim({ via: 'title', shelfType: 'dropped', neodbUuid: 'uuid-a' });
    const strong = claim({ via: 'link', shelfType: 'dropped', neodbUuid: 'uuid-z' });
    expect(shouldSkipClaim(weak, strong)).toBe(false);
  });
});
